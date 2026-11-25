import { homedir } from "node:os";
import type { Mode } from "../config";

// ---------------- colour support ----------------

/** 0 none, 1 basic 16, 2 256 colours, 3 truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export function detectColorLevel(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 2;
    if (force === "3") return 3;
    return 1;
  }
  if (!isTTY || env.TERM === "dumb") return 0;
  // Windows 10+ consoles and Windows Terminal all do 24-bit colour.
  if (process.platform === "win32") return 3;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper"].includes(env.TERM_PROGRAM ?? "")) return 3;
  if (/kitty|alacritty|ghostty|direct|wezterm/i.test(env.TERM ?? "")) return 3;
  if (/256/.test(env.TERM ?? "") || env.TERM_PROGRAM === "Apple_Terminal") return 2;
  return 1;
}

let level: ColorLevel = detectColorLevel();
export const colorLevel = () => level;
/** Tests and the line UI can force a level. */
export function setColorLevel(l: ColorLevel) {
  level = l;
}

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const rgbTo256 = (r: number, g: number, b: number) => {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
};
const rgbTo16 = (r: number, g: number, b: number) => {
  const v = Math.max(r, g, b) / 255;
  if (v < 0.2) return 30;
  let code = 30 + ((Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255));
  if (v > 0.7) code += 60;
  return code;
};

/** SGR for a hex colour at the current level ("" when colours are off). */
export function colorCode(hex: string, background = false): string {
  if (level === 0) return "";
  const [r, g, b] = hexRgb(hex);
  if (level === 3) return `\x1b[${background ? 48 : 38};2;${r};${g};${b}m`;
  if (level === 2) return `\x1b[${background ? 48 : 38};5;${rgbTo256(r, g, b)}m`;
  return `\x1b[${rgbTo16(r, g, b) + (background ? 10 : 0)}m`;
}

/** Wrap text in a foreground colour (resets only the foreground, so styles can nest). */
export const fg = (hex: string) => (s: string) => (level ? `${colorCode(hex)}${s}\x1b[39m` : s);
export const bg = (hex: string) => (s: string) => (level ? `${colorCode(hex, true)}${s}\x1b[49m` : s);
const style = (on: number, off: number) => (s: string) => (level ? `\x1b[${on}m${s}\x1b[${off}m` : s);
export const st = {
  bold: style(1, 22),
  dim: style(2, 22),
  italic: style(3, 23),
  underline: style(4, 24),
  strike: style(9, 29),
  /** inverse is not a colour, so it stays on with NO_COLOR (it marks the cursor) */
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "");

// ---------------- palette ----------------

export const P = {
  teal: "#2dd4bf",
  cyan: "#22d3ee",
  sky: "#38bdf8",
  blue: "#60a5fa",
  indigo: "#818cf8",
  violet: "#a78bfa",
  green: "#4ade80",
  red: "#f87171",
  amber: "#fbbf24",
  orange: "#fb923c",
  pink: "#f472b6",
  gray: "#94a3b8",
  dim: "#64748b",
  border: "#475569",
  code: "#7dd3fc",
  addFg: "#86efac",
  addBg: "#0f2e1d",
  delFg: "#fca5a5",
  delBg: "#3b1219",
};

export const MODE_STYLE: Record<Mode, { label: string; color: string }> = {
  ask: { label: "ask", color: P.sky },
  edits: { label: "auto-edit", color: P.violet },
  auto: { label: "auto", color: P.amber },
  yolo: { label: "full-auto", color: P.red },
};

/** Interpolate between hex colours: t in 0..1 across the stops. */
export function mix(stops: string[], t: number): string {
  if (stops.length === 1) return stops[0];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = hexRgb(stops[i]);
  const b = hexRgb(stops[i + 1]);
  return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
}

export const GRADIENT = [P.teal, P.cyan, P.sky, "#6366f1"];

/** Colour each column of a block of lines along the teal → indigo gradient. */
export function gradientLines(lines: string[], stops = GRADIENT): string[] {
  const w = Math.max(...lines.map((l) => [...l].length), 1);
  return lines.map((l) =>
    [...l]
      .map((ch, i) => (ch === " " ? ch : fg(mix(stops, i / Math.max(w - 1, 1)))(ch)))
      .join(""),
  );
}

// ---------------- glyphs ----------------

/** The old Windows console font lacks braille and a few symbols; Windows Terminal and others have them. */
const plain = process.platform === "win32" && !process.env.WT_SESSION && !process.env.TERM_PROGRAM;
export const G = plain
  ? { spinner: ["|", "/", "-", "\\"], dot: "*", ok: "+", fail: "x", arrow: ">", branch: "|", last: "`", result: "L", think: "*", bullet: "-", queue: ">", info: "i", bar: ["#", "-"] }
  : { spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], dot: "●", ok: "✓", fail: "✗", arrow: "›", branch: "├", last: "└", result: "⎿", think: "✻", bullet: "•", queue: "⏵", info: "◆", bar: ["▰", "▱"] };

// ---------------- formatting ----------------

export const tilde = (p: string) => {
  const h = homedir();
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
};
export const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ---------------- plain helpers for the CLI and the line UI ----------------

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  dim: sgr("2"),
  bold: sgr("1"),
  italic: sgr("3"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
};
