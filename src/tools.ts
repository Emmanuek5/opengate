import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Mode } from "./config";
import type { ToolSpec } from "./types";

export type ToolKind = "read" | "edit" | "search" | "execute" | "other";

export interface ToolCtx {
  cwd: string;
  signal?: AbortSignal;
  /** the running session (gateway, config, history); absent in isolated tool tests */
  session?: import("./agent").Session;
  /** the front end, for events (see ext.ts AgentEvent) */
  ui?: import("./agent").AgentUI;
  /** this tool call's id */
  callId?: string;
  /** files read this session, with the mtime seen, so edits never overwrite unseen changes */
  readFiles: Map<string, number>;
}

export interface Diff {
  path: string;
  oldText: string | null;
  newText: string;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  diff?: Diff;
  /** shell commands: the exit code */
  exitCode?: number | null;
}

export interface Tool {
  spec: ToolSpec;
  kind: ToolKind;
  /**
   * Whether this tool changes things, so needs the person's OK in this mode ("ask" / "edits").
   * In "auto" mode a tool that asks in "ask" mode goes to the permission policy (the safety guard);
   * in "yolo" mode nothing asks.
   */
  asks(mode: Mode): boolean;
  /** safe to run at the same time as other parallel tools from the same turn (read-only tools, subagents) */
  parallel?: boolean;
  title(input: any, cwd: string): string;
  paths(input: any, cwd: string): string[];
  /** what an edit would change, shown when asking */
  preview?(input: any, ctx: ToolCtx): Diff | null;
  run(input: any, ctx: ToolCtx): Promise<ToolResult>;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo"]);
const MAX_OUT = 30_000;

export const isWin = process.platform === "win32";

function abs(p: unknown, cwd: string): string {
  const s = String(p ?? "").trim();
  if (!s) throw new Error("path is required");
  const expanded = s.startsWith("~/") || s.startsWith("~\\") ? join(process.env.HOME ?? process.env.USERPROFILE ?? "", s.slice(2)) : s;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function shown(p: string, cwd: string): string {
  const r = relative(cwd, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

function clip(s: string, max = MAX_OUT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[… ${s.length - max} characters cut …]\n\n${s.slice(-half)}`;
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

// ---------------- read ----------------

const readFile: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a text file. Returns lines with line numbers (number, tab, text). Use offset (1-based line) and limit for large files; by default reads up to 2000 lines. Read a file before editing it.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, or relative to the working directory" },
        offset: { type: "integer", description: "First line to read (1-based)" },
        limit: { type: "integer", description: "Number of lines to read" },
      },
      required: ["path"],
    },
  },
  kind: "read",
  parallel: true,
  asks: () => false,
  title: (i, cwd) => `Read ${shown(abs(i.path, cwd), cwd)}`,
  paths: (i, cwd) => [abs(i.path, cwd)],
  async run(i, ctx) {
    const p = abs(i.path, ctx.cwd);
    if (!existsSync(p)) return { output: `No such file: ${p}`, isError: true };
    const st = statSync(p);
    if (st.isDirectory()) return { output: `${p} is a directory. Use glob to list files.`, isError: true };
    const buf = readFileSync(p);
    if (isBinary(buf)) return { output: `${p} looks like a binary file (${st.size} bytes); not shown.`, isError: true };
    ctx.readFiles.set(p, st.mtimeMs);
    const lines = buf.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, Math.floor(Number(i.offset) || 1));
    const limit = Math.max(1, Math.min(Math.floor(Number(i.limit) || 2000), 5000));
    const slice = lines.slice(start - 1, start - 1 + limit);
    if (!slice.length) return { output: `(the file has ${lines.length} lines; nothing at line ${start})` };
    const width = String(start + slice.length - 1).length;
    let out = slice.map((l, n) => `${String(start + n).padStart(width)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
    const rest = lines.length - (start - 1 + slice.length);
    if (rest > 0) out += `\n\n(${rest} more lines; read on with offset ${start + slice.length})`;
    return { output: clip(out, 100_000) };
  },
};

// ---------------- write / edit ----------------

function checkFresh(p: string, ctx: ToolCtx): string | null {
  if (!existsSync(p)) return null;
  const seen = ctx.readFiles.get(p);
  if (seen === undefined) return `Read ${p} before changing it.`;
  if (statSync(p).mtimeMs !== seen) return `${p} changed since you read it. Read it again first.`;
  return null;
}

const writeFile: Tool = {
  spec: {
    name: "write_file",
    description: "Create a file, or replace a whole file you have read. Parent directories are created. Prefer edit_file for changes to existing files.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string", description: "The full new file content" } },
      required: ["path", "content"],
    },
  },
  kind: "edit",
  asks: (mode) => mode === "ask",
  title: (i, cwd) => `Write ${shown(abs(i.path, cwd), cwd)}`,
  paths: (i, cwd) => [abs(i.path, cwd)],
  preview(i, ctx) {
    const p = abs(i.path, ctx.cwd);
    return { path: p, oldText: existsSync(p) ? readFileSync(p, "utf8") : null, newText: str(i.content) };
  },
  async run(i, ctx) {
    const p = abs(i.path, ctx.cwd);
    const stale = checkFresh(p, ctx);
    if (stale) return { output: stale, isError: true };
    const old = existsSync(p) ? readFileSync(p, "utf8") : null;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, str(i.content));
    ctx.readFiles.set(p, statSync(p).mtimeMs);
    const lines = str(i.content).split("\n").length;
    return { output: `${old === null ? "Created" : "Wrote"} ${p} (${lines} lines)`, diff: { path: p, oldText: old, newText: str(i.content) } };
  },
};

