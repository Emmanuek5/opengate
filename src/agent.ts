import type { Config, Mode } from "./config";
import { apiFor, contextWindow, type Gateway } from "./gateway";
import { COMPACT_PROMPT, systemPrompt } from "./prompt";
import { autoCompactFor, isContextOverflow, learnWindow, parseContextLimit } from "./compaction";
import { newId, saveSession, type SessionFile } from "./store";
import { getPermissionPolicies, getPromptSections, getSessionHooks, getToolProviders, type AgentEvent, type PermissionVerdict } from "./ext";
import { TOOLS, type Diff, type Tool, type ToolCtx, type ToolKind, type ToolResult } from "./tools";
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
  /** why the person is being asked (e.g. the safety guard's reason), if any */
  reason?: string;
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
  /** anything else worth showing (subagents, memory, skills, MCP); see AgentEvent in ext.ts */
  event?(e: AgentEvent): void;
}

const MAX_STEPS = 200;

export interface NewSession {
  cwd: string;
  model: string;
  mode?: Mode;
  effort?: string;
  id?: string;
  /** set for subagents: the session that started this one */
  parentId?: string;
  /** only offer these tools (by name); default: all */
  allowedTools?: string[];
  /** text appended to the system prompt (e.g. a subagent's instructions) */
  extraSystem?: string;
}

export class Session {
  readonly readFiles = new Map<string, number>();
  readonly allowAlways = new Set<string>();
  /** state that features keep for this session (MCP clients, …); never saved */
  readonly runtime = new Map<string, unknown>();
  private running: AbortController | null = null;
  private system: string;
  private started: Promise<void> | null = null;
  /** system prompt and tools are built once and kept, so the cached prefix stays identical */
  private promptReady = false;
  /** messages the person sent while a turn was running, delivered at the next step */
  private steering: Part[][] = [];
  private idleWaiters: (() => void)[] = [];
  /** the tools offered in the current prompt */
  private toolset: Tool[] = TOOLS;
  /** only offer these tools (by name); undefined offers all. Not saved. */
  allowedTools?: string[];
  /** appended to the system prompt. Not saved. */
  extraSystem?: string;

  constructor(
    public data: SessionFile,
    public readonly gateway: Pick<Gateway, "llm"> & Partial<Pick<Gateway, "models" | "url">>,
    public readonly cfg: Config = {},
  ) {
    this.system = systemPrompt(data.cwd, new Date(data.created));
  }

  /**
   * Rebuild the system prompt and tool list before the next model call. Changing either one
   * invalidates the whole prompt cache, so this only happens when something really changed
   * (an MCP server's tools, /compact, an explicit reload), never on every message.
   */
  invalidatePrompt(): void {
    this.promptReady = false;
  }

  static create(gateway: Session["gateway"], cfg: Config, o: NewSession): Session {
    const now = Date.now();
    const s = new Session(
      {
        version: 1,
        id: o.id ?? newId(),
        cwd: o.cwd,
        title: null,
        model: o.model,
        mode: o.mode ?? cfg.mode ?? "ask",
        effort: o.effort ?? cfg.effort ?? "auto",
        created: now,
        updated: now,
        usage: emptyUsage(),
        contextUsed: 0,
        messages: [],
        ...(o.parentId ? { parentId: o.parentId } : {}),
      },
      gateway,
      cfg,
    );
    if (o.allowedTools) s.allowedTools = [...o.allowedTools];
    if (o.extraSystem) s.extraSystem = o.extraSystem;
    return s;
  }

  /** Run the session hooks once (connect MCP servers, …). Called before the first prompt. */
  start(): Promise<void> {
    this.started ??= (async () => {
      for (const h of getSessionHooks()) {
        try {
          await h.start?.(this);
        } catch (e) {
          console.error(`opengate: ${h.name} failed to start: ${(e as Error)?.message ?? e}`);
        }
      }
    })();
    return this.started;
  }

  async dispose(): Promise<void> {
    this.cancel();
    for (const h of getSessionHooks()) {
      try {
        await h.dispose?.(this);
      } catch {}
    }
  }

