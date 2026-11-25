import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { configDir } from "../config";

/** A kind of subagent: built in, or a Markdown file with frontmatter. */
export interface AgentDef {
  name: string;
  description: string;
  /** tool names the subagent may use; undefined: every tool (except `agent`) */
  tools?: string[];
  /** model id or alias; undefined / "inherit": the parent's model */
  model?: string;
  /** extra instructions (the Markdown body) */
  prompt?: string;
  /** "built-in" or the file it came from */
  source: string;
}

export const READ_ONLY_TOOLS = ["read_file", "glob", "grep"];

export const BUILT_IN: AgentDef[] = [
  {
    name: "general",
    description: "General-purpose agent for multi-step tasks: research, code changes, running commands. Has every tool.",
    source: "built-in",
  },
  {
    name: "explore",
    description: "Fast read-only agent for searching and understanding code: finding files, usages and how things work. Tools: read_file, glob, grep.",
    tools: READ_ONLY_TOOLS,
    prompt:
      "You are an exploration agent. You can only read and search (read_file, glob, grep); you can't change files or run commands. Search broadly, then read what matters, and answer with concrete paths, line numbers and short excerpts.",
    source: "built-in",
  },
];

/** Claude Code tool names (used in .claude/agents files) mapped to opengate's. */
const TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  multiedit: "edit_file",
  glob: "glob",
  ls: "glob",
  grep: "grep",
  bash: "shell",
  shell: "shell",
};

export function normalizeTools(list: string[]): string[] {
  const out = new Set<string>();
  for (const raw of list) {
    const t = raw.trim();
    if (!t) continue;
    out.add(TOOL_ALIASES[t.toLowerCase()] ?? t);
  }
  return [...out];
}

/** The nearest folder above cwd (inclusive) that holds .git; cwd itself if there is none. */
export function projectRoot(cwd: string): string {
  let d = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return cwd;
}

/** The person's home folder (the environment first, so it can be overridden). */
export function homeDir(): string {
  return (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || homedir();
}

/** Folders searched for agent files, lowest precedence first (project files win). */
export function agentDirs(cwd: string): string[] {
  const root = projectRoot(cwd);
  return [join(homeDir(), ".claude", "agents"), join(configDir(), "agents"), join(root, ".claude", "agents"), join(root, ".opengate", "agents")];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return s;
}

/** A small frontmatter reader: `key: value`, quoted values, `|` / `>` blocks, `[a, b]` and `- item` lists. */
export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const src = text.replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string | string[]> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "") {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i]);
      const items = block.filter((l) => l.trim());
      if (value === "" && items.length && items.every((l) => /^\s*-\s+/.test(l))) meta[key] = items.map((l) => unquote(l.replace(/^\s*-\s+/, "")));
      else meta[key] = value.startsWith(">") ? items.map((l) => l.trim()).join(" ") : items.map((l) => l.replace(/^\s+/, "")).join("\n");
    } else if (value.startsWith("[") && value.endsWith("]")) {
      meta[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else meta[key] = unquote(value);
  }
  return { meta, body: src.slice(m[0].length) };
}

const asList = (v: string | string[] | undefined): string[] | undefined => (v == null ? undefined : Array.isArray(v) ? v : v.split(","));

export function parseAgentFile(path: string, text: string): AgentDef | null {
  const { meta, body } = parseFrontmatter(text);
  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string).trim() : Array.isArray(meta[k]) ? (meta[k] as string[]).join(", ") : "");
  const name = (str("name") || basename(path).replace(/\.md$/i, "")).trim();
  if (!/^[\w.-]+$/.test(name)) return null;
  const tools = asList(meta.tools);
  const model = str("model");
  return {
    name,
    description: str("description").replace(/\s+/g, " "),
    ...(tools ? { tools: normalizeTools(tools) } : {}),
    ...(model && model.toLowerCase() !== "inherit" ? { model } : {}),
    ...(body.trim() ? { prompt: body.trim() } : {}),
    source: path,
  };
}

/** Built-ins plus every agent file, by name; later folders override earlier ones (and built-ins). */
export function loadAgentDefs(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>(BUILT_IN.map((d) => [d.name, d]));
  for (const dir of agentDirs(cwd)) {
    let files: string[];
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      files = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      try {
        const def = parseAgentFile(p, readFileSync(p, "utf8"));
        if (def) byName.set(def.name, def);
      } catch (e) {
        console.error(`opengate: can't read agent file ${p}: ${(e as Error)?.message ?? e}`);
      }
    }
  }
  return [...byName.values()];
}
