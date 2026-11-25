import { shareMcp } from "./mcp";
import { errorText, Session, type AgentUI, type Decision, type ToolCallInfo } from "./agent";
import type { Config } from "./config";
import { registerCommand, registerToolProvider } from "./ext";
import { agentDirs, loadAgentDefs, type AgentDef } from "./subagents/defs";
import type { Diff, Tool, ToolCtx, ToolResult } from "./tools";
import type { Part } from "./types";

export { loadAgentDefs, type AgentDef } from "./subagents/defs";

/**
 * Subagents: the `agent` tool starts a child session with its own context (any gateway model,
 * optionally fewer tools), runs one task to the end and returns the child's final answer.
 * Neighbouring `agent` calls run at the same time. Children can't start subagents (depth 1).
 */

export const AGENT_TOOL = "agent";
export const MODEL_ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
/** about how much of a child's answer goes back to the parent */
export const MAX_RESULT = 20_000;
const ACP_MCP_SERVERS = "acp.mcpServers";
const ASK_QUEUE = "subagents.askQueue";

export function resolveModel(m: string | undefined | null): string | undefined {
  const s = typeof m === "string" ? m.trim() : "";
  if (!s || s.toLowerCase() === "inherit") return undefined;
  return MODEL_ALIASES[s.toLowerCase()] ?? s;
}

/** The model a subagent runs on: asked for > config per type > the type's own > the parent's. */
export function modelFor(def: AgentDef, asked: string | undefined, cfg: Config, parentModel: string): string {
  return resolveModel(asked) ?? resolveModel(cfg.subagentModels?.[def.name]) ?? resolveModel(def.model) ?? parentModel;
}

const SUBAGENT_PROMPT = `You are running as a subagent: another agent started you for one task, given in the first message. You don't see its conversation, and the person won't read your messages directly.
- Work on your own; there is nobody to answer questions. If something is ambiguous, make a sensible choice and say what you chose.
- Stay within the task. Don't make changes it didn't ask for.
- Your final message is returned to the agent that started you as your result. Make it self-contained: what you found or did, with concrete file paths, line numbers and names, and anything left open. Be concise.`;

