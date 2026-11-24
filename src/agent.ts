import type { Config, Mode } from "./config";
import { apiFor, contextWindow, type Gateway } from "./gateway";
import { COMPACT_PROMPT, systemPrompt } from "./prompt";
import { newId, saveSession, type SessionFile } from "./store";
import { toolByName, TOOLS, type Diff, type ToolKind, type ToolResult } from "./tools";
import { emptyUsage, type Llm, type Msg, type Part } from "./types";

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type Decision = "once" | "always" | "deny";

export interface ToolCallInfo {
  id: string;
  name: string;
  input: any;
  title: string;
  kind: ToolKind;
  paths: string[];
}

/** What a front end (terminal or ACP) shows while the agent works. */
export interface AgentUI {
  text(delta: string): void;
  thinking(delta: string): void;
  /** a new model call is starting */
  step?(): void;
  toolStart(call: ToolCallInfo): void;
  toolEnd(call: ToolCallInfo, result: ToolResult): void;
  ask(call: ToolCallInfo, diff: Diff | null): Promise<Decision>;
  notice?(message: string, level: "info" | "warn" | "error"): void;
  /** after each model call: tokens and context use */
  usage?(s: Session): void;
}

const MAX_STEPS = 200;

export interface NewSession {
  cwd: string;
  model: string;
  mode?: Mode;
  effort?: string;
  id?: string;
}

export class Session {
  readonly readFiles = new Map<string, number>();
  readonly allowAlways = new Set<string>();
  private running: AbortController | null = null;
  private system: string;

  constructor(
    public data: SessionFile,
    private gateway: Pick<Gateway, "llm">,
    private cfg: Config = {},
  ) {
    this.system = systemPrompt(data.cwd);
  }

  static create(gateway: Pick<Gateway, "llm">, cfg: Config, o: NewSession): Session {
    const now = Date.now();
    return new Session(
      { version: 1, id: o.id ?? newId(), cwd: o.cwd, title: null, model: o.model, mode: o.mode ?? cfg.mode ?? "ask", effort: o.effort ?? cfg.effort ?? "auto", created: now, updated: now, usage: emptyUsage(), contextUsed: 0, messages: [] },
      gateway,
      cfg,
    );
  }

  get id() {
    return this.data.id;
  }
  get busy() {
    return !!this.running;
  }
  get contextSize() {
    return contextWindow(this.data.model, this.cfg);
  }

  setModel(model: string) {
    this.data.model = model;
    this.save();
  }
  setMode(mode: Mode) {
    this.data.mode = mode;
    this.save();
  }
  setEffort(effort: string) {
    this.data.effort = effort;
    this.save();
  }

  save() {
    this.data.updated = Date.now();
    saveSession(this.data);
  }

  cancel() {
    this.running?.abort();
  }

  private llm(): Llm {
    return this.gateway.llm(this.data.model);
  }

  /** Run one prompt to the end: model, tools, model again… until the model stops calling tools. */
  async prompt(parts: Part[], ui: AgentUI): Promise<StopReason> {
    if (this.running) throw new Error("a prompt is already running in this session");
    const ac = new AbortController();
    this.running = ac;
    try {
      const text = parts.filter((p) => p.type === "text").map((p: any) => p.text).join(" ").trim();
      if (!this.data.title && text) this.data.title = text.replace(/\s+/g, " ").slice(0, 80);
      if (this.data.contextUsed > this.contextSize * 0.8 && this.data.messages.length >= 2) await this.compact(ui, ac.signal);
      this.data.messages.push({ role: "user", parts, ts: Date.now() });
      this.save();
      return await this.loop(ui, ac.signal);
    } finally {
      this.running = null;
      this.save();
    }
  }

