import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Session } from "./agent";
import { configDir, dataDir, writeAtomic } from "./config";
import { registerCommand, registerPromptSection, registerToolProvider } from "./ext";
import type { Tool, ToolCtx, ToolResult } from "./tools";

/**
 * Persistent memories, in two scopes:
 * - global:  configDir()/memory/
 * - project: dataDir()/projects/<slug>/memory/, where the project is the git root above the cwd
 *   (or the cwd itself).
 * One Markdown file per memory (frontmatter + body) and an index, MEMORY.md, rebuilt on every change.
 */

export type Scope = "project" | "global";
export const SCOPES: Scope[] = ["project", "global"];
export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  /** ISO time of the last change */
  updated: string;
  body: string;
  scope: Scope;
  path: string;
}

export const INDEX_FILE = "MEMORY.md";
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 200;
const MAX_BODY = 20_000;
/** the whole prompt section, guidance included */
const PROMPT_BUDGET = 4000;
// Windows reserves these names even with an extension (con.md); "memory" would clash with MEMORY.md
// on case-insensitive file systems.
const RESERVED = new Set(["memory", "con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])]);

// ---------------- locations ----------------

/** The git root above cwd (a `.git` folder or file), or cwd itself. */
export function projectRoot(cwd: string): string {
  const start = resolve(cwd);
  let d = start;
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return start;
}

/**
 * A readable, stable folder name for a project root: the path with separators turned into dashes,
 * plus a short hash of the full path so similar paths never share a folder. Windows paths are
 * compared case-insensitively.
 */
export function projectSlug(root: string, platform: string = process.platform): string {
  let p = root.replace(/[\\/]+$/, "") || root;
  if (platform === "win32") p = p.replace(/\//g, "\\").toLowerCase();
  const hash = createHash("sha256").update(p).digest("hex").slice(0, 8);
  let readable = p
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (readable.length > 60) readable = readable.slice(-60).replace(/^[-.]+/, "");
  return `${readable || "root"}-${hash}`;
}

export const globalMemoryDir = (): string => join(configDir(), "memory");
export const projectMemoryDir = (cwd: string): string => join(dataDir(), "projects", projectSlug(projectRoot(cwd)), "memory");
export const memoryDir = (scope: Scope, cwd: string): string => (scope === "global" ? globalMemoryDir() : projectMemoryDir(cwd));

// ---------------- validation ----------------

/** Why a name is not allowed, or null if it is fine. */
export function nameError(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "a name is required";
  if (name.length > MAX_NAME) return `the name is longer than ${MAX_NAME} characters`;
  if (!NAME_RE.test(name)) return `"${name}" is not a kebab-case name (lowercase letters, digits and single dashes, e.g. "prefers-bun")`;
  if (RESERVED.has(name)) return `"${name}" is a reserved name`;
  return null;
}

/** The file for a memory; throws on a bad name or anything that would land outside the folder. */
export function memoryFile(dir: string, name: string): string {
  const err = nameError(name);
  if (err) throw new Error(err);
  const p = resolve(dir, `${name}.md`);
  const rel = relative(resolve(dir), p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || /[\\/]/.test(rel)) throw new Error(`refusing to use a path outside ${dir}`);
  return p;
}

const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
/** A rough check for keys and tokens, which must never be saved. */
export const looksSecret = (text: string): boolean => SECRET_RES.some((r) => r.test(text));

const oneLine = (s: string, max = MAX_DESCRIPTION): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};
const isType = (t: unknown): t is MemoryType => MEMORY_TYPES.includes(t as MemoryType);
const isScope = (s: unknown): s is Scope => SCOPES.includes(s as Scope);

// ---------------- files ----------------

function parse(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { meta: {}, body: t.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    meta[line.slice(0, i).trim()] = v;
  }
  return { meta, body: t.slice(m[0].length).trim() };
}

function readFrom(path: string, name: string, scope: Scope): Memory | null {
  try {
    const { meta, body } = parse(readFileSync(path, "utf8"));
    const updated = meta.updated && !Number.isNaN(Date.parse(meta.updated)) ? meta.updated : new Date(statSync(path).mtimeMs).toISOString();
    return { name, description: oneLine(meta.description ?? ""), type: isType(meta.type) ? meta.type : "project", updated, body, scope, path };
  } catch {
    return null;
  }
}

/** All memories in a folder, by name. Files that aren't valid memories are skipped. */
export function listMemories(dir: string, scope: Scope): Memory[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Memory[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".md") || f === INDEX_FILE) continue;
    const name = f.slice(0, -3);
    if (nameError(name)) continue;
    const m = readFrom(join(dir, f), name, scope);
    if (m) out.push(m);
  }
  return out;
}

