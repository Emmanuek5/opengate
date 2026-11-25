import { fullHistory, listSessions, type ListOptions, type SessionFile, type SessionMeta } from "../store";
import { markdownToAnsi } from "./markdown";
import { ago, fg, G, P, st, stripAnsi, tilde } from "./theme";
import { textWidth } from "./markdown";

export type Meta = SessionMeta;

/** Sessions for the picker; never throws (a broken file shouldn't break the UI). */
export function listSessionsCompat(cwd: string | undefined, limit: number, opts: ListOptions): Meta[] {
  try {
    return listSessions(cwd, limit, opts);
  } catch {
    return [];
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtDate(t: number, now = Date.now()): string {
  if (now - t < 86_400_000) return ago(t);
  const d = new Date(t);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : ` ${d.getFullYear()}`} ${time}`;
}

export interface SessionRow {
  value: string;
  label: string;
  detail: string;
  indent: number;
  current: boolean;
  search: string;
}

/** Sessions as picker rows: newest first, subagent sessions nested under their parent. */
export function sessionRows(metas: Meta[], opts: { all: boolean; currentId?: string }): SessionRow[] {
  const ids = new Set(metas.map((m) => m.id));
  const kids = new Map<string, Meta[]>();
  const tops: Meta[] = [];
  for (const m of metas) {
    if (m.parentId && ids.has(m.parentId)) {
      const k = kids.get(m.parentId) ?? [];
      k.push(m);
      kids.set(m.parentId, k);
    } else tops.push(m);
  }
  const out: SessionRow[] = [];
  const add = (m: Meta, depth: number, seen: Set<string>) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    const title = (m.title ?? "(untitled)").replace(/\s+/g, " ").slice(0, 80);
    const label = m.parentId ? `${m.agentLabel ?? "subagent"} · ${title}` : title;
    const detail = [fmtDate(m.updated), m.model, m.messageCount != null ? `${m.messageCount} msg${m.messageCount === 1 ? "" : "s"}` : null, opts.all ? tilde(m.cwd) : null].filter(Boolean).join(" · ");
    out.push({ value: m.id, label, detail, indent: depth, current: m.id === opts.currentId, search: `${title} ${m.cwd} ${m.agentLabel ?? ""} ${m.model}` });
    for (const k of (kids.get(m.id) ?? []).sort((a, b) => a.created - b.created)) add(k, depth + 1, seen);
  };
  const seen = new Set<string>();
  for (const t of tops) add(t, 0, seen);
  return out;
}

// ---------------- transcript ----------------

/** Hard-wrap a line with ANSI styles to `width` columns, carrying the active styles over. */
export function wrapAnsi(line: string, width: number): string[] {
  if (width < 4 || textWidth(line) <= width) return [line];
  const out: string[] = [];
  let cur = "";
  let w = 0;
  let active = "";
  const re = /\x1b\[[0-9;:]*m|[\s\S]/gu;
  for (const m of line.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith("\x1b[")) {
      cur += tok;
      active = tok === "\x1b[0m" || tok === "\x1b[m" ? "" : active + tok;
      continue;
    }
    const cw = textWidth(tok);
    if (w + cw > width) {
      out.push(cur + (active ? "\x1b[0m" : ""));
      cur = active;
      w = 0;
    }
    cur += tok;
    w += cw;
  }
  out.push(cur);
  return out;
}

function inputSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const main = i.description ?? i.command ?? i.path ?? i.pattern ?? i.prompt ?? i.query ?? i.name;
  if (typeof main === "string") return main.split("\n")[0].slice(0, 160);
  return JSON.stringify(input).slice(0, 160);
}

/** A read-only transcript of a session as ANSI lines wrapped to `width`. */
export function transcriptLines(f: SessionFile, width: number): string[] {
  const out: string[] = [];
  const history = fullHistory(f);
  const add = (l: string) => out.push(...wrapAnsi(l, width));
  add(st.bold(f.title ?? "(untitled)"));
  add(fg(P.dim)(`${tilde(f.cwd)} · ${f.model} · ${fmtDate(f.updated)} · ${history.length} messages${f.parentId ? ` · subagent of ${f.parentId}` : ""}`));
  const results = new Map<string, { output: string; isError?: boolean }>();
  for (const m of history) for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p);
  const result = (r: { output: string; isError?: boolean }) => {
    const lines = stripAnsi(r.output).replace(/\r/g, "").trim().split("\n");
    const color = r.isError ? fg(P.red) : fg(P.dim);
    lines.slice(0, 4).forEach((l, i) => add(color(`${i === 0 ? `  ${G.result} ` : "    "}${l}`)));
    if (lines.length > 4) add(fg(P.dim)(`    … +${lines.length - 4} lines`));
  };
  for (const m of history) {
    let first = true;
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) {
        out.push("");
        if (m.role === "user") p.text.split("\n").forEach((l, i) => add((i === 0 ? fg(P.teal)(`${G.arrow} `) : "  ") + fg(P.gray)(l)));
        else {
          markdownToAnsi(p.text, width - 2)
            .split("\n")
            .forEach((l, i) => add((i === 0 && first ? fg(P.teal)(`${G.dot} `) : "  ") + l));
          first = false;
        }
      } else if (p.type === "thinking" && p.text.trim()) {
        out.push("");
        const lines = p.text.trim().split("\n");
        add(st.italic(fg(P.dim)(`${G.think} ${lines[0]}`)));
        for (const l of lines.slice(1, 4)) add(st.italic(fg(P.dim)(`  ${l}`)));
        if (lines.length > 4) add(fg(P.dim)(`  … ${lines.length - 4} more lines`));
      } else if (p.type === "tool_call") {
        out.push("");
        const r = results.get(p.id);
        add(`${fg(r?.isError ? P.red : P.green)(G.dot)} ${st.bold(p.name)} ${fg(P.gray)(inputSummary(p.input))}`);
        if (r) result(r);
        first = true;
      } else if (p.type === "image") {
        add(fg(P.dim)("  [image]"));
      }
    }
  }
  return out;
}