  private async loop(ui: AgentUI, signal: AbortSignal): Promise<StopReason> {
    const tools = TOOLS.map((t) => t.spec);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return "cancelled";
      // Nearly full mid-turn: summarize and carry on.
      if (this.data.contextUsed > this.contextSize * 0.92) await this.compact(ui, signal, true);
      ui.step?.();
      let streamed = "";
      const model = this.data.model;
      let turn;
      try {
        turn = await this.llm().turn(
          { model, system: this.system, messages: this.data.messages, tools, effort: this.data.effort, sessionId: this.id, signal },
          {
            text: (d) => {
              streamed += d;
              ui.text(d);
            },
            thinking: (d) => ui.thinking(d),
          },
        );
      } catch (err) {
        if (signal.aborted) {
          if (streamed) this.data.messages.push({ role: "assistant", parts: [{ type: "text", text: streamed + "\n\n[interrupted]" }], ts: Date.now() });
          return "cancelled";
        }
        throw new Error(errorText(err));
      }
      const u = this.data.usage;
      u.input += turn.usage.input;
      u.output += turn.usage.output;
      u.cacheRead += turn.usage.cacheRead;
      u.cacheWrite += turn.usage.cacheWrite;
      this.data.contextUsed = turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite + turn.usage.output;
      const msg: Msg = { role: "assistant", parts: turn.parts, ts: Date.now() };
      if (turn.native != null) msg.native = { api: apiFor(model), model, data: turn.native };
      this.data.messages.push(msg);
      this.save();
      ui.usage?.(this);

      if (turn.stop === "refusal") {
        ui.notice?.("The model declined to continue with this request.", "warn");
        return "refusal";
      }
      const calls = turn.parts.filter((p) => p.type === "tool_call") as Extract<Part, { type: "tool_call" }>[];
      if (!calls.length) return turn.stop === "max_tokens" ? "max_tokens" : "end_turn";

      const results: Part[] = [];
      for (const c of calls) {
        const r = await this.runTool(c, ui, signal, turn.stop === "max_tokens");
        results.push({ type: "tool_result", id: c.id, name: c.name, output: r.output, ...(r.isError ? { isError: true } : {}) });
      }
      this.data.messages.push({ role: "user", parts: results, ts: Date.now() });
      this.save();
      if (signal.aborted) return "cancelled";
    }
    return "max_turn_requests";
  }

  private async runTool(c: Extract<Part, { type: "tool_call" }>, ui: AgentUI, signal: AbortSignal, cutOff: boolean): Promise<ToolResult> {
    const tool = toolByName.get(c.name);
    const input: any = c.input && typeof c.input === "object" ? c.input : {};
    let title = c.name;
    let paths: string[] = [];
    try {
      if (tool) {
        title = tool.title(input, this.data.cwd);
        paths = tool.paths(input, this.data.cwd);
      }
    } catch {}
    const info: ToolCallInfo = { id: c.id, name: c.name, input, title, kind: tool?.kind ?? "other", paths };
    ui.toolStart(info);
    const done = (r: ToolResult) => {
      ui.toolEnd(info, r);
      return r;
    };
    if (signal.aborted) return done({ output: "Cancelled by the person before it ran.", isError: true });
    if (!tool) return done({ output: `There is no tool called ${c.name}. Available: ${TOOLS.map((t) => t.spec.name).join(", ")}.`, isError: true });
    if (cutOff) return done({ output: "Your answer was cut off (output token limit), so this call didn't run. Do the work in smaller steps.", isError: true });
    if ("_raw" in input) return done({ output: "The arguments were not valid JSON, so this call didn't run.", isError: true });
    const ctx = { cwd: this.data.cwd, signal, readFiles: this.readFiles };
    if (tool.asks(this.data.mode) && !this.allowAlways.has(c.name)) {
      let preview: Diff | null = null;
      try {
        preview = tool.preview?.(input, ctx) ?? null;
      } catch {}
      const d = await ui.ask(info, preview);
      if (signal.aborted) return done({ output: "Cancelled by the person.", isError: true });
      if (d === "deny") return done({ output: "The person declined this call. Don't retry it as is; ask them what they want or take another approach.", isError: true });
      if (d === "always") this.allowAlways.add(c.name);
    }
    try {
      return done(await tool.run(input, ctx));
    } catch (err) {
      return done({ output: `Error: ${(err as Error)?.message ?? err}`, isError: true });
    }
  }

  /** Replace the history with a summary written by the model. */
  async compact(ui: AgentUI, signal?: AbortSignal, midTurn = false): Promise<void> {
    if (this.data.messages.length < 2) return;
    ui.notice?.("Compacting the conversation…", "info");
    const turn = await this.llm().turn(
      {
        model: this.data.model,
        system: this.system,
        messages: [...this.data.messages, { role: "user", parts: [{ type: "text", text: COMPACT_PROMPT }] }],
        tools: TOOLS.map((t) => t.spec),
        effort: "low",
        sessionId: this.id,
        signal,
      },
      { text: () => {}, thinking: () => {} },
    );
    const summary = turn.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
    if (!summary) throw new Error("compaction returned no summary");
    const note = `This session was compacted. Summary of the conversation so far:\n\n${summary}${midTurn ? "\n\nContinue the task from where you left off." : ""}`;
    this.data.messages = [{ role: "user", parts: [{ type: "text", text: note }], ts: Date.now() }];
    if (!midTurn) this.data.messages.push({ role: "assistant", parts: [{ type: "text", text: "Got it. I'll continue from this summary." }], ts: Date.now() });
    this.data.contextUsed = Math.ceil(note.length / 4);
    this.readFiles.clear();
    this.save();
    ui.notice?.("Conversation compacted.", "info");
  }
}

export function errorText(err: unknown): string {
  const e = err as any;
  const status = e?.status ?? e?.response?.status;
  let msg = e?.error?.error?.message ?? e?.error?.message ?? e?.message ?? String(err);
  if (typeof msg !== "string") msg = JSON.stringify(msg);
  msg = msg.replace(/^\d{3}\s+/, "");
  if (status === 401) return `The gateway rejected the key (401). Run \`opengate login\` again. ${msg}`;
  if (status === 429) return `Rate limited (429): ${msg}`;
  return status ? `${status}: ${msg}` : msg;
}
