import type { ToolCallInfo } from "./agent";
import type { Mode } from "./config";
import { registerCommand, registerPermissionPolicy, type CommandIO, type PermissionPolicy, type PermissionRequest, type PermissionVerdict } from "./ext";
import { HARD_BLOCKS, hardBlock, safeCommand, safeEdit } from "./guard/blocks";
import { DEFAULT_GUARD_MODEL, reviewWithModel } from "./guard/model";
import { matchRules, type Subject } from "./guard/rules";
import { toolByName, type Tool } from "./tools";

/**
 * The safety guard: a permission policy that runs in every mode.
 *   1. permissions.deny rules → deny          (every mode)
 *   2. permissions.allow rules → allow        (every mode; also overrides the built-in blocks)
 *   3. built-in hard blocks → deny            (every mode, yolo included)
 *   4. auto mode only: fast paths → allow (read-only commands, edits inside the project),
 *      otherwise the guard model decides allow / ask / deny. Failures become "ask".
 * Subagents and MCP tools go through the same engine, so they're covered too.
 *
 * The guard can be turned off (config `guard: false`, or `/guard off` for one session): then only
 * the person's own permissions rules apply, in every mode. In auto mode that means everything else
 * asks; for no prompts and no checks at all, use yolo mode with the guard off.
 */

export { HARD_BLOCKS, hardBlock, safeCommand, safeEdit } from "./guard/blocks";
export { parseGuardReply, guardSettings, buildReview, DEFAULT_GUARD_MODEL } from "./guard/model";
export { matchRules } from "./guard/rules";

export type Stage = "deny-rule" | "allow-rule" | "hard-block" | "fast-path" | "model" | "off" | "none";
export interface GuardResult {
  verdict: PermissionVerdict | null;
  stage: Stage;
}

const CACHE_KEY = "guard.cache";
const ENABLED_KEY = "guard.enabled";

/** Whether the guard is on for this session: `/guard on|off` wins, then config `guard`, then on. */
export function guardEnabled(session: PermissionRequest["session"]): boolean {
  const v = session.runtime.get(ENABLED_KEY);
  return typeof v === "boolean" ? v : session.cfg.guard !== false;
}
export function setGuardEnabled(session: PermissionRequest["session"], on: boolean): void {
  session.runtime.set(ENABLED_KEY, on);
}
const CACHE_MAX = 500;

/** The shell command a call would run, if it is a command-running tool. */
export function commandOf(call: Pick<ToolCallInfo, "name" | "input">, tool?: Pick<Tool, "kind">): string | null {
  const c = call.input?.command;
  if (typeof c !== "string") return null;
  return tool?.kind === "execute" || /shell|bash|powershell|terminal|exec|command|run/i.test(call.name) ? c : null;
}

