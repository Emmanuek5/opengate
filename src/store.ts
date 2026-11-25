import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir, writeAtomic, type Mode } from "./config";
import type { Msg, Usage } from "./types";

export interface SessionMeta {
  id: string;
  cwd: string;
  title: string | null;
  model: string;
  mode: Mode;
  effort: string;
  created: number;
  updated: number;
  usage: Usage;
  /** input tokens of the latest call: how full the context is */
  contextUsed: number;
  /** subagents: the session that started this one (hidden from session lists by default) */
  parentId?: string;
  /** subagents: the agent type, e.g. "explore" */
  agentLabel?: string;
  /** number of messages (filled in from the transcript when listing) */
  messageCount?: number;
}

export interface SessionFile extends SessionMeta {
  version: 1;
  /** what the model sees */
  messages: Msg[];
  /** everything before the last compaction, oldest first; kept for transcripts, never sent to the model */
  archived?: Msg[];
}

/** The whole conversation as it happened: archived (pre-compaction) messages, then the current ones. */
export const fullHistory = (s: Pick<SessionFile, "messages" | "archived">): Msg[] => (s.archived?.length ? [...s.archived, ...s.messages] : s.messages);

const dir = () => join(dataDir(), "sessions");
const file = (id: string) => join(dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);

export function newId(): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `${t}-${[...r].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Small metadata file next to each session, so listing never parses whole transcripts. */
const metaFile = (id: string) => join(dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.meta.json`);

export function metaOf(s: SessionFile): SessionMeta {
  const { messages, archived, version: _v, ...meta } = s;
  return { ...meta, messageCount: messages.length + (archived?.length ?? 0) };
}

export function saveSession(s: SessionFile): void {
  mkdirSync(dir(), { recursive: true });
  writeAtomic(file(s.id), JSON.stringify(s));
  writeAtomic(metaFile(s.id), JSON.stringify(metaOf(s)));
}

export function loadSession(id: string): SessionFile | null {
  try {
    const p = file(id);
    if (!existsSync(p)) return null;
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s?.version === 1 ? s : null;
  } catch {
    return null;
  }
}

export function deleteSession(id: string): void {
  rmSync(file(id), { force: true });
  rmSync(metaFile(id), { force: true });
}

function readMeta(id: string): SessionMeta | null {
  try {
    const m = JSON.parse(readFileSync(metaFile(id), "utf8"));
    if (m?.id === id) return m;
  } catch {}
  // Sessions saved before metadata files existed: build it once.
  const s = loadSession(id);
  if (!s) return null;
  const meta = metaOf(s);
  try {
    writeAtomic(metaFile(id), JSON.stringify(meta));
  } catch {}
  return meta;
}

export interface ListOptions {
  /** every folder, not only `cwd` */
  all?: boolean;
  /** include subagent sessions (they have parentId) */
  includeChildren?: boolean;
  /** case-insensitive match on title, folder, model or id */
  query?: string;
}

function sessionIds(): { id: string; t: number }[] {
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    .map((f) => {
      const id = f.slice(0, -5);
      let t = 0;
      try {
        t = statSync(join(dir(), f)).mtimeMs;
      } catch {}
      return { id, t };
    })
    .sort((a, b) => b.t - a.t);
}

/** Sessions newest first: by default only top-level sessions started in `cwd` (or everywhere if no cwd). */
export function listSessions(cwd?: string, limit = 50, opts: ListOptions = {}): SessionMeta[] {
  const q = opts.query?.trim().toLowerCase();
  const out: SessionMeta[] = [];
  for (const { id } of sessionIds()) {
    const m = readMeta(id);
    if (!m) continue;
    if (cwd && !opts.all && m.cwd !== cwd) continue;
    if (m.parentId && !opts.includeChildren) continue;
    if (q && ![m.title, m.cwd, m.model, m.id, m.agentLabel].some((v) => v?.toLowerCase().includes(q))) continue;
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** Subagent sessions started by one session, oldest first. */
export function listChildren(parentId: string): SessionMeta[] {
  return listSessions(undefined, 10_000, { all: true, includeChildren: true })
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.created - b.created);
}

/** Full-text search through transcripts (slower: reads whole files). */
export function searchSessions(text: string, limit = 30, opts: { all?: boolean; cwd?: string } = {}): { meta: SessionMeta; snippet: string }[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  const out: { meta: SessionMeta; snippet: string }[] = [];
  for (const { id } of sessionIds()) {
    const m = readMeta(id);
    if (!m || (opts.cwd && !opts.all && m.cwd !== opts.cwd)) continue;
    const s = loadSession(id);
    if (!s) continue;
    for (const msg of fullHistory(s)) {
      const hit = msg.parts.map((p) => (p.type === "text" || p.type === "thinking" ? p.text : p.type === "tool_result" ? p.output : "")).find((t) => t.toLowerCase().includes(needle));
      if (hit) {
        const i = hit.toLowerCase().indexOf(needle);
        out.push({ meta: m, snippet: hit.slice(Math.max(0, i - 60), i + needle.length + 60).replace(/\s+/g, " ") });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}