/** The edit applied to the text, or an error message. Keeps the file's line endings. */
export function applyEdit(text: string, oldS: string, newS: string, all: boolean): { text: string; count: number } | string {
  if (!oldS) return "old_string must not be empty (use write_file to create a file).";
  if (oldS === newS) return "old_string and new_string are the same.";
  let o = oldS;
  let n = newS;
  if (text.includes("\r\n") && !o.includes("\r\n")) {
    o = o.replace(/\n/g, "\r\n");
    n = n.replace(/\r?\n/g, "\r\n");
  }
  const count = text.split(o).length - 1;
  if (count === 0) return "old_string was not found in the file. Read the file again and copy the exact text, including whitespace.";
  if (count > 1 && !all) return `old_string appears ${count} times. Give more surrounding text to make it unique, or set replace_all.`;
  return { text: all ? text.split(o).join(n) : text.replace(o, () => n), count };
}

const editFile: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace exact text in a file you have read. old_string must match the file exactly (whitespace included) and be unique unless replace_all is set. Don't include the line-number prefixes from read_file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  kind: "edit",
  asks: (mode) => mode === "ask",
  title: (i, cwd) => `Edit ${shown(abs(i.path, cwd), cwd)}`,
  paths: (i, cwd) => [abs(i.path, cwd)],
  preview(i, ctx) {
    const p = abs(i.path, ctx.cwd);
    if (!existsSync(p)) return null;
    const old = readFileSync(p, "utf8");
    const r = applyEdit(old, str(i.old_string), str(i.new_string), !!i.replace_all);
    return typeof r === "string" ? null : { path: p, oldText: old, newText: r.text };
  },
  async run(i, ctx) {
    const p = abs(i.path, ctx.cwd);
    if (!existsSync(p)) return { output: `No such file: ${p}. Use write_file to create it.`, isError: true };
    const stale = checkFresh(p, ctx);
    if (stale) return { output: stale, isError: true };
    const old = readFileSync(p, "utf8");
    const r = applyEdit(old, str(i.old_string), str(i.new_string), !!i.replace_all);
    if (typeof r === "string") return { output: r, isError: true };
    writeFileSync(p, r.text);
    ctx.readFiles.set(p, statSync(p).mtimeMs);
    return { output: `Edited ${p}${r.count > 1 ? ` (${r.count} places)` : ""}`, diff: { path: p, oldText: old, newText: r.text } };
  },
};

