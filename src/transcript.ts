import { listChildren, loadSession, type SessionFile } from "./store";
import type { Part } from "./types";

export interface TranscriptOptions {
  /** include each subagent's own transcript where it was started (default true) */
  children?: boolean;
  /** include the model's thinking (default false) */
  thinking?: boolean;
  /** cut tool outputs to this many characters (default 2000; 0 = no limit) */
  maxToolOutput?: number;
}

const fence = (s: string) => {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${s}\n${f}`;
};

const cut = (s: string, n: number) => (n > 0 && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

function inputSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "shell") return String(input.command ?? "");
  if (input.path) return String(input.path);
  if (input.pattern) return String(input.pattern);
  if (name === "agent") return String(input.description ?? "");
  const s = JSON.stringify(input);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}

/** A session as readable Markdown: prompts, answers, tool calls and (optionally) subagents. */
export function renderTranscript(s: SessionFile, o: TranscriptOptions = {}, depth = 0): string {
  const opts = { children: true, thinking: false, maxToolOutput: 2000, ...o };
  const h = "#".repeat(Math.min(depth + 1, 4));
  const lines: string[] = [];
  lines.push(`${h} ${s.title ?? "(untitled session)"}`);
  lines.push("");
  lines.push(`- Session: \`${s.id}\`${s.parentId ? ` (subagent of \`${s.parentId}\`)` : ""}`);
  lines.push(`- Folder: \`${s.cwd}\``);
  lines.push(`- Model: ${s.model} · mode ${s.mode} · ${new Date(s.created).toISOString().replace("T", " ").slice(0, 16)} → ${new Date(s.updated).toISOString().replace("T", " ").slice(0, 16)} UTC`);
  lines.push(`- Tokens: ${s.usage.input + s.usage.cacheRead + s.usage.cacheWrite} in (${s.usage.cacheRead} cached) · ${s.usage.output} out`);
  lines.push("");

  const children = opts.children ? listChildren(s.id) : [];
  const childById = new Map(children.map((c) => [c.id, c]));
  const shown = new Set<string>();

  for (const m of s.messages) {
    for (const p of m.parts as Part[]) {
      if (m.role === "user" && p.type === "text") lines.push(`**You:**`, "", p.text.trim(), "");
      else if (p.type === "image") lines.push(`_[image ${p.mediaType}]_`, "");
      else if (p.type === "thinking" && opts.thinking && p.text.trim()) lines.push(`> _thinking:_ ${p.text.trim().replace(/\n/g, "\n> ")}`, "");
      else if (m.role === "assistant" && p.type === "text" && p.text.trim()) lines.push(`**Agent:**`, "", p.text.trim(), "");
      else if (p.type === "tool_call") lines.push(`- 🔧 \`${p.name}\` ${inputSummary(p.name, p.input) ? `— ${"`"}${inputSummary(p.name, p.input).replace(/`/g, "'")}${"`"}` : ""}`);
      else if (p.type === "tool_result") {
        lines.push(`  - ${p.isError ? "⚠️ failed" : "result"}:`, "", fence(cut(p.output, opts.maxToolOutput)), "");
        // A subagent's result names its session: show that transcript right here.
        const id = p.name === "agent" ? /session ([A-Za-z0-9_-]+)\]/.exec(p.output)?.[1] : undefined;
        if (id && childById.has(id) && !shown.has(id)) {
          const child = loadSession(id);
          if (child) {
            shown.add(id);
            lines.push(renderTranscript(child, opts, depth + 1), "");
          }
        }
      }
    }
  }
  // Subagents whose result never came back (cancelled, crashed): list them at the end.
  for (const c of children)
    if (!shown.has(c.id)) {
      const child = loadSession(c.id);
      if (child) lines.push(renderTranscript(child, opts, depth + 1), "");
    }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