export function clipResult(s: string, max = MAX_RESULT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n[… ${s.length - max} characters cut …]\n\n${s.slice(-tail)}`;
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function finalAnswer(child: Session): string {
  for (let i = child.data.messages.length - 1; i >= 0; i--) {
    const m = child.data.messages[i];
    if (m.role !== "assistant") continue;
    const text = m.parts
      .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** Permission prompts from several children are shown one at a time. */
function serialAsk(parent: Session, fn: () => Promise<Decision>): Promise<Decision> {
  const prev = (parent.runtime.get(ASK_QUEUE) as Promise<unknown> | undefined) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  parent.runtime.set(
    ASK_QUEUE,
    next.catch(() => {}),
  );
  return next;
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, fallback: T): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const snippet = (text: string) => {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return line.length > 120 ? `…${line.slice(-119)}` : line;
};

export interface SubagentInput {
  description?: string;
  prompt?: string;
  agent_type?: string;
  model?: string;
}

/** Run one subagent to the end for a tool call of the parent session. */
export async function runSubagent(input: SubagentInput, ctx: ToolCtx, defs: AgentDef[]): Promise<ToolResult> {
  const parent = ctx.session;
  if (!parent) return { output: "Subagents need a running session.", isError: true };
  if (parent.data.parentId) return { output: "Subagents can't start their own subagents. Do the work yourself.", isError: true };
  const task = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!task) return { output: "prompt is required: the full task for the subagent.", isError: true };
  const description = (typeof input.description === "string" && input.description.trim()) || task.replace(/\s+/g, " ").slice(0, 40);
  const typeName = (typeof input.agent_type === "string" && input.agent_type.trim()) || "general";
  const def = defs.find((d) => d.name === typeName) ?? defs.find((d) => d.name.toLowerCase() === typeName.toLowerCase());
  if (!def) return { output: `There is no agent type "${typeName}". Available: ${defs.map((d) => d.name).join(", ")}.`, isError: true };
  const model = modelFor(def, input.model, parent.cfg, parent.data.model);

  // An explicitly asked-for model must exist on the gateway (when the gateway can tell us).
  if (resolveModel(input.model) && parent.gateway.models) {
    try {
      const ids = (await parent.gateway.models()).map((m) => m.id);
      if (ids.length && !ids.includes(model)) {
        const near = ids.filter((id) => id.toLowerCase().includes(String(input.model).toLowerCase())).slice(0, 8);
        return { output: `The gateway has no model "${model}".${near.length ? ` Similar: ${near.join(", ")}.` : ""} Leave model out to use the default.`, isError: true };
      }
    } catch {}
  }
  if (ctx.signal?.aborted) return { output: "Cancelled before the subagent started.", isError: true };

  const child = Session.create(parent.gateway, parent.cfg, {
    cwd: parent.data.cwd,
    model,
    mode: parent.data.mode,
    ...(model === parent.data.model ? { effort: parent.data.effort } : {}),
    parentId: parent.id,
    ...(def.tools ? { allowedTools: def.tools.filter((t) => t !== AGENT_TOOL) } : {}),
    extraSystem: [SUBAGENT_PROMPT, def.prompt ? `Instructions for this kind of agent (${def.name}):\n${def.prompt}` : ""].filter(Boolean).join("\n\n"),
  });
  child.data.title = `${description} (${def.name})`;
  child.data.agentLabel = def.name;
  // Never more permissive than the parent: same mode, same "always allow" choices.
  for (const name of parent.allowAlways) child.allowAlways.add(name);
  if (parent.runtime.has(ACP_MCP_SERVERS)) child.runtime.set(ACP_MCP_SERVERS, parent.runtime.get(ACP_MCP_SERVERS));
  // Reuse the parent's MCP connections; the child's dispose leaves them open.
  shareMcp(parent, child);

  const parentUi = ctx.ui;
  let steps = 0;
  let text = "";
  let lastText = 0;
  const emit = (status: "running" | "done" | "failed" | "cancelled", activity?: string) =>
    parentUi?.event?.({ type: "subagent", id: child.id, parentCallId: ctx.callId, status, title: description, agentType: def.name, model, ...(activity ? { activity } : {}) });

  const childUi: AgentUI = {
    text(d) {
      text += d;
      const now = Date.now();
      if (now - lastText < 250) return;
      lastText = now;
      const s = snippet(text);
      if (s) emit("running", s);
    },
    thinking() {},
    step() {
      steps++;
      text = "";
      child.data.mode = parent.data.mode; // follow the parent if the person changes mode mid-task
    },
    toolStart(c) {
      emit("running", c.title);
    },
    toolEnd() {},
    async ask(c: ToolCallInfo, diff: Diff | null): Promise<Decision> {
      if (!parentUi || ctx.signal?.aborted) return "deny";
      if (parent.allowAlways.has(c.name)) return "once";
      const forwarded: ToolCallInfo = { ...c, id: `${ctx.callId ?? "agent"}/${c.id}`, title: `${description}: ${c.title}` };
      const d = await untilAborted(
        serialAsk(parent, async () => (ctx.signal?.aborted ? "deny" : parent.allowAlways.has(c.name) ? "once" : parentUi.ask(forwarded, diff))),
        ctx.signal,
        "deny" as Decision,
      );
      if (d === "always") parent.allowAlways.add(c.name);
      return d;
    },
    notice(message, level) {
      parentUi?.notice?.(`${description}: ${message}`, level);
    },
  };

  const onAbort = () => child.cancel();
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  emit("running");
  try {
    const stop = await child.prompt([{ type: "text", text: task }], childUi);
    const u = child.data.usage;
    const footer = `[${def.name} agent · ${model} · ${steps} step${steps === 1 ? "" : "s"} · ${fmtTokens(u.input + u.cacheRead + u.cacheWrite)} in / ${fmtTokens(u.output)} out tokens · session ${child.id}]`;
    const answer = finalAnswer(child);
    if (stop === "cancelled") {
      emit("cancelled");
      return { output: `The subagent was cancelled.${answer ? `\n\nPartial answer:\n${clipResult(answer)}` : ""}\n\n${footer}`, isError: true };
    }
    if (stop === "refusal") {
      emit("failed", "The model declined");
      return { output: `The subagent's model declined the task.${answer ? `\n\n${clipResult(answer)}` : ""}\n\n${footer}`, isError: true };
    }
    emit("done");
    const note = stop === "max_turn_requests" ? "\n\n(The subagent hit its step limit before finishing.)" : stop === "max_tokens" ? "\n\n(The subagent's answer was cut off by the output limit.)" : "";
    return { output: `${answer ? clipResult(answer) : "(The subagent finished without a final answer.)"}${note}\n\n${footer}` };
  } catch (e) {
    if (ctx.signal?.aborted) {
      emit("cancelled");
      return { output: "The subagent was cancelled.", isError: true };
    }
    const msg = errorText(e);
    emit("failed", msg.slice(0, 200));
    return { output: `The subagent (${def.name}, ${model}) failed: ${msg}`, isError: true };
  } finally {
    ctx.signal?.removeEventListener("abort", onAbort);
    await child.dispose().catch(() => {});
  }
}

