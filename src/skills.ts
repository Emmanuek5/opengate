import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Session } from "./agent";
import { configDir } from "./config";
import { registerCommand, registerPromptSection, registerToolProvider } from "./ext";
import type { Tool } from "./tools";

/**
 * Skills: folders with a SKILL.md (frontmatter `name` and `description`, then instructions) plus
 * optional scripts, references and assets. The same format is used by Claude Code and Codex, so
 * opengate reads their folders too.
 *
 * Where skills are found, highest precedence first (the first skill with a given name wins):
 *   project (the working directory, then its parents up to the git root):
 *     1. <project>/.opengate/skills/*
 *     2. <project>/.agents/skills/*
 *     3. <project>/.claude/skills/*
 *   user:
 *     4. <configDir>/skills/*                 (opengate's own; see configDir() in config.ts)
 *     5. ~/.agents/skills/*
 *     6. ~/.claude/skills/*
 *     7. ~/.claude/skills/synced/<id>/*       (skills synced from claude.ai)
 *     8. ~/.codex/skills/*
 *     9. ~/.codex/skills/.system/*            (Codex's bundled skills)
 * So project beats user, and opengate's folders beat .agents, which beat Claude's, which beat Codex's.
 * Folders whose name starts with "." (e.g. .trash) are skipped, except the explicit .system root.
 */

export interface Skill {
  name: string;
  description: string;
  /** the skill's folder */
  dir: string;
  /** the SKILL.md path */
  file: string;
  /** where it was found, for /skills, e.g. "~/.claude/skills" */
  source: string;
  scope: "project" | "user";
}

interface Root {
  dir: string;
  source: string;
  scope: Skill["scope"];
  /** skill folders sit one level deeper (dir/<group>/<skill>/SKILL.md) */
  nested?: boolean;
}

const isWin = process.platform === "win32";
/** The home folder, read at call time (HOME / USERPROFILE), so tests and odd setups can move it. */
export const home = (): string => (isWin ? process.env.USERPROFILE : process.env.HOME) || homedir();

const tilde = (p: string) => {
  const h = home();
  return p === h || p.startsWith(h + sep) ? "~" + p.slice(h.length) : p;
};

/** The project folders searched: cwd, then its parents up to the nearest one with .git (if any, and not above home). */
function projectDirs(cwd: string): string[] {
  const start = resolve(cwd);
  const chain: string[] = [];
  for (let d = start; ; ) {
    chain.push(d);
    if (existsSync(join(d, ".git"))) return chain;
    const up = dirname(d);
    if (up === d || d === home()) break;
    d = up;
  }
  return [start];
}

export function skillRoots(cwd: string): Root[] {
  const roots: Root[] = [];
  for (const p of projectDirs(cwd)) {
    const at = (sub: string) => ({ dir: join(p, sub, "skills"), source: tilde(join(p, sub, "skills")), scope: "project" as const });
    roots.push(at(".opengate"), at(".agents"), at(".claude"));
  }
  const h = home();
  const user = (dir: string, nested = false): Root => ({ dir, source: tilde(dir), scope: "user", nested });
  roots.push(
    user(join(configDir(), "skills")),
    user(join(h, ".agents", "skills")),
    user(join(h, ".claude", "skills")),
    user(join(h, ".claude", "skills", "synced"), true),
    user(join(h, ".codex", "skills")),
    user(join(h, ".codex", "skills", ".system")),
  );
  return roots;
}

// ---------------- frontmatter ----------------

const unquote = (v: string): string => {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};

