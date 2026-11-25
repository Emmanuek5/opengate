// cli-highlight pulls in highlight.js with every grammar; load it the first time a code block shows up.
let hl: typeof import("cli-highlight") | null = null;
const highlighter = () => (hl ??= require("cli-highlight") as typeof import("cli-highlight"));
import { fg, P, st } from "./theme";

/**
 * A small Markdown renderer for the terminal: headings, emphasis, lists, quotes, rules, tables,
 * inline code and fenced code blocks with syntax highlighting. It produces blocks of ANSI text that
 * the Ink view lays out (so list items keep a hanging indent when they wrap).
 */
export type MdBlock =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "li"; indent: number; bullet: string; text: string }
  | { t: "quote"; text: string }
  | { t: "code"; lang: string; lines: string[] }
  | { t: "hr" }
  | { t: "table"; rows: string[][]; header: boolean }
  | { t: "blank" };

// ---------------- inline ----------------

const codeSpan = (s: string) => fg(P.code)(s);
const linkText = (s: string) => st.underline(fg(P.sky)(s));

/** Inline Markdown → ANSI. */
export function inline(src: string): string {
  // Split out code spans first so nothing inside them is touched.
  const parts = src.split(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += emphasis(parts[i]);
    else if (i % 3 === 2) out += codeSpan(parts[i]);
  }
  return out;
}

function emphasis(s: string): string {
  if (!s) return s;
  return s
    .replace(/!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text: string, url: string) => (text === url ? linkText(url) : `${linkText(text)}${st.dim(` (${url})`)}`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, u: string) => linkText(u))
    .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, (_m, _d, t: string) => st.bold(st.italic(t)))
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_m, _d, t: string) => st.bold(t))
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, (_m, pre: string, t: string) => pre + st.italic(t))
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, (_m, pre: string, t: string) => pre + st.italic(t))
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_m, t: string) => st.strike(t));
}

// ---------------- code ----------------

const THEME = () => {
  const kw = fg(P.violet);
  const str = fg(P.green);
  const num = fg(P.orange);
  const fn = fg(P.blue);
  const type = fg(P.teal);
  const com = (s: string) => st.italic(fg(P.dim)(s));
  return {
    keyword: kw,
    built_in: type,
    type,
    literal: num,
    number: num,
    regexp: fg(P.pink),
    string: str,
    subst: (s: string) => s,
    symbol: num,
    class: type,
    function: fn,
    title: fn,
    params: (s: string) => s,
    comment: com,
    doctag: kw,
    meta: fg(P.gray),
    "meta-keyword": kw,
    "meta-string": str,
    section: fn,
    tag: fg(P.gray),
    name: kw,
    "builtin-name": type,
    attr: fg(P.sky),
    attribute: fg(P.sky),
    variable: fg(P.red),
    bullet: num,
    code: str,
    emphasis: st.italic,
    strong: st.bold,
    formula: str,
    link: linkText,
    quote: com,
    "selector-tag": kw,
    "selector-id": fn,
    "selector-class": fn,
    "selector-attr": fn,
    "selector-pseudo": fn,
    "template-tag": kw,
    "template-variable": fg(P.red),
    addition: fg(P.addFg),
    deletion: fg(P.delFg),
    default: (s: string) => s,
  };
};