export function readMemory(dir: string, scope: Scope, name: string): Memory | null {
  const p = memoryFile(dir, name);
  return existsSync(p) ? readFrom(p, name, scope) : null;
}

export interface MemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** defaults to now */
  updated?: string;
}

/** Write (create or replace) a memory and refresh the index. */
export function writeMemory(dir: string, scope: Scope, m: MemoryInput): Memory {
  const path = memoryFile(dir, m.name);
  if (!isType(m.type)) throw new Error(`type must be one of ${MEMORY_TYPES.join(", ")}`);
  const description = oneLine(m.description ?? "");
  if (!description) throw new Error("a one-line description is required");
  const body = String(m.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) throw new Error("the body is empty");
  if (body.length > MAX_BODY) throw new Error(`the body is longer than ${MAX_BODY} characters; keep memories short`);
  if (looksSecret(`${description}\n${body}`)) throw new Error("this looks like it contains a key or token; secrets must never be saved to memory");
  const updated = m.updated ?? new Date().toISOString();
  writeAtomic(path, `---\nname: ${m.name}\ndescription: ${description}\ntype: ${m.type}\nupdated: ${updated}\n---\n\n${body}\n`);
  rebuildIndex(dir, scope);
  return { name: m.name, description, type: m.type, updated, body, scope, path };
}

