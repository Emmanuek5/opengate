import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VERSION = "0.3.1";

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
  /** how long Claude keeps the cached prompt: "1h" (default; survives pauses) or "5m" (cheaper cache writes on pay-per-token keys) */
  cacheTtl?: "5m" | "1h";
  /** the model that reviews actions in auto mode (default claude-haiku-5-5) */
  guardModel?: string;
  /** look for a newer release once a day and mention it at start (default true) */
  updateCheck?: boolean;
  /** the model that writes compaction summaries (default claude-haiku-5-5; falls back to the session's model if it refuses or fails); "same" always uses the session's model */
  compactModel?: string;
  /** where to compact, in tokens, per model id (or "prefix*"); default 80% of the context window */
  autoCompact?: Record<string, number>;
  /** per-project defaults, keyed by the project root (the git root above the folder, else the folder) */
  projects?: Record<string, { model?: string }>;
  /** the safety guard (built-in blocks, auto-mode review); false turns it off by default (your permissions rules still apply) */
  guard?: boolean;
  /** context window per model id (or prefix ending in *), for compaction */
  contextWindows?: Record<string, number>;
  /** default model per subagent type, e.g. { explore: "claude-haiku-5-5" } (aliases opus/sonnet/haiku work) */
  subagentModels?: Record<string, string>;
  /**
   * MCP servers, Claude-style: { name: { command, args?, env?, cwd? } | { type: "http" | "sse", url, headers? } }.
   * `${VAR}` and `${VAR:-default}` are expanded from the environment. Add `disabled: true` to turn one off.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /** also start the servers in the project's .mcp.json (off by default: project files can run commands) */
  projectMcp?: boolean;
}

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; disabled?: boolean }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; disabled?: boolean };

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

// ---------------- default models ----------------

/** The project a folder belongs to: the nearest folder above it with a .git, else the folder itself. */
export function projectRoot(cwd: string): string {
  let d = resolve(cwd);
  for (let i = 0; i < 60; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return resolve(cwd);
}

/** Key for `projects` in the config: Windows paths fold case. */
export const projectKey = (cwd: string) => {
  const r = projectRoot(cwd);
  return isWin ? r.toLowerCase() : r;
};

/** The model a new session in this folder starts with: the project's default, else the global one. */
export function defaultModel(cfg: Config, cwd: string): string | undefined {
  return cfg.projects?.[projectKey(cwd)]?.model || cfg.model || undefined;
}

/** Save the default model for every project ("global") or for the folder's project. Returns where it applies. */
export function setDefaultModel(scope: "global" | "project", model: string | null, cwd: string): string {
  if (scope === "global") {
    saveConfig({ model: model ?? undefined });
    return "every project without its own default";
  }
  let file: Config = {};
  try {
    if (existsSync(configPath())) file = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {}
  const projects = { ...(file.projects ?? {}) };
  const key = projectKey(cwd);
  if (model) projects[key] = { ...projects[key], model };
  else if (projects[key]) {
    delete projects[key].model;
    if (!Object.keys(projects[key]).length) delete projects[key];
  }
  saveConfig({ projects });
  return projectRoot(cwd);
}
