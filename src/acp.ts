import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Session, type AgentUI, type ToolCallInfo } from "./agent";
import { EFFORTS, loadConfig, MODES, VERSION, type Config, type Mode } from "./config";
import { Gateway, groupModels, type GatewayModel } from "./gateway";
import { listSessions, loadSession } from "./store";
import { getCommand, getCommands } from "./ext";
import { surface } from "./llm/util";
import "./features";
import { toolByName, type Diff, type ToolResult } from "./tools";
import type { Part } from "./types";

type Client = acp.AgentContext;

export const PREFERRED_MODELS = ["claude-opus-5-5", "gpt-6.1-sol", "claude-sonnet-5-5", "grok-4.7"];

export function pickModel(models: GatewayModel[], wanted?: string): string {
  if (wanted) return wanted;
  const ids = new Set(models.map((m) => m.id));
  return PREFERRED_MODELS.find((m) => ids.has(m)) ?? models[0]?.id ?? "claude-opus-5-5";
}

export function configOptions(models: GatewayModel[], s: Session): acp.SessionConfigOption[] {
  const ids = models.some((m) => m.id === s.data.model) ? models : [{ id: s.data.model, ownedBy: null }, ...models];
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: s.data.model,
      options: groupModels(ids).map((g) => ({ group: g.group, name: g.group, options: g.models.map((m) => ({ value: m, name: m })) })),
    },
    {
      type: "select",
      id: "effort",
      name: "Effort",
      category: "thought_level",
      currentValue: s.data.effort,
      options: EFFORTS.map((e) => ({ value: e, name: e === "auto" ? "Auto (model default)" : e })),
    },
  ];
}

const modeState = (mode: Mode): acp.SessionModeState => ({ currentModeId: mode, availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })) });

export function toParts(blocks: acp.ContentBlock[]): Part[] {
  const parts: Part[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "image") parts.push({ type: "image", mediaType: b.mimeType, data: b.data });
    else if (b.type === "resource" && "text" in b.resource) parts.push({ type: "text", text: `<file uri="${b.resource.uri}">\n${b.resource.text}\n</file>` });
    else if (b.type === "resource_link") parts.push({ type: "text", text: `@${b.uri.replace(/^file:\/\//, "")}` });
  }
  return parts;
}

function toolContent(r: ToolResult): acp.ToolCallContent[] {
  const out: acp.ToolCallContent[] = [];
  if (r.diff) out.push({ type: "diff", path: r.diff.path, oldText: r.diff.oldText, newText: r.diff.newText });
  if (!r.diff || r.isError) out.push({ type: "content", content: { type: "text", text: "```\n" + r.output.slice(0, 20_000) + "\n```" } });
  return out;
}

/** Streams a session's work to the client as session/update notifications. */
class AcpUI implements AgentUI {
  constructor(
    private client: Client,
    private session: Session,
  ) {}
  private send(update: acp.SessionUpdate) {
    void this.client.notify("session/update", { sessionId: this.session.id, update }).catch(() => {});
  }
  text(d: string) {
    this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: d } });
  }
  thinking(d: string) {
    this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: d } });
  }
  toolStart(c: ToolCallInfo) {
    this.send({ sessionUpdate: "tool_call", toolCallId: c.id, title: c.title, kind: c.kind, status: "pending", rawInput: c.input, locations: c.paths.map((path) => ({ path })) });
  }
  toolEnd(c: ToolCallInfo, r: ToolResult) {
    this.send({ sessionUpdate: "tool_call_update", toolCallId: c.id, status: r.isError ? "failed" : "completed", content: toolContent(r), rawOutput: { output: r.output.slice(0, 20_000) } });
  }
  async ask(c: ToolCallInfo, diff: Diff | null) {
    const res = await this.client.request("session/request_permission", {
      sessionId: this.session.id,
      toolCall: { toolCallId: c.id, title: c.title, kind: c.kind, rawInput: c.input, ...(diff ? { content: [{ type: "diff", path: diff.path, oldText: diff.oldText, newText: diff.newText }] } : {}) },
      options: [
        { optionId: "once", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: c.kind === "execute" ? "Always allow commands" : "Always allow edits", kind: "allow_always" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });
    if (res.outcome.outcome !== "selected") return "deny";
    const id = res.outcome.optionId;
    return id === "once" || id === "always" ? id : "deny";
  }
  notice(message: string) {
    this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `\n_${message}_\n` } });
  }
  event(e: import("./ext").AgentEvent) {
    // Subagent progress shows on the parent `agent` call; its final result comes with toolEnd.
    if (e.type !== "subagent" || typeof e.parentCallId !== "string" || e.status !== "running") return;
    const activity = typeof e.activity === "string" ? e.activity : "";
    this.send({
      sessionUpdate: "tool_call_update",
      toolCallId: e.parentCallId,
      status: "in_progress",
      ...(activity ? { content: [{ type: "content", content: { type: "text", text: activity } }] } : {}),
    });
  }
  usage(s: Session) {
    this.send({ sessionUpdate: "usage_update", used: s.data.contextUsed, size: s.contextSize });
  }
}

