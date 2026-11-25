import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Session } from "./agent";
import { VERSION, type McpServerConfig } from "./config";
import { registerCommand, registerPromptSection, registerSessionHook, registerToolProvider } from "./ext";
import type { Tool, ToolResult } from "./tools";

/**
 * MCP servers. Sources, first wins when two share a name:
 *   1. the ACP client's servers (session.runtime "acp.mcpServers"),
 *   2. config `mcpServers` (Claude-style map),
 *   3. the project's .mcp.json (Claude format), only with config `projectMcp: true`.
 * Every server is connected in parallel when the session starts (CONNECT_TIMEOUT each); one that
 * fails is recorded (see /mcp) and skipped. Each MCP tool becomes `mcp__<server>__<tool>`.
 */

export const CONNECT_TIMEOUT = 15_000;
const TOOL_TIMEOUT = 10 * 60_000;
const MAX_OUT = 30_000;
const KEY = "mcp";
const isWin = process.platform === "win32";

export type ServerSpec =
  | { name: string; source: Source; transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { name: string; source: Source; transport: "http" | "sse"; url: string; headers: Record<string, string> };
type Source = "acp" | "config" | "project";

export interface ServerState {
  name: string;
  source: Source;
  transport: ServerSpec["transport"];
  status: "connecting" | "connected" | "failed" | "closed";
  error?: string;
  /** opengate tools for this server's tools */
  tools: Tool[];
  client?: Client;
  /** the stdio process, if any */
  pid?: number | null;
  instructions?: string;
  /** the tail of a stdio server's stderr, for error messages */
  stderr: string;
}

interface McpState {
  servers: ServerState[];
  ready: Promise<void>;
  announced: boolean;
  taken: Set<string>;
  /** config entries that couldn't be used */
  problems: string[];
}

// ---------------- configuration ----------------

const expand = (s: string): string => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d?: string) => process.env[k] ?? d ?? "");
const pairs = (list: unknown): Record<string, string> =>
  Object.fromEntries((Array.isArray(list) ? list : []).filter((p: any) => p && typeof p.name === "string").map((p: any) => [p.name, String(p.value ?? "")]));
const strMap = (m: unknown, ex: (s: string) => string): Record<string, string> =>
  Object.fromEntries(Object.entries(m && typeof m === "object" ? (m as Record<string, unknown>) : {}).map(([k, v]) => [k, ex(String(v ?? ""))]));

/** An ACP McpServer (stdio: {name, command, args, env:[{name,value}]}; {type:"http"|"sse", name, url, headers:[{name,value}]}). */
export function fromAcp(s: any): ServerSpec | null {
  if (!s || typeof s.name !== "string") return null;
  if ((s.type === "http" || s.type === "sse") && typeof s.url === "string") return { name: s.name, source: "acp", transport: s.type, url: s.url, headers: pairs(s.headers) };
  if (typeof s.command === "string") return { name: s.name, source: "acp", transport: "stdio", command: s.command, args: (s.args ?? []).map(String), env: pairs(s.env) };
  return null;
}

/** A Claude-style entry ({ command, args, env } or { type, url, headers }), with ${VAR} expansion. */
export function fromClaude(name: string, c: McpServerConfig | any, source: Source): ServerSpec | null {
  if (!c || typeof c !== "object" || c.disabled) return null;
  const type = c.type ?? (c.url ? "http" : "stdio");
  if ((type === "http" || type === "sse" || type === "streamable-http") && typeof c.url === "string")
    return { name, source, transport: type === "sse" ? "sse" : "http", url: expand(c.url), headers: strMap(c.headers, expand) };
  if (type === "stdio" && typeof c.command === "string")
    return { name, source, transport: "stdio", command: expand(c.command), args: (Array.isArray(c.args) ? c.args : []).map((a: unknown) => expand(String(a))), env: strMap(c.env, expand), ...(c.cwd ? { cwd: expand(String(c.cwd)) } : {}) };
  return null;
}

export const projectMcpPath = (cwd: string) => join(cwd, ".mcp.json");

/** Every server for this session, deduplicated by name (ACP, then config, then the project's .mcp.json). */
export function collectServers(session: Session): { specs: ServerSpec[]; problems: string[] } {
  const specs: ServerSpec[] = [];
  const problems: string[] = [];
  const add = (s: ServerSpec | null, what: string) => {
    if (!s) return void problems.push(`${what}: not a valid server entry`);
    if (!specs.some((x) => x.name === s.name)) specs.push(s);
  };
  const acpList = session.runtime.get("acp.mcpServers");
  if (Array.isArray(acpList)) for (const s of acpList) add(fromAcp(s), `client server ${s?.name ?? "?"}`);
  for (const [name, c] of Object.entries(session.cfg.mcpServers ?? {})) if (!(c as any)?.disabled) add(fromClaude(name, c, "config"), `config mcpServers.${name}`);
  if (session.cfg.projectMcp) {
    const p = projectMcpPath(session.data.cwd);
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        for (const [name, c] of Object.entries(j?.mcpServers ?? {})) if (!(c as any)?.disabled) add(fromClaude(name, c, "project"), `.mcp.json ${name}`);
      } catch (e) {
        problems.push(`${p}: ${(e as Error).message}`);
      }
    }
  }
  return { specs, problems };
}