/**
 * Splits SKILL.md into its frontmatter (top-level `key: value` pairs; quoted values, `|` / `>`
 * block scalars and indented continuation lines) and the body. Nested maps are ignored.
 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const src = text.replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  const indented = (l: string | undefined) => l !== undefined && /^[ \t]+\S/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const value = (kv[2] ?? "").trim();
    const more: string[] = [];
    while (indented(lines[i + 1]) || (lines[i + 1]?.trim() === "" && indented(lines[i + 2]))) more.push(lines[++i].trim());
    if (/^[|>][+-]?$/.test(value)) meta[kv[1]] = more.join(value[0] === "|" ? "\n" : " ").trim();
    else if (value) meta[kv[1]] = unquote([value, ...more].join(" "));
    // an empty value with indented lines below is a nested map or list (e.g. metadata:); skipped
    else if (!more.length) meta[kv[1]] = "";
  }
  return { meta, body: src.slice(m[0].length) };
}

// ---------------- discovery (cached by mtime) ----------------

const parsed = new Map<string, { mtime: number; name: string; description: string } | null>();

function readSkill(file: string, folder: string): { name: string; description: string } | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const hit = parsed.get(file);
  if (hit !== undefined && hit?.mtime === st.mtimeMs) return hit;
  let out: { mtime: number; name: string; description: string } | null = null;
  try {
    const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const name = (meta.name || folder).trim();
    let description = (meta.description || "").replace(/\s+/g, " ").trim();
    if (!description) description = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? "";
    if (name) out = { mtime: st.mtimeMs, name, description };
  } catch {}
  parsed.set(file, out);
  return out;
}

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

/** Every skill visible from `cwd`, deduplicated by name (see the precedence at the top of this file), sorted by name. */
export function discoverSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of skillRoots(cwd)) {
    const folders = root.nested ? subdirs(root.dir).flatMap((g) => subdirs(join(root.dir, g)).map((s) => join(root.dir, g, s))) : subdirs(root.dir).map((s) => join(root.dir, s));
    for (const dir of folders) {
      const file = join(dir, "SKILL.md");
      const s = readSkill(file, dir.split(sep).pop()!);
      if (!s || byName.has(s.name.toLowerCase())) continue;
      byName.set(s.name.toLowerCase(), { name: s.name, description: s.description, dir, file, source: root.source, scope: root.scope });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(cwd: string, name: string): Skill | undefined {
  const want = String(name ?? "").trim().replace(/^\//, "").toLowerCase();
  return discoverSkills(cwd).find((s) => s.name.toLowerCase() === want);
}

// ---------------- prompt section ----------------

export const SECTION_CAP = 8000;
const DESC_CAP = 300;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function renderSkillsSection(skills: Skill[], cap = SECTION_CAP): string | null {
  if (!skills.length) return null;
  const head =
    "# Skills\nSkills are folders of instructions, scripts and resources for particular tasks. When a task matches a skill's description, call the `skill` tool with that name before starting the work, then follow its instructions. Only load skills that match the task.\n";
  for (const descCap of [DESC_CAP, 120]) {
    const lines = skills.map((s) => `- ${s.name}: ${cut(s.description, descCap)}`);
    const text = head + "\n" + lines.join("\n");
    if (text.length <= cap) return text;
  }
  // Still too long: list as many as fit with short descriptions, then the rest by name only.
  let text = head + "\n";
  let i = 0;
  for (; i < skills.length; i++) {
    const line = `- ${skills[i].name}: ${cut(skills[i].description, 120)}\n`;
    if (text.length + line.length > cap * 0.75) break;
    text += line;
  }
  const rest = skills.slice(i).map((s) => s.name);
  let names = "";
  let shown = 0;
  for (const n of rest) {
    if (text.length + names.length + n.length + 60 > cap) break;
    names += (shown ? ", " : "") + n;
    shown++;
  }
  if (shown) text += `- Also: ${names}\n`;
  if (shown < rest.length) text += `(${rest.length - shown} more skills not listed.)\n`;
  return text.trimEnd();
}

// ---------------- the skill tool ----------------

const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".DS_Store"]);
const MAX_FILES = 100;

/** Files in a skill folder, relative, a few levels deep, capped. */
export function skillFiles(dir: string, depth = 3): { files: string[]; more: boolean } {
  const files: string[] = [];
  let more = false;
  const walk = (d: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      if (files.length >= MAX_FILES) return void (more = true);
      const p = join(d, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (e.isDirectory()) {
        if (level >= depth) {
          files.push(rel + "/ (not listed)");
          continue;
        }
        walk(p, level + 1);
      } else files.push(rel);
    }
  };
  walk(dir, 1);
  return { files, more };
}

export const TOOL_NAME_NOTE =
  "Note: skills are often written for Claude Code. Its tool names map to opengate's: Bash→shell, Read→read_file, Write→write_file, Edit→edit_file, Glob→glob, Grep→grep. Paths in the skill are relative to its folder; run its scripts with the shell tool from the skill's folder (cd there first, or use absolute paths).";

export function loadSkillText(s: Skill): string {
  const { body } = parseFrontmatter(readFileSync(s.file, "utf8"));
  const { files, more } = skillFiles(s.dir);
  return [
    `Skill: ${s.name}`,
    `Folder: ${s.dir}`,
    TOOL_NAME_NOTE,
    "",
    body.trim(),
    "",
    `Files in ${s.dir}:`,
    ...files.map((f) => `- ${f}`),
    ...(more ? [`(more files not listed; use glob in ${s.dir})`] : []),
  ].join("\n");
}

export const skillTool: Tool = {
  spec: {
    name: "skill",
    description:
      "Load a skill's full instructions by name (see the Skills section of the system prompt). Call it when the task matches a skill's description, before starting the work. Returns the instructions, the skill's folder and the files in it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name, as listed" } },
      required: ["name"],
    },
  },
  kind: "read",
  parallel: true,
  asks: () => false,
  title: (i) => `Load skill ${String(i?.name ?? "")}`,
  paths: () => [],
  async run(i, ctx) {
    const s = findSkill(ctx.cwd, i?.name);
    if (!s) {
      const names = discoverSkills(ctx.cwd).map((x) => x.name);
      return { output: `There is no skill called "${String(i?.name ?? "")}". Available: ${names.length ? cut(names.join(", "), 2000) : "none"}.`, isError: true };
    }
    let output: string;
    try {
      output = loadSkillText(s);
    } catch (e) {
      return { output: `Couldn't read ${s.file}: ${(e as Error).message}`, isError: true };
    }
    ctx.ui?.event?.({ type: "skill", action: "loaded", name: s.name });
    return { output: output.length > 100_000 ? output.slice(0, 100_000) + "\n[… cut; read the rest of SKILL.md with read_file]" : output };
  },
};

// ---------------- registration ----------------

registerPromptSection({
  name: "skills",
  order: 50,
  render: (session: Session) => renderSkillsSection(discoverSkills(session.data.cwd)),
});

registerToolProvider({
  name: "skills",
  tools: (session: Session) => (discoverSkills(session.data.cwd).length ? [skillTool] : []),
});

registerCommand({
  name: "skills",
  description: "List the skills the agent can load",
  args: "[name]",
  run({ session, args, print }) {
    const skills = discoverSkills(session.data.cwd);
    if (args) {
      const s = findSkill(session.data.cwd, args);
      print(s ? `${s.name} (${s.scope}, ${s.source})\n${s.dir}\n\n${s.description}` : `No skill called "${args}".`);
      return;
    }
    if (!skills.length) {
      print(
        "No skills found. Put a folder with a SKILL.md in .opengate/skills (this project), " +
          `${tilde(join(configDir(), "skills"))} (you), or the Claude Code / Codex skill folders (~/.claude/skills, ~/.codex/skills, ~/.agents/skills).`,
      );
      return;
    }
    const lines = skills.map((s) => `- ${s.name}  (${s.source}) ${cut(s.description, 100)}`);
    print(`${skills.length} skill${skills.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
  },
});
