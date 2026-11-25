import type { ToolCallInfo } from "../agent";
import type { Diff, ToolResult } from "../tools";
import { diffView, type DiffView } from "./diff";
import { stripAnsi } from "./theme";

/** What a finished tool call row shows under its title. */
export interface ToolSummary {
  lines: string[];
  error: boolean;
  /** output lines not shown (Ctrl+O shows everything) */
  hidden: number;
  diff?: DiffView;
  /** for Ctrl+O */
  full?: string;
  fullDiff?: Diff;
}

const clean = (s: string) => stripAnsi(s).replace(/\r/g, "").replace(/\t/g, "  ");

export function summarizeTool(call: ToolCallInfo, r: ToolResult, maxLines = 4, maxDiff = 24): ToolSummary {
  const out = clean(r.output ?? "").replace(/\n+$/, "");
  const lines = out ? out.split("\n") : [];
  if (r.diff && !r.isError) {
    const diff = diffView(r.diff, maxDiff);
    return { lines: [lines[0] ?? ""], error: false, hidden: 0, diff, ...(diff.hidden ? { fullDiff: r.diff } : {}) };
  }
  if (call.kind === "execute") {
    const last = lines[lines.length - 1] ?? "";
    const body = /^exit code: /.test(last) ? lines.slice(0, -1) : [...lines];
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const shown = body.slice(-maxLines);
    const res = shown.length ? [...shown] : ["(no output)"];
    const code = r.exitCode;
    if (code !== 0 && code !== undefined) res.push(`exit code ${code ?? "none"}`);
    return { lines: res, error: !!r.isError, hidden: body.length - shown.length, ...(body.length > shown.length ? { full: out } : {}) };
  }
  if (r.isError) {
    const shown = lines.slice(0, maxLines);
    return { lines: shown, error: true, hidden: lines.length - shown.length, ...(lines.length > shown.length ? { full: out } : {}) };
  }
  if (call.kind === "read") {
    const n = lines.filter((l) => /^\s*\d+\t|^\s*\d+\s/.test(l)).length || lines.length;
    return { lines: [`Read ${n} line${n === 1 ? "" : "s"}`], error: false, hidden: 0 };
  }
  if (call.kind === "search") {
    if (out === "No matches." || out === "No files found." || !out) return { lines: [out || "No results."], error: false, hidden: 0 };
    const shown = lines.slice(0, 3);
    return { lines: [`${lines.length} result${lines.length === 1 ? "" : "s"}`, ...shown], error: false, hidden: lines.length - shown.length, ...(lines.length > shown.length ? { full: out } : {}) };
  }
  const body = lines.filter((l) => l.trim());
  const shown = body.slice(0, maxLines);
  return { lines: shown.length ? shown : ["Done"], error: false, hidden: body.length - shown.length, ...(body.length > shown.length ? { full: out } : {}) };
}

/** The command line to show under a shell call's title (when the title is a description). */
export function commandLine(call: ToolCallInfo): string | null {
  if (call.kind !== "execute" || typeof call.input?.command !== "string") return null;
  const cmd = String(call.input.command);
  const first = cmd.split("\n")[0];
  if (call.title === `Run ${first.slice(0, 80)}` && !cmd.includes("\n")) return null;
  return cmd.length > 300 ? cmd.slice(0, 300) + "…" : cmd;
}