export function deleteMemory(dir: string, scope: Scope, name: string): boolean {
  const p = memoryFile(dir, name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  rebuildIndex(dir, scope);
  return true;
}

/** MEMORY.md: one line per memory. Rebuilt from the files, so hand edits to them are picked up. */
export function rebuildIndex(dir: string, scope: Scope): void {
  const mems = listMemories(dir, scope);
  const lines = [
    `# ${scope === "global" ? "Global" : "Project"} memories`,
    "",
    "<!-- Maintained by opengate: edit or delete the memory files, not this index. -->",
    "",
    ...(mems.length ? mems.map((m) => `- [${m.name}](${m.name}.md) (${m.type}): ${m.description}`) : ["(none yet)"]),
  ];
  const text = lines.join("\n") + "\n";
  const p = join(dir, INDEX_FILE);
  try {
    if (readFileSync(p, "utf8") === text) return;
  } catch {}
  writeAtomic(p, text);
}

// ---------------- stores for a session ----------------

const cwdOf = (session: Session | undefined, fallback: string) => session?.data.cwd ?? fallback;

/** Both scopes' folders for a working directory. */
export const memoryDirs = (cwd: string): Record<Scope, string> => ({ project: projectMemoryDir(cwd), global: globalMemoryDir() });

/** Find a memory by name, in one scope or (project first) in both. */
function find(cwd: string, name: string, scope?: Scope): Memory[] {
  const dirs = memoryDirs(cwd);
  return (scope ? [scope] : SCOPES).map((s) => readMemory(dirs[s], s, name)).filter((m): m is Memory => !!m);
}

// ---------------- prompt section ----------------

const GUIDANCE = [
  "# Memory",
  "",
  "You have persistent memory across sessions through the `memory` tool. Project memories belong to this project; global memories apply everywhere.",
  "- Save durable, non-obvious things: the person's preferences and corrections (type feedback/user), project decisions and constraints (project), gotchas, and useful references (reference).",
  "- Don't save what the code, docs or git history already show, temporary task state, or anything secret (keys, tokens, passwords).",
  "- Before saving, check the list below: update an existing memory instead of adding a duplicate, and delete ones that turn out wrong.",
  "- Memories may be stale. View the relevant one with the tool before acting on it, and check it against the current code.",
  "- Keep each memory short: a kebab-case name, a one-line description, and a body that says why it matters.",
];

/** The system prompt block: guidance plus both scopes' memories, newest first if it has to cut. */
export function renderMemorySection(cwd: string, budget = PROMPT_BUDGET): string {
  const dirs = memoryDirs(cwd);
  const all = SCOPES.flatMap((s) => listMemories(dirs[s], s));
  const head = GUIDANCE.join("\n");
  if (!all.length) return `${head}\n\nNo memories saved yet.`;
  // Pick what fits, newest first; ties broken by name so the text is stable.
  const ranked = [...all].sort((a, b) => b.updated.localeCompare(a.updated) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  const line = (m: Memory) => `- ${m.name} (${m.type}): ${m.description}`;
  const intro = "\n\nSaved memories (name (type): description):";
  const more = (n: number) => `\n(${n} older memories not shown; use the memory tool's list action.)`;
  let left = budget - head.length - intro.length - more(all.length).length - 40;
  const kept: Memory[] = [];
  for (const m of ranked) {
    const cost = line(m).length + 1;
    if (cost > left) break;
    kept.push(m);
    left -= cost;
  }
  let out = head + intro;
  for (const s of SCOPES) {
    const mine = kept.filter((m) => m.scope === s);
    if (!mine.length) continue;
    out += `\n${s === "project" ? "Project" : "Global"}:\n${mine.map(line).join("\n")}`;
  }
  if (kept.length < all.length) out += more(all.length - kept.length);
  return out;
}

// ---------------- tool ----------------

const ACTIONS = ["list", "view", "save", "update", "delete"] as const;
type Action = (typeof ACTIONS)[number];
const EVENT: Partial<Record<Action, string>> = { save: "saved", update: "updated", delete: "deleted" };

function listText(cwd: string, scope?: Scope, withDates = false): string {
  const dirs = memoryDirs(cwd);
  return (scope ? [scope] : SCOPES)
    .map((s) => {
      const mems = listMemories(dirs[s], s);
      const rows = mems.map((m) => `  - ${m.name} (${m.type})${withDates ? ` [${m.updated.slice(0, 10)}]` : ""}: ${m.description}`);
      return `${s === "project" ? "Project" : "Global"} memories (${dirs[s]}):\n${rows.length ? rows.join("\n") : "  (none)"}`;
    })
    .join("\n\n");
}

const viewText = (m: Memory) => `name: ${m.name}\nscope: ${m.scope}\ntype: ${m.type}\ndescription: ${m.description}\nupdated: ${m.updated}\nfile: ${m.path}\n\n${m.body}`;

const fail = (output: string): ToolResult => ({ output, isError: true });

export const memoryTool: Tool = {
  spec: {
    name: "memory",
    description:
      "Persistent memory across sessions. Actions: list (all memories, optionally one scope); view (name, optional scope); save (scope, name, type, description, body: a new memory); update (name, optional scope, and any of type/description/body to change); delete (name, optional scope). Scope 'project' is this project, 'global' applies everywhere. Never save secrets.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        scope: { type: "string", enum: SCOPES, description: "project (default for save) or global" },
        name: { type: "string", description: "kebab-case, e.g. prefers-small-commits" },
        type: { type: "string", enum: MEMORY_TYPES, description: "user: about the person; feedback: how they want you to work; project: decisions, constraints, gotchas; reference: where to find things" },
        description: { type: "string", description: "one line, used to decide relevance later" },
        body: { type: "string", description: "the memory itself, in Markdown; say why it matters" },
      },
      required: ["action"],
    },
  },
  kind: "other",
  parallel: false,
  asks: () => false,
  title(i, cwd) {
    const a = String(i?.action ?? "");
    if (a === "list") return "Memory: list";
    return `Memory: ${a} ${i?.scope ? `${i.scope}/` : ""}${i?.name ?? ""}`.trim();
  },
  paths(i, cwd) {
    try {
      if (!i?.name || !isScope(i.scope)) return [];
      return [memoryFile(memoryDir(i.scope, cwd), i.name)];
    } catch {
      return [];
    }
  },
  async run(i, ctx: ToolCtx) {
    const cwd = cwdOf(ctx.session, ctx.cwd);
    const action = i?.action as Action;
    if (!ACTIONS.includes(action)) return fail(`action must be one of ${ACTIONS.join(", ")}`);
    if (i.scope != null && i.scope !== "" && !isScope(i.scope)) return fail(`scope must be "project" or "global"`);
    const scope: Scope | undefined = isScope(i.scope) ? i.scope : undefined;
    if (action === "list") return { output: listText(cwd, scope, true) };
    const name = typeof i.name === "string" ? i.name.trim() : "";
    const err = nameError(name);
    if (err) return fail(err);
    const emit = (s: Scope) => ctx.ui?.event?.({ type: "memory", action: EVENT[action], scope: s, name });
    try {
      if (action === "save") {
        const s = scope ?? "project";
        if (find(cwd, name, s).length) return fail(`A ${s} memory called "${name}" already exists. View it and use update instead.`);
        if (!isType(i.type)) return fail(`type must be one of ${MEMORY_TYPES.join(", ")}`);
        const m = writeMemory(memoryDir(s, cwd), s, { name, type: i.type, description: String(i.description ?? ""), body: String(i.body ?? "") });
        emit(s);
        return { output: `Saved ${s} memory "${name}" (${m.path}).` };
      }
      const found = find(cwd, name, scope);
      if (!found.length) return fail(`No ${scope ?? "project or global"} memory called "${name}". Use list to see what exists.`);
      if (action === "view") return { output: found.map(viewText).join("\n\n---\n\n") };
      if (found.length > 1) return fail(`"${name}" exists in both scopes; say which (scope: "project" or "global").`);
      const cur = found[0];
      if (action === "delete") {
        deleteMemory(memoryDir(cur.scope, cwd), cur.scope, name);
        emit(cur.scope);
        return { output: `Deleted ${cur.scope} memory "${name}".` };
      }
      // update
      if (i.type != null && i.type !== "" && !isType(i.type)) return fail(`type must be one of ${MEMORY_TYPES.join(", ")}`);
      const has = (k: string) => typeof i[k] === "string" && i[k].trim() !== "";
      if (!has("type") && !has("description") && !has("body")) return fail("nothing to update: give a new type, description or body");
      writeMemory(memoryDir(cur.scope, cwd), cur.scope, {
        name,
        type: has("type") ? i.type : cur.type,
        description: has("description") ? i.description : cur.description,
        body: has("body") ? i.body : cur.body,
      });
      emit(cur.scope);
      return { output: `Updated ${cur.scope} memory "${name}".` };
    } catch (e) {
      return fail(`Error: ${(e as Error)?.message ?? e}`);
    }
  },
};