// ---------------- Windows commands ----------------

/**
 * How to spawn a stdio server. On Windows, `npx`, `uvx`, … are often .cmd/.bat shims, which can't
 * be spawned directly, so they run through `cmd /d /c` (unquoted cmd metacharacters are escaped).
 */
export function stdioCommand(command: string, args: string[], platform: string = process.platform, which: (c: string) => string | null = (c) => Bun.which(c)): { command: string; args: string[] } {
  if (platform !== "win32" || /\.(exe|com)$/i.test(command)) return { command, args };
  const found = /\.(cmd|bat)$/i.test(command) ? command : (which(command) ?? which(`${command}.cmd`) ?? which(`${command}.bat`));
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { command: found ?? command, args };
  const esc = (a: string) => (/[\s"]/.test(a) ? a : a.replace(/([&|<>^()])/g, "^$1"));
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", command, ...args.map(esc)] };
}

// ---------------- connecting ----------------

/** Hides URL query strings (they can carry tokens) in messages. */
const scrub = (s: string) => s.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, "$1?…");

function errMessage(e: unknown, spec: ServerSpec): string {
  const err = e as any;
  const code = err?.code;
  if (spec.transport === "stdio" && code === "ENOENT") return `command not found: ${spec.command}`;
  if (code === 401 || /\b401\b/.test(String(err?.message))) return "the server needs authentication (401); add an Authorization header (OAuth sign-in isn't supported yet)";
  return scrub(String(err?.message ?? err)).slice(0, 500);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms)))]).finally(() => clearTimeout(timer));
}

function makeTransport(spec: ServerSpec, st: ServerState, cwd: string, kind = spec.transport): Transport {
  if (spec.transport === "stdio") {
    const { command, args } = stdioCommand(spec.command, spec.args);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    const t = new StdioClientTransport({ command, args, env: { ...env, ...spec.env }, cwd: spec.cwd ?? cwd, stderr: "pipe" });
    // Drain stderr (a full pipe would block the server) and keep the tail for error messages.
    (t.stderr as any)?.on?.("data", (d: Buffer) => (st.stderr = (st.stderr + d.toString("utf8")).slice(-2000)));
    return t;
  }
  const opts = { requestInit: { headers: spec.headers } };
  return kind === "sse" ? new SSEClientTransport(new URL(spec.url), opts) : new StreamableHTTPClientTransport(new URL(spec.url), opts);
}

const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** `mcp__<server>__<tool>`, only [a-zA-Z0-9_-], at most 64 characters, unique within the session. */
export function mcpToolName(server: string, tool: string, taken: Set<string>): string {
  let n = `mcp__${clean(server)}__${clean(tool)}`;
  if (n.length > 64 || taken.has(n)) n = `${n.slice(0, 55)}_${createHash("sha1").update(`${server}\0${tool}`).digest("hex").slice(0, 8)}`;
  for (let i = 2; taken.has(n); i++) n = `${n.slice(0, 60)}_${i}`;
  taken.add(n);
  return n;
}

/** MCP tool results as text: text joined, images and audio noted, resources summarized, capped. */
export function formatResult(r: any): ToolResult {
  const out: string[] = [];
  for (const c of Array.isArray(r?.content) ? r.content : []) {
    if (c?.type === "text") out.push(String(c.text ?? ""));
    else if (c?.type === "image") out.push(`[image: ${c.mimeType ?? "unknown"}]`);
    else if (c?.type === "audio") out.push(`[audio: ${c.mimeType ?? "unknown"}]`);
    else if (c?.type === "resource_link") out.push(`[resource link: ${c.uri}${c.name ? ` (${c.name})` : ""}${c.mimeType ? `, ${c.mimeType}` : ""}]`);
    else if (c?.type === "resource") {
      const res = c.resource ?? {};
      if (typeof res.text === "string") out.push(`[resource: ${res.uri}${res.mimeType ? `, ${res.mimeType}` : ""}]\n${res.text}`);
      else out.push(`[resource: ${res.uri}${res.mimeType ? `, ${res.mimeType}` : ""}, binary ${typeof res.blob === "string" ? Math.floor((res.blob.length * 3) / 4) : 0} bytes]`);
    } else if (c) out.push(JSON.stringify(c));
  }
  if (!out.length && r?.structuredContent !== undefined) out.push(JSON.stringify(r.structuredContent, null, 2));
  if (!out.length && r?.toolResult !== undefined) out.push(typeof r.toolResult === "string" ? r.toolResult : JSON.stringify(r.toolResult, null, 2));
  let output = out.join("\n") || "(no output)";
  if (output.length > MAX_OUT) output = `${output.slice(0, MAX_OUT)}\n[… ${output.length - MAX_OUT} characters cut]`;
  return { output, ...(r?.isError ? { isError: true } : {}) };
}