// ---------------- search ----------------

function walk(dir: string, visit: (file: string) => boolean | void, depth = 0): boolean {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || depth > 40) continue;
      if (walk(join(dir, e.name), visit, depth + 1)) return true;
    } else if (e.isFile() && visit(join(dir, e.name)) === true) return true;
  }
  return false;
}

const glob: Tool = {
  spec: {
    name: "glob",
    description: 'Find files by glob pattern, e.g. "**/*.ts" or "src/**/test*". Newest first. Skips .git, node_modules and build folders.',
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string", description: "Folder to search (default: working directory)" } },
      required: ["pattern"],
    },
  },
  kind: "search",
  parallel: true,
  asks: () => false,
  title: (i) => `Find ${str(i.pattern)}`,
  paths: (i, cwd) => [i.path ? abs(i.path, cwd) : cwd],
  async run(i, ctx) {
    const base = i.path ? abs(i.path, ctx.cwd) : ctx.cwd;
    const g = new Bun.Glob(str(i.pattern) || "**/*");
    const found: { p: string; t: number }[] = [];
    for (const rel of g.scanSync({ cwd: base, onlyFiles: true, dot: false })) {
      if (rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue;
      const p = join(base, rel);
      let t = 0;
      try {
        t = statSync(p).mtimeMs;
      } catch {}
      found.push({ p, t });
      if (found.length >= 5000) break;
    }
    if (!found.length) return { output: "No files found." };
    found.sort((a, b) => b.t - a.t);
    const list = found.slice(0, 200).map((f) => shown(f.p, ctx.cwd));
    return { output: list.join("\n") + (found.length > 200 ? `\n(${found.length - 200} more; narrow the pattern)` : "") };
  },
};

let rgPath: string | null | undefined;
const rg = () => (rgPath === undefined ? (rgPath = Bun.which("rg")) : rgPath);

const grep: Tool = {
  spec: {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns matching lines as path:line:text, or just file paths with files_only. Use glob to limit file types (e.g. \"*.ts\").",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or folder (default: working directory)" },
        glob: { type: "string", description: "Only files matching this glob" },
        ignore_case: { type: "boolean" },
        files_only: { type: "boolean", description: "List matching files instead of lines" },
      },
      required: ["pattern"],
    },
  },
  kind: "search",
  parallel: true,
  asks: () => false,
  title: (i) => `Search for ${str(i.pattern)}`,
  paths: (i, cwd) => [i.path ? abs(i.path, cwd) : cwd],
  async run(i, ctx) {
    const base = i.path ? abs(i.path, ctx.cwd) : ctx.cwd;
    const pattern = str(i.pattern);
    if (!pattern) return { output: "pattern is required", isError: true };
    const bin = rg();
    if (bin) {
      const args = ["--no-heading", "--line-number", "--color", "never", "--max-columns", "400", "--max-count", "200"];
      if (i.ignore_case) args.push("-i");
      if (i.files_only) args.push("-l");
      if (i.glob) args.push("--glob", str(i.glob));
      args.push("--", pattern, base);
      const r = await runProcess(bin, args, ctx.cwd, 60_000, ctx.signal);
      if (r.code === 1 && !r.out.trim()) return { output: "No matches." };
      if (r.code !== 0 && r.code !== 1) return { output: r.out || `rg failed (${r.code})`, isError: true };
      const lines = r.out.split("\n").filter(Boolean);
      return { output: clip(relativize(lines.slice(0, 400).join("\n"), base, ctx.cwd) + (lines.length > 400 ? `\n(${lines.length - 400} more matches)` : ""), 20_000) };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, i.ignore_case ? "i" : "");
    } catch (e) {
      return { output: `Bad regular expression: ${(e as Error).message}`, isError: true };
    }
    const only = i.glob ? new Bun.Glob(str(i.glob)) : null;
    const out: string[] = [];
    const check = (file: string) => {
      if (only && !only.match(relative(base, file)) && !only.match(file.split(/[\\/]/).pop()!)) return;
      let buf: Buffer;
      try {
        if (statSync(file).size > 2_000_000) return;
        buf = readFileSync(file);
      } catch {
        return;
      }
      if (isBinary(buf)) return;
      const lines = buf.toString("utf8").split(/\r?\n/);
      for (let n = 0; n < lines.length; n++) {
        if (!re.test(lines[n])) continue;
        if (i.files_only) {
          out.push(shown(file, ctx.cwd));
          break;
        }
        out.push(`${shown(file, ctx.cwd)}:${n + 1}:${lines[n].slice(0, 400)}`);
        if (out.length >= 400) return true;
      }
      return out.length >= 400;
    };
    if (existsSync(base) && statSync(base).isFile()) check(base);
    else walk(base, check);
    return { output: out.length ? clip(out.join("\n"), 20_000) : "No matches." };
  },
};