const ALIASES: Record<string, string> = { sh: "bash", shell: "bash", zsh: "bash", console: "bash", ps: "powershell", ps1: "powershell", pwsh: "powershell", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", rs: "rust", yml: "yaml", md: "markdown", jsonc: "json", golang: "go" };

export function highlightCode(code: string, lang: string): string[] {
  const l = ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  const text = code.replace(/\t/g, "  ");
  if (l && l !== "text" && l !== "plain" && l !== "txt") {
    try {
      const h = highlighter();
      if (h.supportsLanguage(l)) return h.highlight(text, { language: l, ignoreIllegals: true, theme: THEME() as any }).split("\n");
    } catch {}
  }
  return text.split("\n");
}

// ---------------- blocks ----------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;

export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: "p", text: inline(para.join("\n")) });
    para = [];
  };
  const blank = () => {
    if (out.length && out[out.length - 1].t !== "blank") out.push({ t: "blank" });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line))) {
      flush();
      const fence = m[2];
      const indent = m[1].length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) {
        body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), "") : lines[i]);
        i++;
      }
      out.push({ t: "code", lang: m[3] ?? "", lines: highlightCode(body.join("\n"), m[3] ?? "") });
      continue;
    }
    if (!line.trim()) {
      flush();
      blank();
      continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      flush();
      out.push({ t: "h", level: m[1].length, text: inline(m[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ t: "hr" });
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      flush();
      const indent = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
      const ordered = /\d/.test(m[2]);
      const check = m[3] ? (m[3].includes(" ]") ? "☐" : "☑") : null;
      let text = m[4];
      // lazy continuation lines belong to the item
      while (i + 1 < lines.length && lines[i + 1].trim() && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[i + 1]) && !FENCE.test(lines[i + 1])) text += " " + lines[++i].trim();
      out.push({ t: "li", indent, bullet: check ?? (ordered ? m[2].replace(")", ".") : indent % 2 ? "◦" : "•"), text: inline(text) });
      continue;
    }
    if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      flush();
      const q = [m[1]];
      while (i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1])) q.push(lines[++i].replace(/^\s{0,3}>\s?/, ""));
      out.push({ t: "quote", text: inline(q.join(" ")) });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const rows = [cells(line)];
      i++;
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push({ t: "table", rows, header: true });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  while (out.length && out[0].t === "blank") out.shift();
  while (out.length && out[out.length - 1].t === "blank") out.pop();
  return out;
}

/**
 * Where streamed text can be cut so the finished part is rendered once: after a blank line or a
 * closing code fence, outside of any open fence. Returns the length of the finished prefix (0: none).
 */
export function stableCut(text: string): number {
  let cut = 0;
  let fence: string | null = null;
  let pos = 0;
  let prevBlank = false;
  while (true) {
    const nl = text.indexOf("\n", pos);
    if (nl < 0) break;
    const line = text.slice(pos, nl);
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && line.trim().startsWith(fence)) {
        fence = null;
        cut = nl + 1;
      }
    } else if (m) {
      fence = m[1];
    } else if (!line.trim()) {
      if (!prevBlank && pos > 0) cut = nl + 1;
    }
    prevBlank = !fence && !line.trim();
    pos = nl + 1;
  }
  return cut;
}

/** Visible width of a string (ANSI stripped; wide characters count 2). */
export function textWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;:]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

/** Markdown as plain ANSI lines (for the line UI and transcripts). */
export function markdownToAnsi(src: string, width = 100): string {
  const out: string[] = [];
  for (const b of parseMarkdown(src)) {
    if (b.t === "blank") out.push("");
    else if (b.t === "p") out.push(b.text);
    else if (b.t === "h") out.push(st.bold(b.level <= 2 ? fg(P.teal)(b.text) : b.text));
    else if (b.t === "li") out.push(`${"  ".repeat(b.indent)}${fg(P.teal)(b.bullet)} ${b.text}`);
    else if (b.t === "quote") out.push(`${fg(P.dim)("│")} ${st.italic(b.text)}`);
    else if (b.t === "hr") out.push(fg(P.dim)("─".repeat(Math.min(width, 40))));
    else if (b.t === "code") out.push(...b.lines.map((l) => `  ${l}`));
    else if (b.t === "table") out.push(...tableLines(b.rows, b.header));
  }
  return out.join("\n");
}

export function tableLines(rows: string[][], header: boolean): string[] {
  const n = Math.max(...rows.map((r) => r.length));
  const w = Array.from({ length: n }, (_, i) => Math.max(...rows.map((r) => textWidth(r[i] ?? ""))));
  const pad = (s: string, i: number) => s + " ".repeat(Math.max(w[i] - textWidth(s), 0));
  const line = (r: string[]) => Array.from({ length: n }, (_, i) => pad(r[i] ?? "", i)).join(fg(P.dim)(" │ "));
  const out = rows.map((r, i) => (i === 0 && header ? st.bold(line(r)) : line(r)));
  if (header && rows.length > 1) out.splice(1, 0, fg(P.dim)(w.map((x) => "─".repeat(x)).join("─┼─")));
  return out;
}