// ---------------- /memory command ----------------

const STOP_WORDS = new Set(
  "a an the and or but to of in on at for with by from as is are was were be been it its this that these those we our you your i my me they them their he she do does did not no so if then than there here just also very".split(" "),
);

/** A name, description and type for a quick note, without a model call. */
export function deriveNote(text: string, scope: Scope): { name: string; description: string; type: MemoryType } {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] || clean;
  const words = first
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  let name = "";
  for (const w of words.slice(0, 5)) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 40) break;
    name = next;
  }
  if (!name) name = words[0]?.slice(0, 40) || "note";
  if (nameError(name)) name = `note-${name}`.slice(0, 40).replace(/-+$/, "");
  if (nameError(name)) name = "note";
  const type: MemoryType = /\b(always|never|don'?t|do not|prefer|prefers|please|stop|avoid|instead of)\b/i.test(clean)
    ? "feedback"
    : /https?:\/\/\S+/.test(clean)
      ? "reference"
      : scope === "global"
        ? "user"
        : "project";
  return { name, description: oneLine(first, 120), type };
}

function uniqueName(dir: string, base: string): string {
  if (!existsSync(memoryFile(dir, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!nameError(cand) && !existsSync(memoryFile(dir, cand))) return cand;
  }
  throw new Error("too many memories with this name");
}

const USAGE = [
  "Usage:",
  "  /memory                  list project and global memories",
  "  /memory add <text>       save a project note",
  "  /memory global <text>    save a global note",
  "  /memory show [project|global] <name>",
  "  /memory forget [project|global] <name>",
  "  /memory path             show where memories are kept",
].join("\n");

/** "[project|global] <name>" */
function scopedName(rest: string): { scope?: Scope; name: string } {
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && isScope(parts[0])) return { scope: parts[0], name: parts[1] };
  const m = /^(project|global)[:/](.+)$/.exec(parts[0] ?? "");
  if (m) return { scope: m[1] as Scope, name: m[2] };
  return { name: parts[0] ?? "" };
}