function describeTypes(defs: AgentDef[], cfg: Config): string {
  return defs
    .map((d) => {
      const m = resolveModel(cfg.subagentModels?.[d.name]) ?? resolveModel(d.model);
      const extra = [d.tools ? `tools: ${d.tools.join(", ")}` : "", m ? `model: ${m}` : ""].filter(Boolean).join("; ");
      return `- ${d.name}: ${d.description || "(no description)"}${extra ? ` (${extra})` : ""}`;
    })
    .join("\n");
}

/**
 * The models a subagent can run on, grouped by family, so the model can pick across providers
 * (a Claude session can hand a review to GPT, a search to a cheap model, …). Built once per
 * session with the tool list, so it doesn't disturb the prompt cache.
 */
export function describeModels(ids: string[], current: string): string {
  if (!ids.length) return "";
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const fam = id.includes("/") ? id.split("/")[0] : /^claude/i.test(id) ? "Claude" : /^(gpt|codex|o\d)/i.test(id) ? "OpenAI" : /^grok/i.test(id) ? "Grok" : /^gemini/i.test(id) ? "Gemini" : "Other";
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam)!.push(id);
  }
  const lines = [...groups.entries()].map(([fam, list]) => `- ${fam}: ${list.slice(0, 25).join(", ")}${list.length > 25 ? `, … (${list.length - 25} more)` : ""}`);
  return `

Models you can give a subagent (model; default: the type's model, else yours, ${current}). Any of them works, across providers; pick by the job: a different family for an independent second opinion or review, a small fast model for simple searches and summaries, a strong model for hard reasoning. Prefixed ids (e.g. openrouter/…, unlid/…) are pay-per-use.
${lines.join("\n")}`;
}

export function agentTool(defs: AgentDef[], cfg: Config, models: string[] = [], current = ""): Tool {
  const names = defs.map((d) => d.name);
  return {
    spec: {
      name: AGENT_TOOL,
      description: `Start a subagent: a separate agent with its own fresh context that does one task and returns its final answer to you. Several agent calls in the same turn run at the same time.

Use subagents for independent pieces of work you can run in parallel (e.g. research several areas at once), broad searches across many files or folders, and work whose details would fill up your context when you only need the conclusion. Don't use them for small tasks you can finish with a few tool calls, or when you already know which file to read.

The subagent sees none of this conversation: put everything it needs in prompt (the goal, relevant paths, what you already know or ruled out, and what to return). Its answer comes to you, not the person, so relay what matters. Subagents can't start subagents.

Agent types (agent_type, default general):
${describeTypes(defs, cfg)}${describeModels(models, current)}`,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short (3-6 word) description of the task" },
          prompt: { type: "string", description: "The full task for the subagent, with all the context it needs" },
          agent_type: { type: "string", enum: names, description: "Which kind of agent to start (default general)" },
          model: { type: "string", description: "Optional: a model id from the list above (any provider), or opus / sonnet / haiku. Default: the type's model, else yours." },
        },
        required: ["description", "prompt"],
      },
    },
    kind: "other",
    parallel: true,
    // The child's own actions go through the permission flow.
    asks: () => false,
    title(i) {
      const type = typeof i?.agent_type === "string" && i.agent_type && i.agent_type !== "general" ? ` (${i.agent_type})` : "";
      const m = resolveModel(i?.model);
      return `Agent${type}: ${String(i?.description ?? "").trim() || "subagent"}${m ? ` [${m}]` : ""}`;
    },
    paths: () => [],
    run: (i, ctx) => runSubagent(i ?? {}, ctx, defs),
  };
}

registerToolProvider({
  name: "subagents",
  async tools(s) {
    if (s.data.parentId) return [];
    let models: string[] = [];
    try {
      models = (await s.gateway.models?.())?.map((m) => m.id) ?? [];
    } catch {}
    return [agentTool(loadAgentDefs(s.data.cwd), s.cfg, models, s.data.model)];
  },
});

registerCommand({
  name: "agents",
  description: "List the subagent types and where they come from",
  run({ session, print }) {
    const defs = loadAgentDefs(session.data.cwd);
    const lines = ["Subagent types:"];
    for (const d of defs) {
      const m = resolveModel(session.cfg.subagentModels?.[d.name]) ?? resolveModel(d.model);
      lines.push(`- ${d.name}: ${d.description || "(no description)"}`);
      lines.push(`  tools: ${d.tools ? d.tools.join(", ") : "all"} · model: ${m ?? "same as the session"} · from: ${d.source}`);
    }
    lines.push("", "Add your own as Markdown files (frontmatter: name, description, tools, model; the body is its instructions) in these folders, later ones winning:");
    for (const d of agentDirs(session.data.cwd)) lines.push(`- ${d}`);
    print(lines.join("\n"));
  },
});