  /** Built-in tools plus every provider's, by name (later duplicates are dropped). */
  async tools(): Promise<Tool[]> {
    const all = [...TOOLS];
    for (const p of getToolProviders()) {
      try {
        all.push(...(await p.tools(this)));
      } catch (e) {
        console.error(`opengate: tools from ${p.name} failed: ${(e as Error)?.message ?? e}`);
      }
    }
    const seen = new Set<string>();
    const allowed = this.allowedTools ? new Set(this.allowedTools) : null;
    return all.filter((t) => !seen.has(t.spec.name) && seen.add(t.spec.name) && (!allowed || allowed.has(t.spec.name)));
  }

  /** The system prompt: built-in instructions plus every prompt section. */
  async systemPrompt(): Promise<string> {
    // The session's own start date, not today's, so a session running past midnight keeps its cache.
    let s = systemPrompt(this.data.cwd, new Date(this.data.created));
    for (const sec of getPromptSections()) {
      try {
        const text = await sec.render(this);
        if (text?.trim()) s += `\n\n${text.trim()}`;
      } catch (e) {
        console.error(`opengate: prompt section ${sec.name} failed: ${(e as Error)?.message ?? e}`);
      }
    }
    if (this.extraSystem?.trim()) s += `\n\n${this.extraSystem.trim()}`;
    return s;
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
  /** Where this session compacts: your /auto-compact setting for the model, else 80% of its window. */
  get compactAt() {
    return Math.min(autoCompactFor(this.cfg, this.data.model) ?? Math.round(this.contextSize * 0.8), this.contextSize);
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

  /**
   * Add a message to the running turn ("steering"). The model sees it as soon as its current
   * tool calls finish, or before it would otherwise stop. Returns false when no turn is running
   * (send it as a normal prompt instead).
   */
  steer(parts: Part[]): boolean {
    if (!this.running || !parts.length) return false;
    this.steering.push(parts);
    return true;
  }

  /** Resolves when no turn is running. */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /** Steering messages waiting to be delivered, as parts for the next user message. */
  private takeSteering(ui: AgentUI): Part[] {
    if (!this.steering.length) return [];
    const out: Part[] = [];
    for (const parts of this.steering.splice(0)) {
      const text = parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
      out.push({ type: "text", text: `[The person sent this while you were working; take it into account now:]\n${text}` }, ...parts.filter((p) => p.type !== "text"));
      ui.event?.({ type: "steer", status: "delivered", text });
    }
    return out;
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
      await this.start();
      await this.preparePrompt();
      const text = parts.filter((p) => p.type === "text").map((p: any) => p.text).join(" ").trim();
      if (!this.data.title && text) this.data.title = text.replace(/\s+/g, " ").slice(0, 80);
      if (this.data.contextUsed > this.compactAt && this.data.messages.length >= 2) await this.compact(ui, ac.signal);
      this.data.messages.push({ role: "user", parts, ts: Date.now() });
      this.save();
      return await this.loop(ui, ac.signal);
    } finally {
      this.running = null;
      // Steering that arrived too late for this turn is dropped here; front ends resend it as a prompt.
      this.steering = [];
      this.save();
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  private async preparePrompt(): Promise<void> {
    if (this.promptReady) return;
    this.toolset = await this.tools();
    this.system = await this.systemPrompt();
    this.promptReady = true;
  }

  private async loop(ui: AgentUI, signal: AbortSignal): Promise<StopReason> {
    let overflowRetried = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return "cancelled";
      await this.preparePrompt();
      const tools = this.toolset.map((t) => t.spec);
      // Nearly full mid-turn: summarize and carry on.
      // Mid-turn, allow a little past the point (finishing the step beats summarizing), never near the window's end.
      if (this.data.contextUsed > Math.min(this.compactAt * 1.1, this.contextSize * 0.95)) await this.compact(ui, signal, true);
      ui.step?.();
      let streamed = "";
      const model = this.data.model;
      let turn;
      try {
        turn = await this.llm().turn(
          { model, system: this.system, messages: this.data.messages, tools, effort: this.data.effort, sessionId: this.id, signal, cacheTtl: this.cfg.cacheTtl ?? "1h", labels: this.data.parentId ? { purpose: "subagent", parent: this.data.parentId } : { purpose: "main" } },
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
        const msg = errorText(err);
        // Too long for the model (an unknown window, or a large tool result): remember the
        // limit if the error names it, compact, and try this step again once.
        if (isContextOverflow(msg) && !overflowRetried && this.data.messages.length >= 2) {
          overflowRetried = true;
          const limit = parseContextLimit(msg);
          if (limit) learnWindow(model, limit);
          ui.notice?.(`The conversation is too long for ${model}${limit ? ` (${limit} tokens)` : ""}; compacting and trying again.`, "warn");
          await this.compact(ui, signal, true);
          step--;
          continue;
        }
        throw new Error(msg);
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
      if (!calls.length) {
        // The person said something while the model was finishing: keep going with it.
        const steer = this.takeSteering(ui);
        if (steer.length && !signal.aborted) {
          this.data.messages.push({ role: "user", parts: steer, ts: Date.now() });
          this.save();
          continue;
        }
        return turn.stop === "max_tokens" ? "max_tokens" : "end_turn";
      }

      // Calls run in order, except that neighbouring parallel-safe calls (reads, searches,
      // subagents) run at the same time. Results go back in the order the model asked.
      const results: Part[] = [];
      const byName = new Map(this.toolset.map((t) => [t.spec.name, t]));
      const cutOff = turn.stop === "max_tokens";
      for (let i = 0; i < calls.length; ) {
        let j = i + 1;
        if (byName.get(calls[i].name)?.parallel) while (j < calls.length && byName.get(calls[j].name)?.parallel) j++;
        const batch = calls.slice(i, j);
        const done = await Promise.all(batch.map((c) => this.runTool(c, ui, signal, cutOff)));
        batch.forEach((c, k) => results.push({ type: "tool_result", id: c.id, name: c.name, output: done[k].output, ...(done[k].isError ? { isError: true } : {}) }));
        i = j;
      }
      // Steering goes in the same user message, after the tool results (every API accepts that).
      this.data.messages.push({ role: "user", parts: [...results, ...(signal.aborted ? [] : this.takeSteering(ui))], ts: Date.now() });
      this.save();
      if (signal.aborted) return "cancelled";
    }
    return "max_turn_requests";
  }

  private async runTool(c: Extract<Part, { type: "tool_call" }>, ui: AgentUI, signal: AbortSignal, cutOff: boolean): Promise<ToolResult> {
    const tool = this.toolset.find((t) => t.spec.name === c.name);
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
    if (!tool) return done({ output: `There is no tool called ${c.name}. Available: ${this.toolset.map((t) => t.spec.name).join(", ")}.`, isError: true });
    if (cutOff) return done({ output: "Your answer was cut off (output token limit), so this call didn't run. Do the work in smaller steps.", isError: true });
    if ("_raw" in input) return done({ output: "The arguments were not valid JSON, so this call didn't run.", isError: true });
    const ctx: ToolCtx = { cwd: this.data.cwd, signal, readFiles: this.readFiles, session: this, ui, callId: c.id };
    const denied = await this.permit(tool, info, ctx, ui, signal);
    if (denied) return done({ output: denied, isError: true });
    try {
      return done(await tool.run(input, ctx));
    } catch (err) {
      return done({ output: `Error: ${(err as Error)?.message ?? err}`, isError: true });
    }
  }

  /**
   * Whether a call may run. Returns null to run it, or the message the model gets back.
   * Read-only tools always run. Policies' "deny" wins in every mode; see PermissionPolicy.
   */
  private async permit(tool: Tool, info: ToolCallInfo, ctx: ToolCtx, ui: AgentUI, signal: AbortSignal): Promise<string | null> {
    if (!tool.asks("ask")) return null;
    const mode = this.data.mode;
    let diff: Diff | null = null;
    try {
      diff = tool.preview?.(info.input, ctx) ?? null;
    } catch {}
    const verdicts: PermissionVerdict[] = [];
    for (const p of getPermissionPolicies()) {
      try {
        const v = await p.decide({ session: this, call: info, tool, diff, signal, ui });
        if (v) verdicts.push({ by: p.name, ...v });
      } catch (e) {
        verdicts.push({ decision: "ask", reason: `${p.name} failed: ${(e as Error)?.message ?? e}`, by: p.name });
      }
      if (signal.aborted) return "Cancelled by the person.";
    }
    const deny = verdicts.find((v) => v.decision === "deny");
    if (deny) {
      ui.notice?.(`Blocked ${info.title}${deny.reason ? `: ${deny.reason}` : ""}`, "warn");
      return `This call was blocked${deny.by ? ` by ${deny.by}` : ""}${deny.reason ? `: ${deny.reason}` : ""}. Don't retry it; find a safer way or ask the person.`;
    }
    if (this.allowAlways.has(info.name) || mode === "yolo") return null;
    if (mode === "ask" || mode === "edits") {
      if (!tool.asks(mode)) return null;
    } else if (mode === "auto") {
      const asks = verdicts.find((v) => v.decision === "ask");
      if (!asks && verdicts.some((v) => v.decision === "allow")) return null;
      if (asks?.reason) info.reason = asks.reason;
    }
    const d = await ui.ask(info, diff);
    if (signal.aborted) return "Cancelled by the person.";
    if (d === "deny") return "The person declined this call. Don't retry it as is; ask them what they want or take another approach.";
    if (d === "always") this.allowAlways.add(info.name);
    return null;
  }

  /** Replace the history with a summary written by the model. */
  async compact(ui: AgentUI, signal?: AbortSignal, midTurn = false): Promise<void> {
    if (this.data.messages.length < 2) return;
    ui.notice?.("Compacting the conversation…", "info");
    // If even the summary request is too long, summarize the most recent part: halve the history
    // (starting at a clean user message) until it fits.
    let history = this.data.messages;
    let turn;
    for (let attempt = 0; ; attempt++) {
      try {
        turn = await this.llm().turn(
          {
            model: this.data.model,
            system: this.system,
            messages: [...history, { role: "user", parts: [{ type: "text", text: COMPACT_PROMPT }] }],
            tools: this.toolset.map((t) => t.spec),
            effort: "low",
            sessionId: this.id,
            signal,
            labels: { purpose: "compact" },
          },
          { text: () => {}, thinking: () => {} },
        );
        break;
      } catch (err) {
        const msg = errorText(err);
        const shorter = attempt < 5 && isContextOverflow(msg) ? cleanTail(history, Math.ceil(history.length / 2)) : null;
        if (!shorter || shorter.length >= history.length) throw new Error(msg);
        const limit = parseContextLimit(msg);
        if (limit) learnWindow(this.data.model, limit);
        history = shorter;
      }
    }
    const summary = turn.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("\n").trim();
    if (!summary) throw new Error("compaction returned no summary");
    const note = `This session was compacted. Summary of the conversation so far:\n\n${summary}${midTurn ? "\n\nContinue the task from where you left off." : ""}`;
    this.data.messages = [{ role: "user", parts: [{ type: "text", text: note }], ts: Date.now() }];
    if (!midTurn) this.data.messages.push({ role: "assistant", parts: [{ type: "text", text: "Got it. I'll continue from this summary." }], ts: Date.now() });
    this.data.contextUsed = Math.ceil(note.length / 4);
    this.readFiles.clear();
    // The history was replaced anyway, so this is the free moment to pick up new memories, skills and tools.
    this.invalidatePrompt();
    this.save();
    ui.notice?.("Conversation compacted.", "info");
  }
}

/** The last `keep` messages or fewer, starting at a user message that isn't only tool results (so no call is left without its result). */
export function cleanTail(messages: Msg[], keep: number): Msg[] {
  for (let i = Math.max(0, messages.length - keep); i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && m.parts.some((p) => p.type !== "tool_result")) return messages.slice(i);
  }
  return [];
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
