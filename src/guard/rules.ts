import { homedir } from "node:os";
import { relative } from "node:path";
import { coreWords, levels, norm, parseShell } from "./shell";

/**
 * Permission rules from config: "<tool>:<glob>" or just "<tool glob>".
 * - shell: the glob matches the command (trimmed, whitespace collapsed). A deny rule also matches
 *   any single command inside a chain or a nested bash -c "…" (with sudo/env stripped). An allow
 *   rule must cover the whole line, and its * never crosses ; & | < > ( ) or backticks, so
 *   "shell:git status*" doesn't allow "git status; rm -rf ~".
 * - file tools: the glob matches the absolute or the cwd-relative path (** crosses folders).
 * - other tools (mcp__…): by name; a glob after ":" matches the input as JSON.
 */

export type Subject = { type: "command"; command: string } | { type: "paths"; paths: string[]; cwd: string } | { type: "other"; input: unknown };

const caseless = process.platform === "win32" || process.platform === "darwin";
const esc = (c: string) => c.replace(/[.+^$|\\()[\]{}]/g, "\\$&");

function nameRegex(glob: string): RegExp {
  return new RegExp(`^${glob.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : esc(c))).join("")}$`);
}

/** Glob for commands: * and ? only; `safe` keeps * from crossing shell operators. */
export function commandRegex(glob: string, safe: boolean, flags = ""): RegExp {
  const star = safe ? "[^;&|<>()`\\n\\r]*" : "[\\s\\S]*";
  const one = safe ? "[^;&|<>()`\\n\\r]" : "[\\s\\S]";
  return new RegExp(`^${norm(glob).split("").map((c) => (c === "*" ? star : c === "?" ? one : esc(c))).join("")}$`, flags);
}

/** Glob for paths: ** crosses folders, * and ? stay within one, {a,b} and [abc] work. */
export function pathRegex(glob: string, flags = ""): RegExp {
  let g = glob.trim().replace(/\\/g, "/");
  if (g === "~" || g.startsWith("~/")) g = homedir().replace(/\\/g, "/") + g.slice(1);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const e = g.indexOf("}", i);
      if (e < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, e).split(",").map((s) => s.split("").map((x) => (x === "*" ? "[^/]*" : x === "?" ? "[^/]" : esc(x))).join("")).join("|")})`;
        i = e;
      }
    } else if (c === "[") {
      const e = g.indexOf("]", i);
      if (e < 0) re += "\\[";
      else {
        re += `[${g.slice(i + 1, e).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = e;
      }
    } else re += esc(c);
  }
  return new RegExp(`^${re}$`, flags);
}

interface Rule {
  source: string;
  tool: RegExp;
  glob: string | null;
}

function parseRule(r: string): Rule | null {
  if (typeof r !== "string" || !r.trim()) return null;
  const s = r.trim();
  const i = s.indexOf(":");
  const tool = i < 0 ? s : s.slice(0, i);
  const glob = i < 0 ? null : s.slice(i + 1);
  if (!tool) return null;
  return { source: s, tool: nameRegex(tool), glob: glob === null || glob.trim() === "" || glob.trim() === "*" || glob.trim() === "**" ? null : glob };
}

/** Every single command a deny rule is checked against: the line, each part, each nested script, with and without sudo/env. */
function denyCandidates(command: string): string[] {
  const out = new Set<string>([norm(command)]);
  for (const lv of levels(command)) {
    out.add(norm(lv.script));
    for (const c of lv.parsed.cmds) {
      out.add(c.raw);
      out.add(norm(coreWords(c.words).map((w) => w.text).join(" ")));
      out.add(norm(c.words.map((w) => w.text).join(" ")));
    }
  }
  out.delete("");
  return [...out];
}

function pathCandidates(paths: string[], cwd: string): string[] {
  const out: string[] = [];
  for (const p of paths) {
    out.push(p.replace(/\\/g, "/"));
    const r = relative(cwd, p);
    if (r) out.push(r.replace(/\\/g, "/"));
  }
  return out;
}

function subjectMatches(rule: Rule, s: Subject, kind: "allow" | "deny"): boolean {
  if (rule.glob === null) return true;
  if (s.type === "command") {
    if (kind === "deny") {
      const re = commandRegex(rule.glob, false, "i");
      return denyCandidates(s.command).some((c) => re.test(c));
    }
    return false; // allow rules for commands are matched as a set; see matchAllowCommand
  }
  if (s.type === "paths") {
    const re = pathRegex(rule.glob, kind === "deny" || caseless ? "i" : "");
    return s.paths.length > 0 && pathCandidates(s.paths, s.cwd).some((c) => re.test(c));
  }
  let json = "";
  try {
    json = JSON.stringify(s.input) ?? "";
  } catch {}
  return commandRegex(rule.glob, false, kind === "deny" ? "i" : "").test(norm(json));
}

/** An allow rule set covers a command if one rule covers the whole line, or every part is covered by some rule. */
function matchAllowCommand(rules: Rule[], command: string): Rule | null {
  const flags = caseless ? "i" : "";
  const whole = norm(command);
  const cover = (text: string) => rules.find((r) => r.glob === null || commandRegex(r.glob, true, flags).test(text)) ?? null;
  const hit = cover(whole);
  if (hit) return hit;
  const { cmds, subs } = parseShell(command);
  if (cmds.length < 2 || subs.length) return null;
  let first: Rule | null = null;
  for (const c of cmds) {
    const r = cover(c.raw);
    if (!r) return null;
    first ??= r;
  }
  return first;
}

export interface RuleHit {
  rule: string;
}

export function matchRules(patterns: string[] | undefined, toolName: string, subject: Subject, kind: "allow" | "deny"): RuleHit | null {
  const rules = (Array.isArray(patterns) ? patterns : []).map(parseRule).filter((r): r is Rule => !!r && r.tool.test(toolName));
  if (!rules.length) return null;
  if (kind === "allow" && subject.type === "command") {
    const r = matchAllowCommand(rules, subject.command);
    return r ? { rule: r.source } : null;
  }
  const r = rules.find((x) => subjectMatches(x, subject, kind));
  return r ? { rule: r.source } : null;
}