/** Send a saved conversation back to the client (session/load). */
function replay(client: Client, s: Session) {
  const send = (update: acp.SessionUpdate) => client.notify("session/update", { sessionId: s.id, update });
  const calls = new Map<string, { name: string; input: any }>();
  const jobs: Promise<void>[] = [];
  for (const m of s.data.messages) {
    for (const p of m.parts) {
      if (m.role === "user" && p.type === "text") jobs.push(send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: p.text } }));
      else if (p.type === "image") jobs.push(send({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: p.mediaType, data: p.data } }));
      else if (p.type === "text") jobs.push(send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: p.text } }));
      else if (p.type === "thinking" && p.text) jobs.push(send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: p.text } }));
      else if (p.type === "tool_call") {
        calls.set(p.id, { name: p.name, input: p.input });
        const t = toolByName.get(p.name);
        let title = p.name;
        try {
          title = t?.title(p.input, s.data.cwd) ?? p.name;
        } catch {}
        jobs.push(send({ sessionUpdate: "tool_call", toolCallId: p.id, title, kind: t?.kind ?? "other", status: "in_progress", rawInput: p.input }));
      } else if (p.type === "tool_result")
        jobs.push(send({ sessionUpdate: "tool_call_update", toolCallId: p.id, status: p.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: "```\n" + p.output.slice(0, 4000) + "\n```" } }] }));
    }
  }
  return Promise.all(jobs);
}

/** MCP servers the client asked for, kept for the MCP feature (see ext.ts SessionHook). */
export const ACP_MCP_SERVERS = "acp.mcpServers";

function announceCommands(client: Client, s: Session) {
  const availableCommands = [{ name: "compact", description: "Summarize the conversation to free up context" }, ...getCommands().map((c) => ({ name: c.name, description: c.description, ...(c.args ? { input: { hint: c.args } } : {}) }))];
  void client.notify("session/update", { sessionId: s.id, update: { sessionUpdate: "available_commands_update", availableCommands } }).catch(() => {});
}