function makeTool(st: ServerState, t: any, name: string, state: McpState): Tool {
  const readOnly = t?.annotations?.readOnlyHint === true;
  let schema: Record<string, unknown> = t?.inputSchema && typeof t.inputSchema === "object" ? { ...t.inputSchema } : {};
  delete schema.$schema;
  if (schema.type !== "object") schema = { type: "object", properties: {} };
  if (!schema.properties) schema.properties = {};
  const label = t?.annotations?.title ?? t?.title ?? t?.name;
  let description = String(t?.description ?? label ?? "");
  if (description.length > 4000) description = description.slice(0, 4000) + "…";
  return {
    spec: { name, description: description || `${t.name} (MCP server ${st.name})`, parameters: schema },
    kind: readOnly ? "read" : "other",
    ...(readOnly ? { parallel: true } : {}),
    asks: () => !readOnly,
    title: () => `${label} (${st.name} MCP)`,
    paths: () => [],
    async run(input, ctx) {
      announce(state, ctx.ui);
      if (st.status !== "connected" || !st.client) return { output: `The MCP server ${st.name} isn't connected${st.error ? `: ${st.error}` : ""}.`, isError: true };
      try {
        const r = await st.client.callTool({ name: t.name, arguments: input ?? {} }, undefined, { signal: ctx.signal, timeout: TOOL_TIMEOUT, resetTimeoutOnProgress: true, onprogress: () => {} });
        return formatResult(r);
      } catch (e) {
        if (ctx.signal?.aborted) return { output: "Cancelled.", isError: true };
        return { output: `MCP error from ${st.name}: ${errMessage(e, { transport: st.transport } as ServerSpec)}`, isError: true };
      }
    },
  };
}

async function listTools(client: Client): Promise<any[]> {
  const tools: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(r.tools ?? []));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

async function connectOne(spec: ServerSpec, st: ServerState, state: McpState, cwd: string, timeout: number): Promise<void> {
  const attempt = async (kind: ServerSpec["transport"]) => {
    const client = new Client({ name: "opengate", version: VERSION });
    const transport = makeTransport(spec, st, cwd, kind);
    try {
      await withTimeout(client.connect(transport), timeout, "connecting");
      return client;
    } catch (e) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw e;
    }
  };
  let client: Client;
  try {
    client = await attempt(spec.transport);
  } catch (e) {
    // Older servers only speak the deprecated HTTP+SSE transport.
    const code = (e as any)?.code;
    if (spec.transport !== "http" || !(code === 404 || code === 405)) throw e;
    client = await attempt("sse");
    st.transport = "sse";
  }
  st.client = client;
  st.pid = (client.transport as any)?.pid ?? null;
  const tools = await withTimeout(listTools(client), timeout, "listing tools").catch(async (e) => {
    await closeServer(st);
    throw e;
  });
  st.tools = tools.map((t) => makeTool(st, t, mcpToolName(st.name, t.name, state.taken), state));
  const instr = client.getInstructions();
  if (instr?.trim()) st.instructions = instr.trim();
  st.status = "connected";
  client.onclose = () => {
    if (st.status === "connected") {
      st.status = "closed";
      st.error = `the server closed the connection${tail(st)}`;
    }
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    try {
      const next = await listTools(client);
      for (const t of st.tools) state.taken.delete(t.spec.name);
      st.tools = next.map((t) => makeTool(st, t, mcpToolName(st.name, t.name, state.taken), state));
    } catch {}
  });
}

const tail = (st: ServerState) => {
  const t = st.stderr.trim().split(/\r?\n/).slice(-3).join("\n").slice(-300);
  return t ? `\n${scrub(t)}` : "";
};

async function closeServer(st: ServerState): Promise<void> {
  const client = st.client;
  const pid = st.pid;
  st.client = undefined;
  if (client) await withTimeout(client.close(), 6000, "closing").catch(() => {});
  // On Windows a cmd /c shim leaves the real server as a grandchild; end the whole tree.
  if (isWin && pid) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {});
    } catch {}
  }
}