function subjectOf(call: ToolCallInfo, tool: Tool | undefined, cwd: string): Subject {
  const command = commandOf(call, tool);
  if (command !== null) return { type: "command", command };
  if (call.paths?.length) return { type: "paths", paths: call.paths, cwd };
  return { type: "other", input: call.input };
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
    .join(",")}}`;
}

async function cachedReview(req: PermissionRequest): Promise<PermissionVerdict> {
  const rt = req.session.runtime;
  let cache = rt.get(CACHE_KEY) as Map<string, Promise<{ verdict: PermissionVerdict; ok: boolean }>> | undefined;
  if (!cache) rt.set(CACHE_KEY, (cache = new Map()));
  const key = `${req.call.name}\u0000${stable(req.call.input)}`;
  let p = cache.get(key);
  if (!p) {
    p = reviewWithModel(req);
    cache.set(key, p);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  const r = await p;
  if (!r.ok) cache.delete(key); // failures are retried next time
  return r.verdict;
}

/**
 * Decide on one call. `mode` overrides the session's mode; `model: false` skips the model
 * (dry runs outside auto mode); `cache: false` skips the per-session verdict cache.
 */
export async function evaluate(req: PermissionRequest, opts: { mode?: Mode; model?: boolean; cache?: boolean } = {}): Promise<GuardResult> {
  const { session, call, tool } = req;
  const cwd = session.data.cwd;
  const mode = opts.mode ?? session.data.mode;
  const perms = session.cfg.permissions ?? {};
  const subject = subjectOf(call, tool, cwd);

  const deny = matchRules(perms.deny, call.name, subject, "deny");
  if (deny) return { verdict: { decision: "deny", reason: `matches your deny rule "${deny.rule}"`, by: "guard" }, stage: "deny-rule" };
  const allow = matchRules(perms.allow, call.name, subject, "allow");
  if (allow) return { verdict: { decision: "allow", reason: `matches your allow rule "${allow.rule}"`, by: "guard" }, stage: "allow-rule" };
  if (!guardEnabled(session)) return { verdict: null, stage: "off" };
  if (subject.type === "command") {
    const b = hardBlock(subject.command, cwd);
    if (b) return { verdict: { decision: "deny", reason: `${b.reason} (built-in block; a permissions.allow rule can override it)`, by: "guard" }, stage: "hard-block" };
  }
  if (mode !== "auto") return { verdict: null, stage: "none" };

  const fast = subject.type === "command" ? safeCommand(subject.command) : call.name === "edit_file" || call.name === "write_file" ? safeEdit(call.paths, cwd) : null;
  if (fast) return { verdict: { decision: "allow", reason: fast, by: "guard" }, stage: "fast-path" };
  if (opts.model === false) return { verdict: null, stage: "none" };
  const verdict = opts.cache === false ? (await reviewWithModel(req)).verdict : await cachedReview(req);
  return { verdict, stage: "model" };
}

export const guardPolicy: PermissionPolicy = {
  name: "guard",
  decide: async (req) => (await evaluate(req)).verdict,
};

// ---------------- /guard ----------------

const MODE_TEXT: Record<Mode, string> = {
  ask: "asks before edits and commands",
  edits: "edits freely, asks before commands",
  auto: "the guard decides: safe actions run, risky ones ask, dangerous ones are blocked",
  yolo: "never asks; deny rules and built-in blocks still apply",
};

const STAGE_TEXT: Record<Stage, string> = {
  "deny-rule": "deny rule",
  "allow-rule": "allow rule",
  "hard-block": "built-in block",
  "fast-path": "fast path",
  model: "guard model",
  off: "guard off",
  none: "no rule or block",
};

function effect(r: GuardResult, mode: Mode): string {
  if (r.verdict?.decision === "deny") return "blocked (in every mode)";
  if (mode === "yolo") return "runs without asking";
  if (mode === "auto") return r.verdict?.decision === "allow" ? "runs without asking" : "asks you first";
  return `asks you first (${mode} mode)`;
}

async function guardCommand({ session, args, print }: CommandIO): Promise<void> {
  const mode = session.data.mode;
  const model = session.cfg.guardModel || DEFAULT_GUARD_MODEL;
  const sw = /^(on|off)$/i.exec(args.trim());
  if (sw) {
    const on = sw[1].toLowerCase() === "on";
    setGuardEnabled(session, on);
    return print(
      on
        ? "Safety guard on for this session: built-in blocks apply in every mode, and auto mode reviews actions."
        : `Safety guard off for this session: no built-in blocks, no review; only your permissions rules apply.${mode === "yolo" ? " In yolo mode nothing asks now." : mode === "auto" ? " In auto mode everything else will ask; use yolo mode for no prompts." : ""}`,
    );
  }
  const m = /^test(?:\s+([\s\S]*))?$/i.exec(args);
  if (m) {
    const command = (m[1] ?? "").trim();
    if (!command) return print("Usage: /guard test <shell command>  (dry run; the command is never run)");
    const tool = toolByName.get("shell")!;
    const input = { command };
    let title = `Run ${command}`;
    try {
      title = tool.title(input, session.data.cwd);
    } catch {}
    const call: ToolCallInfo = { id: "guard-test", name: "shell", input, title, kind: tool.kind, paths: [] };
    const r = await evaluate({ session, call, tool, diff: null }, { mode: "auto", model: mode === "auto", cache: false });
    const lines = [`Command: ${command}`, "(dry run: nothing was executed)"];
    if (r.verdict) lines.push(`Verdict: ${r.verdict.decision} (${STAGE_TEXT[r.stage]}${r.stage === "model" ? `, ${model}` : ""}): ${r.verdict.reason ?? ""}`);
    else if (r.stage === "off") lines.push("Verdict: none (the guard is off; only your permissions rules apply)");
    else lines.push(`Verdict: none (${mode === "auto" ? "no rule or block" : "no rule, block or fast path; the guard model only runs in auto mode"})`);
    const real = mode === "auto" ? r : r.stage === "fast-path" ? { verdict: null, stage: "none" as const } : r;
    lines.push(`In ${mode} mode: ${effect(real, mode)}`);
    if (mode !== "auto" && r.stage === "fast-path") lines.push("In auto mode it would run without asking (fast path).");
    return print(lines.join("\n"));
  }
  if (args.trim()) return print("Usage: /guard, /guard on, /guard off, or /guard test <shell command>");
  const on = guardEnabled(session);
  const perms = session.cfg.permissions ?? {};
  const list = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `  - ${x}`).join("\n") : "  (none)");
  print(
    [
      `Guard: ${on ? "on" : "off"}${on ? "" : " (only your permissions rules apply; /guard on to turn it back on)"}${session.cfg.guard === false ? " (config default: off)" : ""}`,
      `Mode: ${mode}: ${MODE_TEXT[mode] ?? ""}`,
      `Guard model: ${model}${mode === "auto" ? "" : " (used in auto mode only)"}`,
      `Deny rules (every mode):\n${list(perms.deny)}`,
      `Allow rules (override the built-in blocks):\n${list(perms.allow)}`,
      `Built-in blocks (every mode, yolo included):\n${HARD_BLOCKS.map((b) => `  - ${b.what}`).join("\n")}`,
      "Fast paths (auto mode, no model call): read-only and routine commands (ls, cat, git status/diff/log/show, tests, lint, build, tsc --noEmit…) without ; && | > or $( ), and edits to non-secret files inside the project.",
      'Rules go in config.json, e.g. "permissions": { "deny": ["shell:git push*"], "allow": ["shell:make deploy-staging"] }.',
      "Dry run: /guard test <shell command>. Switch for this session: /guard off, /guard on (yolo + /guard off = no prompts and no checks).",
    ].join("\n"),
  );
}

registerPermissionPolicy(guardPolicy);
registerCommand({
  name: "guard",
  description: "Safety guard: show the mode, model and rules; /guard on|off; /guard test <command> dry-runs a command",
  args: "[on|off|test <command>]",
  run: guardCommand,
});