function relativize(text: string, base: string, cwd: string): string {
  const prefix = base.endsWith("/") || base.endsWith("\\") ? base : base + (isWin ? "\\" : "/");
  const rel = shown(base, cwd);
  return text
    .split("\n")
    .map((l) => (l.startsWith(prefix) ? (rel === base ? l : join(rel, l.slice(prefix.length))) : l.startsWith(base + ":") ? rel + l.slice(base.length) : l))
    .join("\n");
}

// ---------------- shell ----------------

export function shellCommand(command: string): { file: string; args: string[]; name: string } {
  if (isWin) {
    const pwsh = Bun.which("pwsh");
    return { file: pwsh ?? "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], name: pwsh ? "PowerShell 7" : "Windows PowerShell" };
  }
  const bash = Bun.which("bash");
  return { file: bash ?? "/bin/sh", args: ["-c", command], name: bash ? "bash" : "sh" };
}

export function runProcess(file: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ out: string; code: number | null; timedOut: boolean; cancelled: boolean }> {
  return new Promise((res) => {
    let out = "";
    let timedOut = false;
    let cancelled = false;
    const child = spawn(file, args, { cwd, env: { ...process.env, OPENGATE: "1", PAGER: "cat", GIT_PAGER: "cat" }, detached: !isWin, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const add = (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 4 * MAX_OUT) out = out.slice(0, MAX_OUT) + "\n[…]\n" + out.slice(-MAX_OUT);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const kill = () => {
      try {
        if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ out: `${out}${e.message}`, code: null, timedOut, cancelled });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      res({ out, code, timedOut, cancelled });
    });
  });
}

const shell = shellCommand("").name;
const bashTool: Tool = {
  spec: {
    name: "shell",
    description: `Run a command with ${shell} in the working directory and return its output (stdout and stderr together) and exit code. Default timeout 2 minutes, at most 10. Commands don't share state between calls except files. Don't start interactive programs or servers that never exit.`,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string", description: "A few words on what the command does, shown to the person" },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds (max 600000)" },
      },
      required: ["command"],
    },
  },
  kind: "execute",
  asks: (mode) => mode !== "yolo",
  title: (i) => str(i.description) || `Run ${str(i.command).split("\n")[0].slice(0, 80)}`,
  paths: () => [],
  async run(i, ctx) {
    const command = str(i.command);
    if (!command.trim()) return { output: "command is required", isError: true };
    const sh = shellCommand(command);
    const timeout = Math.min(Math.max(Number(i.timeout_ms) || 120_000, 1000), 600_000);
    const r = await runProcess(sh.file, sh.args, ctx.cwd, timeout, ctx.signal);
    let output = clip(r.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
    if (r.timedOut) output += `\n(timed out after ${Math.round(timeout / 1000)} s and was stopped)`;
    if (r.cancelled) output += "\n(cancelled)";
    output += `\nexit code: ${r.code ?? "none"}`;
    return { output: output.trim(), isError: r.code !== 0, exitCode: r.code };
  },
};

export const TOOLS: Tool[] = [readFile, editFile, writeFile, glob, grep, bashTool];
export const toolByName = new Map(TOOLS.map((t) => [t.spec.name, t]));