registerCommand({
  name: "memory",
  description: "List, add, show or forget saved memories",
  args: "[add|global|show|forget|path] [text or name]",
  run({ session, args, print, ui }) {
    const cwd = session.data.cwd;
    const dirs = memoryDirs(cwd);
    const sub = args.split(/\s+/)[0] ?? "";
    const rest = args.slice(sub.length).trim();
    try {
      switch (sub.toLowerCase()) {
        case "":
        case "list":
          return print(listText(cwd));
        case "path":
          return print(`Project memories: ${dirs.project}\n  (project root: ${projectRoot(cwd)})\nGlobal memories: ${dirs.global}`);
        case "add":
        case "global": {
          const scope: Scope = sub.toLowerCase() === "global" ? "global" : "project";
          if (!rest) return print(`Give the text to remember, e.g. /memory ${sub} prefer small commits.`);
          const d = deriveNote(rest, scope);
          const name = uniqueName(dirs[scope], d.name);
          writeMemory(dirs[scope], scope, { name, type: d.type, description: d.description, body: rest });
          ui.event?.({ type: "memory", action: "saved", scope, name });
          return print(`Saved ${scope} memory "${name}" (${d.type}).`);
        }
        case "show":
        case "forget": {
          const { scope, name } = scopedName(rest);
          const err = nameError(name);
          if (err) return print(`${err}\n\n${USAGE}`);
          const found = find(cwd, name, scope);
          if (!found.length) return print(`No memory called "${name}". Run /memory to list them.`);
          if (sub.toLowerCase() === "show") return print(found.map(viewText).join("\n\n---\n\n"));
          if (found.length > 1) return print(`"${name}" exists in both scopes: /memory forget project ${name} or /memory forget global ${name}.`);
          deleteMemory(dirs[found[0].scope], found[0].scope, name);
          ui.event?.({ type: "memory", action: "deleted", scope: found[0].scope, name });
          return print(`Forgot ${found[0].scope} memory "${name}".`);
        }
        default:
          return print(USAGE);
      }
    } catch (e) {
      print(`memory: ${(e as Error)?.message ?? e}`);
    }
  },
});

registerToolProvider({ name: "memory", tools: () => [memoryTool] });
registerPromptSection({ name: "memory", order: 60, render: (session) => renderMemorySection(session.data.cwd) });