/** Starts (once) connecting every server for the session; resolves when all have connected or failed. */
export function ensureMcp(session: Session, timeout = CONNECT_TIMEOUT): McpState {
  let state = session.runtime.get(KEY) as McpState | undefined;
  if (state) return state;
  const { specs, problems } = collectServers(session);
  const servers: ServerState[] = specs.map((s) => ({ name: s.name, source: s.source, transport: s.transport, status: "connecting", tools: [], stderr: "" }));
  state = { servers, ready: Promise.resolve(), announced: false, taken: new Set(), problems };
  const s = state;
  state.ready = Promise.all(
    specs.map(async (spec, i) => {
      const st = servers[i];
      try {
        await connectOne(spec, st, s, session.data.cwd, timeout);
      } catch (e) {
        st.status = "failed";
        st.error = errMessage(e, spec) + tail(st);
        st.tools = [];
      }
    }),
  ).then(() => {});
  session.runtime.set(KEY, state);
  return state;
}

export const mcpState = (session: Session): McpState | undefined => session.runtime.get(KEY) as McpState | undefined;

/** Tells the front end each server's status once, the first time a ui is reachable (an MCP tool call or /mcp). */
function announce(state: McpState, ui: { event?(e: any): void } | undefined) {
  if (state.announced || !ui?.event) return;
  state.announced = true;
  for (const st of state.servers) ui.event({ type: "mcp", server: st.name, status: st.status === "connecting" ? "failed" : st.status, tools: st.tools.length, ...(st.error ? { error: st.error } : {}) });
}

const BORROWED = "mcp.borrowed";

/** Let a subagent use its parent's MCP connections instead of opening its own. */
export function shareMcp(parent: Session, child: Session): void {
  const state = ensureMcp(parent);
  child.runtime.set(KEY, state);
  child.runtime.set(BORROWED, true);
}

export async function disposeMcp(session: Session): Promise<void> {
  const state = mcpState(session);
  if (!state || session.runtime.get(BORROWED)) return;
  await state.ready.catch(() => {});
  await Promise.all(
    state.servers.map(async (st) => {
      const had = !!st.client;
      await closeServer(st);
      st.tools = [];
      if (had || st.status === "connected") st.status = "closed";
    }),
  );
}

// ---------------- registration ----------------

registerSessionHook({
  name: "mcp",
  async start(session) {
    await ensureMcp(session).ready;
  },
  dispose: disposeMcp,
});

registerToolProvider({
  name: "mcp",
  async tools(session) {
    const state = ensureMcp(session);
    await state.ready;
    return state.servers.filter((s) => s.status === "connected").flatMap((s) => s.tools);
  },
});

registerPromptSection({
  name: "mcp",
  order: 60,
  async render(session) {
    const state = mcpState(session);
    if (!state) return null;
    await state.ready;
    const parts = state.servers.filter((s) => s.status === "connected" && s.instructions).map((s) => `## ${s.name}\n${s.instructions!.slice(0, 2000)}`);
    if (!parts.length) return null;
    return `# MCP servers\nInstructions from the connected MCP servers (their tools are named mcp__<server>__<tool>):\n\n${parts.join("\n\n")}`.slice(0, 6000);
  },
});

registerCommand({
  name: "mcp",
  description: "Show MCP servers, their status and tools",
  args: "[server]",
  async run({ session, args, print, ui }) {
    const state = ensureMcp(session);
    await state.ready;
    announce(state, ui);
    const problems = state.problems.length ? `\nIgnored: ${state.problems.join("; ")}` : "";
    if (!state.servers.length) {
      const hint = !session.cfg.projectMcp && existsSync(projectMcpPath(session.data.cwd)) ? ' This project has a .mcp.json; set "projectMcp": true in your config to use it.' : "";
      print(`No MCP servers. Add them under "mcpServers" in your opengate config (same format as Claude Code's .mcp.json).${hint}${problems}`);
      return;
    }
    if (args) {
      const st = state.servers.find((s) => s.name === args);
      if (!st) return print(`No MCP server called "${args}".`);
      const lines = st.tools.map((t) => `- ${t.spec.name}${t.asks("ask") ? "" : " (read-only)"}: ${t.spec.description.split("\n")[0].slice(0, 100)}`);
      return print(`${st.name} (${st.transport}, from ${st.source}): ${st.status}${st.error ? ` — ${st.error}` : ""}\n${lines.join("\n") || "(no tools)"}`);
    }
    const lines = state.servers.map((s) => `- ${s.name} (${s.transport}, from ${s.source}): ${s.status}${s.status === "connected" ? `, ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}` : ""}${s.error ? ` — ${s.error}` : ""}`);
    print(`MCP servers:\n${lines.join("\n")}${problems}`);
  },
});
