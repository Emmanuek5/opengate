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
  /** subagents: the session that started this one (hidden from session lists) */
  parentId?: string;
}

export interface SessionFile extends SessionMeta {
  version: 1;
  messages: Msg[];
}

const dir = () => join(dataDir(), "sessions");
const file = (id: string) => join(dir(), `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`);

export function newId(): string {
  const t = Date.now().toString(36);
  const r = crypto.getRandomValues(new Uint8Array(6));
  return `${t}-${[...r].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function saveSession(s: SessionFile): void {
  mkdirSync(dir(), { recursive: true });
  writeAtomic(file(s.id), JSON.stringify(s));
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
}

/** Sessions newest first, optionally only those started in one folder. */
export function listSessions(cwd?: string, limit = 50): SessionMeta[] {
  if (!existsSync(dir())) return [];
  const files = readdirSync(dir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, t: statSync(join(dir(), f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const out: SessionMeta[] = [];
  for (const { f } of files) {
    const s = loadSession(f.slice(0, -5));
    if (!s) continue;
    if (cwd && s.cwd !== cwd) continue;
    if (s.parentId) continue;
    const { messages: _m, version: _v, ...meta } = s;
    out.push(meta);
    if (out.length >= limit) break;
  }
  return out;
}
