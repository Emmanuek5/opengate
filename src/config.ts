import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.1.1";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

/** Where settings live: %APPDATA%\opengate on Windows, $XDG_CONFIG_HOME or ~/.config/opengate elsewhere. */
export function configDir(): string {
  if (process.env.OPENGATE_HOME) return join(process.env.OPENGATE_HOME, "config");
  if (isWin) return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opengate");
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opengate");
}

/** Where sessions live: %LOCALAPPDATA%\opengate, ~/Library/Application Support/opengate, or ~/.local/share/opengate. */
export function dataDir(): string {
  if (process.env.OPENGATE_HOME) return join(process.env.OPENGATE_HOME, "data");
  if (isWin) return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opengate");
  if (isMac) return join(homedir(), "Library", "Application Support", "opengate");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opengate");
}

export type Mode = "ask" | "edits" | "auto" | "yolo";
export const MODES: { id: Mode; name: string; description: string }[] = [
  { id: "ask", name: "Ask", description: "Ask before editing files or running commands" },
  { id: "edits", name: "Auto-edit", description: "Edit files without asking; ask before running commands" },
  { id: "auto", name: "Auto", description: "A safety model approves safe actions and asks about risky ones" },
  { id: "yolo", name: "Full auto", description: "Never ask (your deny rules still apply)" },
];
export const EFFORTS = ["auto", "low", "medium", "high", "xhigh", "max"] as const;

export interface Config {
  /** Gateway root, e.g. https://gateway.example.com:8317 (no /v1) */
  url?: string;
  key?: string;
  model?: string;
  mode?: Mode;
  effort?: string;
  /** permission rules applied in every mode, e.g. { deny: ["shell:rm -rf *"], allow: ["shell:git status*"] } */
  permissions?: { allow?: string[]; deny?: string[] };
  /** the model that reviews actions in auto mode (default claude-haiku-5-5) */
  guardModel?: string;
  /** context window per model id (or prefix ending in *), for compaction */
  contextWindows?: Record<string, number>;
}

export const configPath = () => join(configDir(), "config.json");

export function loadConfig(): Config {
  let file: Config = {};
  try {
    if (existsSync(configPath())) file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch (e) {
    console.error(`opengate: can't read ${configPath()}: ${(e as Error).message}`);
  }
  const env = process.env;
  return {
    ...file,
    url: env.OPENGATE_URL || file.url,
    key: env.OPENGATE_KEY || file.key,
    model: env.OPENGATE_MODEL || file.model,
  };
}

/** Saves the file settings only (environment overrides are never written). The file is private (0600). */
export function saveConfig(patch: Partial<Config>): Config {
  let file: Config = {};
  try {
    if (existsSync(configPath())) file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {}
  const next = { ...file, ...patch };
  writeAtomic(configPath(), JSON.stringify(next, null, 2) + "\n", 0o600);
  return next;
}

export function writeAtomic(path: string, data: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, mode ? { mode } : undefined);
  if (mode && !isWin) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function normalizeUrl(u: string): string {
  let s = u.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/v1$/, "");
}
