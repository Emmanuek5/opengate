/**
 * Decodes one terminal input sequence (Ink's input parser already splits the stream into single
 * sequences and pastes) into a key. Handles legacy xterm/VT sequences, the kitty keyboard protocol
 * (CSI u) and xterm's modifyOtherKeys, so Shift+Enter works wherever the terminal reports it.
 */
export interface KeyEvent {
  /** "char" for printable text (in `ch`), otherwise the key name */
  name: string;
  ch: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const key = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({ name, ch: "", ctrl: false, meta: false, shift: false, ...mods });

const CSI_NAMES: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4" };
const TILDE_NAMES: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };

/** kitty/xterm modifier parameter: 1 + (shift 1 | alt 2 | ctrl 4 | super 8 | meta 32) */
const mods = (m: number) => {
  const b = Math.max(m - 1, 0);
  return { shift: !!(b & 1), meta: !!(b & 2) || !!(b & 32), ctrl: !!(b & 4) };
};

function fromCodepoint(code: number, m: { shift: boolean; meta: boolean; ctrl: boolean }): KeyEvent | null {
  if (code === 13 || code === 57414) return key("return", m);
  if (code === 9) return key("tab", m);
  if (code === 27) return key("escape", m);
  if (code === 127 || code === 8) return key("backspace", m);
  if (code === 32) return m.ctrl || m.meta ? key("space", m) : key("char", { ...m, ch: " " });
  if (code >= 57344 && code <= 63743) return null; // kitty functional keys (lone modifiers, keypad…)
  let ch = String.fromCodePoint(code);
  if (m.ctrl || m.meta) return key(ch.toLowerCase(), { ...m, shift: m.shift || ch !== ch.toLowerCase() });
  if (m.shift) ch = ch.toUpperCase();
  return key("char", { ...m, ch });
}

export function decodeKey(s: string): KeyEvent | null {
  if (!s) return null;
  if (s === "\r") return key("return");
  if (s === "\n") return key("linefeed", { ctrl: true });
  if (s === "\x1b\r" || s === "\x1b\n") return key("return", { meta: true });
  if (s === "\t") return key("tab");
  if (s === "\x1b[Z") return key("tab", { shift: true });
  if (s === "\x7f" || s === "\b") return key("backspace");
  if (s === "\x1b\x7f" || s === "\x1b\b") return key("backspace", { meta: true });
  if (s === "\x1b") return key("escape");
  if (s === "\x1b\x1b") return key("escape", { meta: true });
  if (s === "\x00") return key("space", { ctrl: true });

  let m: RegExpExecArray | null;
  // kitty keyboard protocol: CSI code[:alts] ; mods[:event] [; text] u
  if ((m = /^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/.exec(s))) {
    if (m[3] === "3") return null; // key release
    return fromCodepoint(Number(m[1]), mods(Number(m[2] || 1)));
  }
  // xterm modifyOtherKeys: CSI 27 ; mods ; code ~
  if ((m = /^\x1b\[27;(\d+);(\d+)~$/.exec(s))) return fromCodepoint(Number(m[2]), mods(Number(m[1])));
  // CSI [1;mods] A-D/H/F/P-S, SS3 A-D/H/F
  if ((m = /^\x1b\[(?:1;(\d+)(?::\d+)?)?([ABCDHFPQRS])$/.exec(s)) || (m = /^\x1bO(\d*)([ABCDHFPQRS])$/.exec(s))) {
    if (s.includes(":3")) return null;
    return key(CSI_NAMES[m[2]], mods(Number(m[1] || 1)));
  }
  // rxvt-style ctrl/shift arrows
  if ((m = /^\x1bO([abcd])$/.exec(s))) return key(CSI_NAMES[m[1].toUpperCase()], { ctrl: true });
  if ((m = /^\x1b\[([abcd])$/.exec(s))) return key(CSI_NAMES[m[1].toUpperCase()], { shift: true });
  // CSI n [; mods] ~
  if ((m = /^\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?~$/.exec(s))) {
    const name = TILDE_NAMES[m[1]];
    return name ? key(name, mods(Number(m[2] || 1))) : null;
  }
  if (s.startsWith("\x1b[") || s.startsWith("\x1bO")) return null; // some other report
  // Alt+key
  if (s.length === 2 && s[0] === "\x1b") {
    const ch = s[1];
    if (ch.charCodeAt(0) < 32) {
      const inner = decodeKey(ch);
      return inner ? { ...inner, meta: true } : null;
    }
    return key(ch.toLowerCase(), { meta: true, shift: ch !== ch.toLowerCase() });
  }
  // Ctrl+letter
  if (s.length === 1 && s.charCodeAt(0) < 32) {
    const code = s.charCodeAt(0);
    return key(String.fromCharCode(code + (code <= 26 ? 96 : 64)), { ctrl: true });
  }
  // printable text (a typed character, or several typed quickly / from an IME)
  const text = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return text ? key("char", { ch: text }) : null;
}

/** Enter variants that insert a newline instead of sending: Shift/Alt/Ctrl+Enter and Ctrl+J. */
export const isNewlineKey = (k: KeyEvent) => (k.name === "return" && (k.shift || k.meta || k.ctrl)) || k.name === "linefeed" || (k.ctrl && k.name === "j");