export function createAgent(opts: { config?: () => Config; gateway?: (cfg: Config) => Gateway } = {}) {
  const getConfig = opts.config ?? loadConfig;
  const sessions = new Map<string, Session>();
  let gw: Gateway | null = null;
  let gwKey = "";
  const gateway = () => {
    const cfg = getConfig();
    if (!cfg.url || !cfg.key) throw acp.RequestError.authRequired(undefined, "opengate isn't connected to a gateway yet. Run `opengate login` in a terminal.");
    const k = `${cfg.url}\n${cfg.key}`;
    if (!gw || gwKey !== k) {
      gw = opts.gateway ? opts.gateway(cfg) : new Gateway(cfg.url, cfg.key);
      gwKey = k;
    }
    return { cfg, gw };
  };
  const models = async (g: Gateway) => {
    try {
      return await g.models();
    } catch (e) {
      console.error("opengate: couldn't list models:", (e as Error).message);
      return [];
    }
  };
  const get = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw acp.RequestError.resourceNotFound(id);
    return s;
  };
  const open = async (id: string, cwd: string) => {
    const { cfg, gw } = gateway();
    let s = sessions.get(id);
    if (!s) {
      const f = loadSession(id);
      if (!f) throw acp.RequestError.resourceNotFound(id);
      if (cwd) f.cwd = cwd;
      s = new Session(f, gw, cfg);
      sessions.set(id, s);
    }
    return { s, list: await models(gw) };
  };

  return acp
    .agent({ name: "opengate" })
    .onRequest("initialize", ({ params }) => {
      const cfg = getConfig();
      surface.mode = "acp";
      surface.client = String(params.clientInfo?.title || params.clientInfo?.name || "").replace(/[();]/g, "").slice(0, 40);
      return {
        protocolVersion: Math.min(params.protocolVersion ?? acp.PROTOCOL_VERSION, acp.PROTOCOL_VERSION),
        agentInfo: { name: "opengate", title: "OpenGate", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {} },
        },
        authMethods: cfg.url && cfg.key ? [] : [{ id: "opengate-login", name: "Log in to your gateway", description: "Run `opengate login` in a terminal, then start a new session." }],
      };
    })
    .onRequest("authenticate", () => {
      gateway();
      return {};
    })
    .onRequest("session/new", async ({ params, client }) => {
      const { cfg, gw } = gateway();
      const list = await models(gw);
      const s = Session.create(gw, cfg, { cwd: params.cwd, model: pickModel(list, cfg.model) });
      s.runtime.set(ACP_MCP_SERVERS, params.mcpServers ?? []);
      sessions.set(s.id, s);
      s.save();
      setTimeout(() => announceCommands(client, s), 0);
      return { sessionId: s.id, modes: modeState(s.data.mode), configOptions: configOptions(list, s) };
    })
    .onRequest("session/load", async ({ params, client }) => {
      const { s, list } = await open(params.sessionId, params.cwd);
      s.runtime.set(ACP_MCP_SERVERS, params.mcpServers ?? []);
      await replay(client, s);
      announceCommands(client, s);
      return { modes: modeState(s.data.mode), configOptions: configOptions(list, s) };
    })
    .onRequest("session/list", ({ params }) => ({
      sessions: listSessions(params.cwd ?? undefined).map((m) => ({ sessionId: m.id, cwd: m.cwd, title: m.title, updatedAt: new Date(m.updated).toISOString() })),
    }))
    .onRequest("session/set_mode", ({ params }) => {
      if (!MODES.some((m) => m.id === params.modeId)) throw acp.RequestError.invalidParams(undefined, `unknown mode ${params.modeId}`);
      get(params.sessionId).setMode(params.modeId as Mode);
      return {};
    })
    .onRequest("session/set_config_option", async ({ params }) => {
      const s = get(params.sessionId);
      const value = String((params as any).value);
      if (params.configId === "model") s.setModel(value);
      else if (params.configId === "effort") {
        if (!(EFFORTS as readonly string[]).includes(value)) throw acp.RequestError.invalidParams(undefined, `unknown effort ${value}`);
        s.setEffort(value);
      } else throw acp.RequestError.invalidParams(undefined, `unknown option ${params.configId}`);
      return { configOptions: configOptions(await models(gateway().gw), s) };
    })
    .onRequest("session/prompt", async ({ params, client }) => {
      const s = get(params.sessionId);
      const ui = new AcpUI(client, s);
      const parts = toParts(params.prompt);
      const text = parts.length === 1 && parts[0].type === "text" ? parts[0].text.trim() : "";
      if (text === "/compact") {
        await s.compact(ui);
        return { stopReason: "end_turn" };
      }
      const cmd = text.startsWith("/") ? getCommand(text.slice(1).split(/\s+/)[0]) : undefined;
      if (cmd) {
        await cmd.run({ session: s, args: text.slice(1 + cmd.name.length).trim(), ui, print: (t) => ui.text(t.endsWith("\n") ? t : t + "\n") });
        return { stopReason: "end_turn" };
      }
      const hadTitle = !!s.data.title;
      const stop = await s.prompt(parts, ui);
      if (!hadTitle && s.data.title) void client.notify("session/update", { sessionId: s.id, update: { sessionUpdate: "session_info_update", title: s.data.title } }).catch(() => {});
      return { stopReason: stop };
    })
    .onNotification("session/cancel", ({ params }) => {
      sessions.get(params.sessionId)?.cancel();
    });
}

/** `opengate acp`: speak ACP on stdin/stdout. Nothing else may write to stdout. */
export async function runAcp(): Promise<void> {
  console.log = console.error;
  console.info = console.error;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const conn = createAgent().connect(acp.ndJsonStream(output, input));
  await conn.closed;
}
