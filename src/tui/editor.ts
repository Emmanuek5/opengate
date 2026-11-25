/** A small multi-line text editor model: immutable state, pure operations. */
export interface Ed {
  text: string;
  /** cursor offset in UTF-16 units, always on a code point boundary */
  cursor: number;
}

export const empty: Ed = { text: "", cursor: 0 };
export const edOf = (text: string, cursor = text.length): Ed => ({ text, cursor: Math.min(Math.max(cursor, 0), text.length) });

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const prevPos = (t: string, i: number) => (i <= 0 ? 0 : i >= 2 && isLow(t.charCodeAt(i - 1)) ? i - 2 : i - 1);
const nextPos = (t: string, i: number) => (i >= t.length ? t.length : isLow(t.charCodeAt(i + 1)) ? i + 2 : i + 1);
const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

export function insert(e: Ed, s: string): Ed {
  return { text: e.text.slice(0, e.cursor) + s + e.text.slice(e.cursor), cursor: e.cursor + s.length };
}
export function backspace(e: Ed): Ed {
  if (!e.cursor) return e;
  const p = prevPos(e.text, e.cursor);
  return { text: e.text.slice(0, p) + e.text.slice(e.cursor), cursor: p };
}
export function del(e: Ed): Ed {
  if (e.cursor >= e.text.length) return e;
  return { text: e.text.slice(0, e.cursor) + e.text.slice(nextPos(e.text, e.cursor)), cursor: e.cursor };
}
export const left = (e: Ed): Ed => ({ ...e, cursor: prevPos(e.text, e.cursor) });
export const right = (e: Ed): Ed => ({ ...e, cursor: nextPos(e.text, e.cursor) });

function wordStart(t: string, i: number) {
  while (i > 0 && !isWord(t[i - 1])) i--;
  while (i > 0 && isWord(t[i - 1])) i--;
  return i;
}
function wordEnd(t: string, i: number) {
  while (i < t.length && !isWord(t[i])) i++;
  while (i < t.length && isWord(t[i])) i++;
  return i;
}
export const wordLeft = (e: Ed): Ed => ({ ...e, cursor: wordStart(e.text, e.cursor) });
export const wordRight = (e: Ed): Ed => ({ ...e, cursor: wordEnd(e.text, e.cursor) });
export function deleteWordBefore(e: Ed): Ed {
  const p = wordStart(e.text, e.cursor);
  return { text: e.text.slice(0, p) + e.text.slice(e.cursor), cursor: p };
}
export function deleteWordAfter(e: Ed): Ed {
  const p = wordEnd(e.text, e.cursor);
  return { text: e.text.slice(0, e.cursor) + e.text.slice(p), cursor: e.cursor };
}

const lineStart = (t: string, i: number) => t.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (t: string, i: number) => {
  const n = t.indexOf("\n", i);
  return n < 0 ? t.length : n;
};
export const home = (e: Ed): Ed => ({ ...e, cursor: lineStart(e.text, e.cursor) });
export const end = (e: Ed): Ed => ({ ...e, cursor: lineEnd(e.text, e.cursor) });
/** Ctrl+U: delete to the start of the line (or the newline before, at a line start). */
export function killBefore(e: Ed): Ed {
  let s = lineStart(e.text, e.cursor);
  if (s === e.cursor && s > 0) s--;
  return { text: e.text.slice(0, s) + e.text.slice(e.cursor), cursor: s };
}
/** Ctrl+K: delete to the end of the line (or the newline, at a line end). */
export function killAfter(e: Ed): Ed {
  let x = lineEnd(e.text, e.cursor);
  if (x === e.cursor && x < e.text.length) x++;
  return { text: e.text.slice(0, e.cursor) + e.text.slice(x), cursor: e.cursor };
}

/** Move up/down a line keeping the column; null when already on the first/last line (history takes over). */
export function vertical(e: Ed, dir: -1 | 1): Ed | null {
  const s = lineStart(e.text, e.cursor);
  const col = e.cursor - s;
  if (dir < 0) {
    if (s === 0) return null;
    const ps = lineStart(e.text, s - 1);
    return { ...e, cursor: Math.min(ps + col, s - 1) };
  }
  const x = lineEnd(e.text, e.cursor);
  if (x >= e.text.length) return null;
  const ns = x + 1;
  return { ...e, cursor: Math.min(ns + col, lineEnd(e.text, ns)) };
}

/** Line and column of the cursor. */
export function cursorPos(e: Ed): { line: number; col: number } {
  const before = e.text.slice(0, e.cursor);
  const line = before.split("\n").length - 1;
  return { line, col: e.cursor - lineStart(e.text, e.cursor) };
}

/** Paste: normalize line endings and tabs. */
export const cleanPaste = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
