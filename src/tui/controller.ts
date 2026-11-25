import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Session, type AgentUI, type Decision, type ToolCallInfo } from "../agent";
import { dataDir, defaultModel, EFFORTS, loadConfig, MODES, type Config, type Mode } from "../config";
import { getCommand, getCommands, type AgentEvent } from "../ext";
import { groupModels, type Gateway } from "../gateway";
import { loadSession } from "../store";
import { runProcess, shellCommand, type Diff, type ToolResult } from "../tools";
import { FileIndex, fuzzyFilter, fuzzyScore, tokenAt } from "./complete";
import * as E from "./editor";
import { summarizeTool, type ToolSummary } from "./format";
import { isNewlineKey, type KeyEvent } from "./keys";
import { stableCut } from "./markdown";
import { listSessionsCompat, sessionRows, transcriptLines, wrapAnsi } from "./sessions";
import { getLiveSubagent, liveSubagents, watchSubagent } from "../subagents";
import { defaultModelCommand } from "../defaults";
import { updateHint } from "../update";
import { clipboardImage, imageFromFile, imagePathsIn, MAX_IMAGE_BYTES, MAX_IMAGES, type ImagePart } from "../images";
import type { Part } from "../types";
import { ago, fg, fmtDuration, fmtK, G, MODE_STYLE, P, st, stripAnsi } from "./theme";

// ---------------- state shapes ----------------

export interface SubView {
  id: string;
  title: string;
  model?: string;
  status: "running" | "done" | "failed" | "cancelled";
  activity?: string;
}

export interface ToolView {
  call: ToolCallInfo;
  status: "running" | "done" | "failed";
  started: number;
  ended?: number;
  summary?: ToolSummary;
  decision?: Decision;
  subs: SubView[];
}

export type Item = { id: number } & (
  | { kind: "header" }
  | { kind: "user"; text: string; steer?: boolean }
  | { kind: "md"; text: string; first: boolean }
  | { kind: "thinking"; text: string; ms: number }
  | { kind: "tool"; tool: ToolView }
  | { kind: "notice"; level: "info" | "warn" | "error"; text: string }
  | { kind: "event"; icon: string; color: string; text: string }
  | { kind: "shell"; command: string; output: string; code: number | null; ms: number; hidden: number }
  | { kind: "print"; text: string }
  | { kind: "expanded"; title: string; text?: string; diff?: Diff }
  | { kind: "done"; text: string }
  | { kind: "help"; rows: [string, string][]; keys: [string, string][] }
);
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

export interface AskState {
  call: ToolCallInfo;
  diff: Diff | null;
  sel: number;
  resolve(d: Decision): void;
}

export interface PickerRow {
  value: string;
  label: string;
  detail?: string;
  group?: string;
  current?: boolean;
  /** nesting depth (subagent sessions under their parent) */
  indent?: number;
  /** what type-to-filter matches against (default: label and group) */
  search?: string;
}

export interface PickerState {
  title: string;
  rows: PickerRow[];
  filter: string;
  sel: number;
  loading?: boolean;
  error?: string;
  /** extra key hints for the footer */
  footer?: string;
  onPick(row: PickerRow): void | Promise<void>;
  /** picker-specific keys; return true when handled */
  onKey?(k: KeyEvent, row: PickerRow | undefined): boolean;
}

/** A read-only, scrollable view of a saved session. */
export interface TranscriptState {
  id: string;
  title: string;
  lines: string[];
  offset: number;
  /** the picker to go back to */
  back: PickerState | null;
  /** watching a running subagent: the view follows its new output until you scroll up */
  live?: { follow: boolean; status: string; unsub: () => void };
}

export interface PopupItem {
  value: string;
  label: string;
  detail?: string;
  dir?: boolean;
}

export interface Popup {
  kind: "slash" | "mention";
  items: PopupItem[];
  sel: number;
}

interface Expandable {
  title: string;
  text?: string;
  diff?: Diff;
}

export const BUILTIN: { name: string; args?: string; description: string }[] = [
  { name: "model", args: "[default|project] [name]", description: "Pick this session's model, or the default for this project / everywhere" },
  { name: "mode", args: "[ask|edits|auto|yolo]", description: "When to ask before edits and commands" },
  { name: "effort", args: `[${EFFORTS.join("|")}]`, description: "How hard the model thinks" },
  { name: "new", description: "Start a new session" },
  { name: "resume", args: "[n|id]", description: "Continue an earlier session" },
  { name: "sessions", description: "Pick from recent sessions in this folder" },
  { name: "subagents", description: "Watch a subagent's chat live (Ctrl+T)" },
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "usage", description: "Tokens used in this session" },
  { name: "help", description: "Commands and keys" },
  { name: "exit", description: "Quit" },
];

/** Commands that make sense while a turn runs; the rest wait in the queue. */
const RUN_WHILE_BUSY = new Set(["help", "?", "usage", "mode", "effort", "model", "models", "exit", "quit", "subagents", "watch"]);

export const KEYS: [string, string][] = [
  ["Enter", "send; while the agent works, it reads your message at its next step (steering)"],
  ["Shift+Enter · Alt+Enter · Ctrl+J", "new line (or end a line with \\)"],
  ["Up / Down", "history (or move between lines)"],
  ["Tab / Enter", "accept a suggestion (/ commands, @ files)"],
  ["Shift+Tab", "cycle mode: ask → auto-edit → auto → full-auto"],
  ["Esc", "interrupt the agent · close a popup"],
  ["Ctrl+O", "expand the last collapsed output"],
  ["Ctrl+T", "watch a subagent's chat live"],
  ["Alt+V · Ctrl+V", "paste an image from the clipboard (or drop an image file's path in)"],
  ["Ctrl+C", "clear the input · twice to quit"],
  ["Ctrl+D", "quit (on an empty input)"],
  ["!command", "run a shell command directly"],
  ["Ctrl+A/E · Ctrl+U/K · Ctrl+W", "line start/end · delete to start/end · delete word"],
];

export interface ControllerOptions {
  cfg: Config;
  gateway: Gateway;
  session: Session;
  initialPrompt?: string;
  historyFile?: string;
  /** terminal size, for budgets; defaults to stdout */
  size?: () => { cols: number; rows: number };
}

const PASTE_LINES = 12;
const PASTE_CHARS = 2000;

// ---------------- the controller ----------------

/**
 * All of the terminal UI's state and behaviour. The Ink view renders it and forwards keys; the
 * engine talks to it through AgentUI. Kept free of React so it can be driven directly in tests.
 */
export class Controller implements AgentUI {
  items: Item[] = [];
  // live (not yet rendered once)
  liveText = "";
  private textStarted = false;
  thinkingBuf = "";
  private thinkingStart = 0;
  tools: ToolView[] = [];
  subs: SubView[] = [];
  asks: AskState[] = [];
  picker: PickerState | null = null;
  transcript: TranscriptState | null = null;
  busy = false;
  turnStart = 0;
  activity = "";
  queue: string[] = [];
  /** messages sent to the running turn that the model hasn't seen yet */
  steerPending: string[] = [];
  /** pasted images, shown as [Image #n] in the input until the message is sent */
  images = new Map<number, ImagePart>();
  private imageCount = 0;
  hint: string | null = null;
  ed: E.Ed = E.empty;
  files: FileIndex;
  version = 0;
  onExit: () => void = () => {};

  private popupSel = 0;
  private popupKey = "";
  private popupDismissed: string | null = null;
  private history: string[] = [];
  private histIdx = -1;
  private histDraft = "";
  private expandables: Expandable[] = [];
  private pastes = new Map<string, string>();
  private pasteN = 0;
  private shellAbort: AbortController | null = null;
  private lastCtrlC = 0;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private burst = false;
  private filesDirty = false;
  private historyFile: string;
  exiting = false;

  constructor(private o: ControllerOptions) {
    this.files = new FileIndex(o.session.data.cwd);
    this.historyFile = o.historyFile ?? join(dataDir(), "history");
    this.history = loadHistory(this.historyFile);
  }

  get s(): Session {
    return this.o.session;
  }
  get session(): Session {
    return this.o.session;
  }
  /** whether the streaming text starts a new assistant message (gets the bullet) */
  get liveFirst(): boolean {
    return !this.textStarted;
  }
  get pending(): AskState | null {
    return this.asks[0] ?? null;
  }
  get size() {
    return this.o.size?.() ?? { cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 };
  }

  // ----- store -----
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  /** Re-render soon; streaming deltas are coalesced into one frame. */
  changed(soon = false) {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = setTimeout(
      () => {
        this.scheduled = null;
        for (const l of this.listeners) l();
      },
      soon ? 0 : 16,
    );
  }
  push(item: NewItem) {
    this.items = [...this.items, { ...item, id: this.nextId++ } as Item];
    this.changed();
  }

  // ----- lifecycle -----
  start() {
    this.push({ kind: "header" });
    // At most once a day, in the background: mention a newer release.
    try {
      const newer = updateHint();
      if (newer) this.push({ kind: "event", icon: "info", color: P.teal, text: `opengate ${newer} is available. Quit and run "opengate update".` });
    } catch {}
    if (this.s.data.messages.length) this.replay();
    void this.files.load().then(() => this.changed());
    if (this.o.initialPrompt) void this.submit(this.o.initialPrompt);
  }

  exit() {
    if (this.exiting) return;
    this.exiting = true;
    this.s.cancel();
    this.shellAbort?.abort();
    for (const a of this.asks) a.resolve("deny");
    this.onExit();
  }

  private flashHint(text: string, ms = 1600) {
    this.hint = text;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hint = null;
      this.changed();
    }, ms);
    this.changed(true);
  }

  // ---------------- AgentUI ----------------

  text(d: string) {
    if (this.thinkingBuf) this.flushThinking();
    this.liveText += d;
    this.activity = "Writing";
    const cut = stableCut(this.liveText);
    if (cut > 0) {
      const done = this.liveText.slice(0, cut);
      this.liveText = this.liveText.slice(cut);
      if (done.trim()) {
        this.push({ kind: "md", text: done, first: !this.textStarted });
        this.textStarted = true;
      }
    }
    this.changed();
  }

  thinking(d: string) {
    if (!this.thinkingBuf) this.thinkingStart = Date.now();
    this.thinkingBuf += d;
    this.activity = "Thinking";
    this.changed();
  }

  step() {
    this.flushLive();
    this.textStarted = false;
    this.activity = "Thinking";
    this.changed();
  }

  toolStart(call: ToolCallInfo) {
    this.flushLive();
    this.textStarted = false;
    this.tools.push({ call, status: "running", started: Date.now(), subs: [] });
    this.activity = call.title;
    this.changed();
  }

  toolEnd(call: ToolCallInfo, r: ToolResult) {
    const i = this.tools.findIndex((t) => t.call.id === call.id);
    const tv: ToolView = i >= 0 ? this.tools.splice(i, 1)[0] : { call, status: "running", started: Date.now(), subs: [] };
    tv.call = call;
    tv.status = r.isError ? "failed" : "done";
    tv.ended = Date.now();
    tv.summary = summarizeTool(call, r);
    if (tv.summary.full) this.expandables.push({ title: call.title, text: tv.summary.full });
    else if (tv.summary.fullDiff) this.expandables.push({ title: call.title, diff: tv.summary.fullDiff });
    if (r.diff) this.filesDirty = true;
    this.push({ kind: "tool", tool: tv });
    this.activity = this.tools[0]?.call.title ?? "Thinking";
  }

  ask(call: ToolCallInfo, diff: Diff | null): Promise<Decision> {
    this.flushLive();
    return new Promise((res) => {
      const st: AskState = {
        call,
        diff,
        sel: 0,
        resolve: (d) => {
          const i = this.asks.indexOf(st);
          if (i < 0) return;
          this.asks.splice(i, 1);
          const tv = this.tools.find((t) => t.call.id === call.id);
          if (tv) tv.decision = d;
          this.changed(true);
          res(d);
        },
      };
      this.asks.push(st);
      if (this.exiting) return st.resolve("deny");
      this.changed(true);
    });
  }

  notice(message: string, level: "info" | "warn" | "error" = "info") {
    this.push({ kind: "notice", level, text: message });
  }

  usage() {
    this.changed();
  }

  event(e: AgentEvent) {
    const str = (v: unknown) => (v == null ? "" : String(v));
    switch (e.type) {
      case "subagent": {
        const sv: SubView = { id: str(e.id), title: str(e.title) || "subagent", model: e.model ? str(e.model) : undefined, status: (["running", "done", "failed", "cancelled"].includes(str(e.status)) ? e.status : "running") as SubView["status"], activity: e.activity ? str(e.activity) : undefined };
        const parent = this.tools.find((t) => t.call.id === e.parentCallId);
        const list = parent ? parent.subs : this.subs;
        const i = list.findIndex((x) => x.id === sv.id);
        if (i >= 0) list[i] = { ...list[i], ...sv, activity: sv.activity ?? (sv.status === "running" ? list[i].activity : undefined) };
        else list.push(sv);
        // Finished subagents without a running parent row become a one-line notice.
        if (!parent && sv.status !== "running") {
          this.subs = this.subs.filter((x) => x.id !== sv.id);
          this.push({ kind: "event", icon: sv.status === "done" ? "ok" : "fail", color: sv.status === "done" ? P.green : sv.status === "cancelled" ? P.gray : P.red, text: `${sv.title} ${sv.status}` });
        }
        this.changed();
        return;
      }
      case "memory":
        return this.push({ kind: "event", icon: "info", color: P.violet, text: `Memory ${str(e.action) || "updated"}: ${str(e.name)}${e.scope ? ` (${str(e.scope)})` : ""}` });
      case "skill":
        return this.push({ kind: "event", icon: "info", color: P.teal, text: `Skill ${str(e.action) || "loaded"}: ${str(e.name)}` });
      case "mcp": {
        const status = str(e.status);
        const tools = Array.isArray(e.tools) ? e.tools.length : typeof e.tools === "number" ? e.tools : null;
        if (status === "connected") return this.push({ kind: "event", icon: "ok", color: P.green, text: `MCP ${str(e.server)} connected${tools !== null ? ` · ${tools} tool${tools === 1 ? "" : "s"}` : ""}` });
        if (status === "failed") return this.push({ kind: "event", icon: "fail", color: P.red, text: `MCP ${str(e.server)} failed${e.error ? `: ${str(e.error)}` : ""}` });
        if (status) return this.push({ kind: "event", icon: "info", color: P.gray, text: `MCP ${str(e.server)} ${status}` });
        return;
      }
      case "steer": {
        // The model has now seen the oldest pending steering message.
        this.steerPending.shift();
        this.activity = "Reading your message";
        return this.changed();
      }
      default:
        return;
    }
  }

  // ----- live → static -----
  private flushThinking() {
    if (this.thinkingBuf.trim()) {
      const text = this.thinkingBuf.trim();
      this.push({ kind: "thinking", text, ms: Date.now() - this.thinkingStart });
      if (text.split("\n").length > 3) this.expandables.push({ title: "Thinking", text });
    }
    this.thinkingBuf = "";
  }
  private flushText() {
    if (this.liveText.trim()) {
      this.push({ kind: "md", text: this.liveText, first: !this.textStarted });
      this.textStarted = true;
    }
    this.liveText = "";
  }
  private flushLive() {
    this.flushThinking();
    this.flushText();
  }
  private finishTurn() {
    this.flushLive();
    for (const t of this.tools) {
      t.status = "failed";
      t.ended = Date.now();
      t.summary = { lines: ["Interrupted"], error: true, hidden: 0 };
      this.push({ kind: "tool", tool: t });
    }
    this.tools = [];
    this.subs = [];
    for (const a of [...this.asks]) a.resolve("deny");
  }

  // ---------------- input ----------------

  paste(raw: string) {
    if (this.pending) return;
    const text = E.cleanPaste(raw);
    if (this.picker) {
      this.picker.filter += text.replace(/\n/g, " ");
      this.picker.sel = 0;
      return this.changed(true);
    }
    const lines = text.split("\n").length;
    if (lines > PASTE_LINES || text.length > PASTE_CHARS) {
      const tag = `[Pasted text #${++this.pasteN} +${lines} lines]`;
      this.pastes.set(tag, text);
      this.ed = E.insert(this.ed, tag);
    } else this.ed = E.insert(this.ed, text);
    this.changed(true);
  }

  private expandPastes(text: string) {
    for (const [tag, body] of this.pastes) text = text.split(tag).join(body);
    this.pastes.clear();
    return text;
  }

  key(k: KeyEvent) {
    // A burst of input in the same tick is a paste without bracketed-paste support: Enter inside
    // it is a newline, not "send".
    const inBurst = this.burst;
    if (k.name === "char") {
      this.burst = true;
      setImmediate(() => (this.burst = false));
    }
    if (this.pending) return this.askKey(k);
    if (this.transcript) return this.transcriptKey(k);
    if (this.picker) return this.pickerKey(k);
    const ed = this.ed;

    if (k.ctrl && k.name === "c") return this.ctrlC();
    if (k.ctrl && k.name === "d") {
      if (!ed.text) return this.exit();
      return this.edit(E.del(ed));
    }
    if (k.name === "tab" && k.shift) return this.cycleMode();
    if (k.ctrl && k.name === "o") return this.expand();
    if (k.ctrl && k.name === "t") return this.watchSubagents();
    // Paste an image from the clipboard. Alt+V too: Windows Terminal keeps Ctrl+V for text.
    if ((k.ctrl || k.meta) && k.name === "v") return this.pasteImage();

    const popup = this.popup();
    if (k.name === "escape") {
      if (popup) {
        this.popupDismissed = ed.text;
        return this.changed(true);
      }
      if (this.busy) return this.interrupt();
      return;
    }
    if (popup) {
      if (k.name === "up" || (k.ctrl && k.name === "p")) return this.movePopup(popup, -1);
      if (k.name === "down" || (k.ctrl && k.name === "n")) return this.movePopup(popup, 1);
      if (k.name === "tab" || (k.name === "return" && !isNewlineKey(k))) return this.accept(popup, k.name === "return");
    }
    if (isNewlineKey(k) || (k.name === "return" && inBurst)) return this.edit(E.insert(ed, "\n"));
    if (k.name === "return") {
      if (ed.text.endsWith("\\") && ed.cursor === ed.text.length) return this.edit({ text: ed.text.slice(0, -1) + "\n", cursor: ed.text.length });
      return this.submitInput();
    }
    if (k.name === "up" && !k.ctrl && !k.meta) return this.vertical(-1);
    if (k.name === "down" && !k.ctrl && !k.meta) return this.vertical(1);
    if (k.name === "left") return this.edit(k.ctrl || k.meta ? E.wordLeft(ed) : E.left(ed), false);
    if (k.name === "right") return this.edit(k.ctrl || k.meta ? E.wordRight(ed) : E.right(ed), false);
    if (k.name === "home" || (k.ctrl && k.name === "a")) return this.edit(E.home(ed), false);
    if (k.name === "end" || (k.ctrl && k.name === "e")) return this.edit(E.end(ed), false);
    if (k.name === "backspace") return this.edit(k.meta || k.ctrl ? E.deleteWordBefore(ed) : E.backspace(ed));
    if (k.name === "delete") return this.edit(k.meta || k.ctrl ? E.deleteWordAfter(ed) : E.del(ed));
    if (k.ctrl && k.name === "w") return this.edit(E.deleteWordBefore(ed));
    if (k.ctrl && k.name === "u") return this.edit(E.killBefore(ed));
    if (k.ctrl && k.name === "k") return this.edit(E.killAfter(ed));
    if (k.ctrl && k.name === "b") return this.edit(E.left(ed), false);
    if (k.ctrl && k.name === "f") return this.edit(E.right(ed), false);
    if (k.meta && k.name === "b") return this.edit(E.wordLeft(ed), false);
    if (k.meta && k.name === "f") return this.edit(E.wordRight(ed), false);
    if (k.meta && k.name === "d") return this.edit(E.deleteWordAfter(ed));
    if (k.name === "char") return this.edit(E.insert(ed, k.ch));
    if (k.name === "space") return this.edit(E.insert(ed, " "));
  }

  private edit(next: E.Ed, textChanged = true) {
    this.ed = next;
    if (textChanged) this.histIdx = -1;
    this.changed(true);
  }

  private vertical(dir: -1 | 1) {
    const moved = E.vertical(this.ed, dir);
    if (moved) return this.edit(moved, false);
    if (!this.history.length) return;
    if (dir < 0) {
      if (this.histIdx < 0) this.histDraft = this.ed.text;
      if (this.histIdx >= this.history.length - 1) return;
      this.histIdx++;
    } else {
      if (this.histIdx < 0) return;
      this.histIdx--;
    }
    const text = this.histIdx < 0 ? this.histDraft : this.history[this.history.length - 1 - this.histIdx];
    this.ed = E.edOf(text);
    this.changed(true);
  }

  private ctrlC() {
    if (this.ed.text) {
      this.ed = E.empty;
      this.pastes.clear();
      this.histIdx = -1;
      return this.changed(true);
    }
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.exit();
    this.lastCtrlC = now;
    if (this.busy) {
      this.interrupt();
      return this.flashHint("Interrupted · press Ctrl+C again to quit");
    }
    this.flashHint("Press Ctrl+C again to quit");
  }

  interrupt() {
    this.s.cancel();
    this.shellAbort?.abort();
    for (const a of [...this.asks]) a.resolve("deny");
    if (this.queue.length || this.steerPending.length) {
      // Give unsent messages back so they can be edited or sent again.
      const back = [...this.steerPending, ...this.queue].join("\n");
      this.queue = [];
      this.steerPending = [];
      this.ed = E.edOf(this.ed.text ? `${back}\n${this.ed.text}` : back);
    }
    this.activity = "Stopping";
    this.changed(true);
  }

  cycleMode() {
    const order: Mode[] = ["ask", "edits", "auto", "yolo"];
    const i = order.indexOf(this.s.data.mode);
    this.s.setMode(order[(i + 1) % order.length]);
    this.changed(true);
  }

  private expand() {
    const x = this.expandables.pop();
    if (!x) return this.flashHint("Nothing to expand");
    this.push({ kind: "expanded", title: x.title, text: x.text, diff: x.diff });
  }

  // ----- the popup -----
  commandList(): PopupItem[] {
    const ext = getCommands().filter((c) => !BUILTIN.some((b) => b.name === c.name));
    return [...BUILTIN, ...ext].map((c) => ({ value: c.name, label: `/${c.name}${c.args ? " " + c.args : ""}`, detail: c.description }));
  }

  popup(): Popup | null {
    if (this.pending || this.picker || this.transcript) return null;
    const { text, cursor } = this.ed;
    if (this.popupDismissed !== null && this.popupDismissed === text) return null;
    // While browsing history, Up/Down keep browsing.
    if (this.histIdx >= 0) return null;
    this.popupDismissed = null;
    const tok = tokenAt(text, cursor);
    if (!tok) return null;
    let items: PopupItem[];
    if (tok.kind === "slash") {
      if (text.includes("\n")) return null;
      const all = this.commandList();
      // Prefix matches in list order first, then fuzzy ones.
      const q = tok.query.toLowerCase();
      const prefix = all.filter((c) => c.value.toLowerCase().startsWith(q)).sort((a, b) => Number(b.value === q) - Number(a.value === q));
      items = [...prefix, ...fuzzyFilter(all, q, (x) => x.value, 8).filter((c) => !prefix.includes(c))].slice(0, 8);
      if (items.length === 1 && items[0].value === tok.query && text.length > tok.end) return null;
    } else {
      if (!this.files.ready) {
        void this.files.load().then(() => this.changed());
        return null;
      }
      items = this.files.search(tok.query, 8).map((f) => ({ value: f, label: f, dir: f.endsWith("/") }));
    }
    if (!items.length) return null;
    const key = `${tok.kind}:${tok.query}`;
    if (key !== this.popupKey) {
      this.popupKey = key;
      this.popupSel = 0;
    }
    return { kind: tok.kind, items, sel: Math.min(this.popupSel, items.length - 1) };
  }

  private movePopup(p: Popup, d: number) {
    this.popupSel = (p.sel + d + p.items.length) % p.items.length;
    this.changed(true);
  }

  private accept(p: Popup, enter: boolean) {
    const item = p.items[p.sel];
    const tok = tokenAt(this.ed.text, this.ed.cursor)!;
    if (p.kind === "slash") {
      const rest = this.ed.text.slice(tok.end);
      const cmd = [...BUILTIN, ...getCommands()].find((c) => c.name === item.value);
      const needsArg = !!cmd?.args?.startsWith("<");
      if (enter && !needsArg) {
        this.ed = E.edOf(`/${item.value}${rest}`);
        return this.submitInput();
      }
      const text = `/${item.value} ${rest.trimStart()}`;
      this.ed = E.edOf(text, item.value.length + 2);
    } else {
      const ins = `@${item.value}${item.dir ? "" : " "}`;
      const text = this.ed.text.slice(0, tok.start) + ins + this.ed.text.slice(tok.end).replace(/^ /, "");
      this.ed = E.edOf(text, tok.start + ins.length);
    }
    this.popupKey = "";
    this.changed(true);
  }

  // ----- permission prompt -----
  private askKey(k: KeyEvent) {
    const a = this.pending!;
    const pick = (d: Decision) => a.resolve(d);
    if (k.name === "up" || k.name === "left" || (k.name === "tab" && k.shift)) a.sel = (a.sel + 2) % 3;
    else if (k.name === "down" || k.name === "right" || k.name === "tab") a.sel = (a.sel + 1) % 3;
    else if (k.name === "return") return pick((["once", "always", "deny"] as const)[a.sel]);
    else if (k.name === "escape" || (k.ctrl && k.name === "c")) return pick("deny");
    else if (k.name === "char") {
      const ch = k.ch.toLowerCase();
      if (ch === "1" || ch === "y") return pick("once");
      if (ch === "2" || ch === "a") return pick("always");
      if (ch === "3" || ch === "n") return pick("deny");
      return;
    } else return;
    this.changed(true);
  }

  // ----- pickers -----
  pickerRows(): PickerRow[] {
    const p = this.picker;
    if (!p) return [];
    if (!p.filter) return p.rows;
    return p.rows.filter((r) => fuzzyScore(p.filter, r.search ?? `${r.label} ${r.group ?? ""}`) !== null);
  }

  private pickerKey(k: KeyEvent) {
    const p = this.picker!;
    const rows = this.pickerRows();
    if (p.onKey?.(k, rows[Math.min(p.sel, rows.length - 1)])) return this.changed(true);
    if (k.name === "escape" || (k.ctrl && k.name === "c")) {
      this.picker = null;
      return this.changed(true);
    }
    if (k.name === "up" || (k.ctrl && k.name === "p")) p.sel = rows.length ? (p.sel - 1 + rows.length) % rows.length : 0;
    else if (k.name === "down" || (k.ctrl && k.name === "n") || k.name === "tab") p.sel = rows.length ? (p.sel + 1) % rows.length : 0;
    else if (k.name === "pageup") p.sel = Math.max(0, p.sel - 8);
    else if (k.name === "pagedown") p.sel = Math.min(rows.length - 1, p.sel + 8);
    else if (k.name === "return") {
      const row = rows[p.sel];
      if (!row) return;
      this.picker = null;
      this.changed(true);
      void Promise.resolve(p.onPick(row)).catch((e) => this.notice((e as Error).message, "error"));
      return;
    } else if (k.name === "backspace") {
      p.filter = p.filter.slice(0, -1);
      p.sel = 0;
    } else if (k.name === "char") {
      p.filter += k.ch;
      p.sel = 0;
    } else return;
    this.changed(true);
  }

  openPicker(p: Omit<PickerState, "filter" | "sel"> & { sel?: number }) {
    this.picker = { filter: "", sel: 0, ...p };
    this.changed(true);
    return this.picker;
  }

  // ---------------- submitting ----------------

  private submitInput() {
    const raw = this.expandPastes(this.ed.text);
    if (!raw.trim()) return;
    this.ed = E.empty;
    this.histIdx = -1;
    this.popupKey = "";
    this.changed(true);
    void this.submit(raw);
  }

  /** Send a message, run a /command or a !command; queued while busy. */
  async submit(raw: string, fromQueue = false): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    if (!fromQueue) this.addHistory(text);
    const isCmd = text.startsWith("/") && !text.startsWith("//");
    const name = isCmd ? text.slice(1).split(/\s+/)[0] : "";
    // While a turn runs, a plain message steers it: the model reads it at its next step.
    if (this.busy && !isCmd && !text.startsWith("!") && this.s.steer(this.messageParts(text))) {
      this.steerPending.push(text);
      this.push({ kind: "user", text, steer: true });
      return;
    }
    if (this.busy && !(isCmd && RUN_WHILE_BUSY.has(name))) {
      this.queue.push(text);
      return this.changed(true);
    }
    if (text.startsWith("!")) await this.runShell(text.slice(1).trim());
    else if (isCmd) await this.command(text);
    else await this.turn(text);
    this.drain();
  }

  private drain() {
    if (this.busy || !this.queue.length || this.exiting) return;
    const next = this.queue.shift()!;
    this.changed(true);
    void this.submit(next, true);
  }

  private addHistory(text: string) {
    if (this.history[this.history.length - 1] === text) return;
    this.history.push(text);
    try {
      mkdirSync(dirname(this.historyFile), { recursive: true });
      appendFileSync(this.historyFile, encodeHistory(text) + "\n");
    } catch {}
  }

  /** Read the clipboard's image and put an [Image #n] placeholder in the input. */
  pasteImage() {
    const r = clipboardImage();
    if ("error" in r) return this.flashHint(`Couldn't paste an image: ${r.error}`);
    if (r.data.length > MAX_IMAGE_BYTES) return this.flashHint("That image is too big to send (8 MB at most).");
    const n = ++this.imageCount;
    this.images.set(n, { type: "image", mediaType: r.mediaType, data: r.data.toString("base64") });
    this.edit(E.insert(this.ed, `[Image #${n}] `));
  }

  /**
   * A message as engine parts: the text, then its images. Images come from [Image #n]
   * placeholders (pasted) and from paths to image files written in the message (dropped files).
   */
  messageParts(text: string): Part[] {
    const parts: Part[] = [{ type: "text", text }];
    const used = new Set<number>();
    for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
      const n = Number(m[1]);
      const img = this.images.get(n);
      if (img && !used.has(n)) {
        used.add(n);
        parts.push(img);
      }
    }
    for (const n of used) this.images.delete(n);
    for (const p of imagePathsIn(text, this.s.data.cwd)) {
      if (parts.length > MAX_IMAGES) break;
      const img = imageFromFile(p);
      if (typeof img === "string") this.notice(img, "warn");
      else parts.push(img);
    }
    return parts;
  }

  private async busyWith<T>(activity: string, fn: () => Promise<T>): Promise<T> {
    this.busy = true;
    this.turnStart = Date.now();
    this.activity = activity;
    this.changed(true);
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.activity = "";
      this.changed(true);
    }
  }

  private async turn(text: string) {
    const parts = this.messageParts(text);
    this.push({ kind: "user", text });
    const nImages = parts.filter((p) => p.type === "image").length;
    if (nImages) this.push({ kind: "event", icon: "info", color: P.teal, text: `${nImages} image${nImages === 1 ? "" : "s"} attached` });
    const started = Date.now();
    await this.busyWith("Thinking", async () => {
      try {
        const stop = await this.s.prompt(parts, this);
        this.finishTurn();
        // Steering that arrived as the turn was ending: send it as the next message.
        if (this.steerPending.length) {
          this.queue.unshift(...this.steerPending.splice(0).map((t) => `${t}`));
        }
        if (stop === "cancelled") this.notice("Interrupted. Tell the agent what to do differently.", "warn");
        else if (stop === "max_tokens") this.notice("The answer hit the output token limit.", "warn");
        else if (stop === "max_turn_requests") this.notice("Stopped after too many steps in one turn.", "warn");
      } catch (e) {
        this.finishTurn();
        this.notice(`Error: ${(e as Error).message}`, "error");
      }
    });
    const ms = Date.now() - started;
    if (ms >= 5000) this.push({ kind: "done", text: `Worked for ${fmtDuration(ms)}` });
    if (this.filesDirty) {
      this.filesDirty = false;
      void this.files.load(true);
    }
  }

  private async runShell(command: string) {
    if (!command) return;
    const ac = new AbortController();
    this.shellAbort = ac;
    const started = Date.now();
    await this.busyWith(`Running ${command.split("\n")[0].slice(0, 40)}`, async () => {
      const sh = shellCommand(command);
      const r = await runProcess(sh.file, sh.args, this.s.data.cwd, 600_000, ac.signal);
      const output = stripAnsi(r.out).replace(/\r/g, "").replace(/\n+$/, "");
      const lines = output ? output.split("\n") : [];
      const hidden = Math.max(lines.length - 12, 0);
      if (hidden) this.expandables.push({ title: `!${command}`, text: output });
      const tail = r.cancelled ? "\n(cancelled)" : r.timedOut ? "\n(timed out)" : "";
      this.push({ kind: "shell", command, output: lines.slice(-12).join("\n") + tail, code: r.code, ms: Date.now() - started, hidden });
    });
    this.shellAbort = null;
    this.filesDirty = true;
  }

  // ---------------- slash commands ----------------

  private print = (t: string) => this.push({ kind: "print", text: t.replace(/\n+$/, "") });

  async command(line: string) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
      case "?": {
        const ext = getCommands().filter((c) => !BUILTIN.some((b) => b.name === c.name));
        const rows: [string, string][] = [...BUILTIN, ...ext].map((c) => [`/${c.name}`, `${c.description}${c.args ? st.dim(`  ${c.args}`) : ""}`]);
        return this.push({ kind: "help", rows, keys: KEYS });
      }
      case "model":
      case "models":
        return this.modelCommand(arg);
      case "mode": {
        if (!arg) {
          const cur = this.s.data.mode;
          this.openPicker({
            title: "Mode",
            rows: MODES.map((m) => ({ value: m.id, label: MODE_STYLE[m.id].label, detail: m.description, current: m.id === cur })),
            sel: Math.max(0, MODES.findIndex((m) => m.id === cur)),
            onPick: (r) => this.setMode(r.value as Mode),
          });
          return;
        }
        const m = MODES.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase() || MODE_STYLE[x.id].label === arg.toLowerCase());
        if (!m) return this.notice(`Modes: ${MODES.map((x) => x.id).join(", ")}`, "warn");
        return this.setMode(m.id);
      }
      case "effort": {
        if (!arg) {
          const cur = this.s.data.effort;
          this.openPicker({
            title: "Effort",
            rows: EFFORTS.map((e) => ({ value: e, label: e, current: e === cur, detail: e === "auto" ? "the model's default" : undefined })),
            sel: Math.max(0, EFFORTS.indexOf(cur as any)),
            onPick: (r) => {
              this.s.setEffort(r.value);
              this.notice(`Effort: ${r.value}`);
            },
          });
          return;
        }
        if (!(EFFORTS as readonly string[]).includes(arg)) return this.notice(`Effort: ${EFFORTS.join(", ")}`, "warn");
        this.s.setEffort(arg);
        return this.notice(`Effort: ${arg}`);
      }
      case "new":
        this.switchSession(Session.create(this.o.gateway, this.o.cfg, { cwd: this.s.data.cwd, model: this.s.data.model, mode: this.s.data.mode, effort: this.s.data.effort }));
        return this.notice("New session.");
      case "subagents":
      case "watch":
        return this.watchSubagents();
      case "sessions":
      case "resume": {
        if (arg) {
          const list = listSessionsCompat(this.s.data.cwd, 30, {});
          const n = Number(arg);
          const id = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1].id : arg;
          return this.resume(id);
        }
        return this.sessionPicker();
      }
      case "compact":
        await this.busyWith("Compacting", async () => {
          try {
            await this.s.compact(this);
          } catch (e) {
            this.notice(`Couldn't compact: ${(e as Error).message}`, "error");
          }
        });
        return;
      case "usage": {
        const u = this.s.data.usage;
        return this.print(`Input ${fmtK(u.input)} · cached reads ${fmtK(u.cacheRead)} · cache writes ${fmtK(u.cacheWrite)} · output ${fmtK(u.output)}\nContext: ${fmtK(this.s.data.contextUsed)} of ${fmtK(this.s.contextSize)} (${Math.round((this.s.data.contextUsed / this.s.contextSize) * 100)}%)`);
      }
      case "exit":
      case "quit":
        return this.exit();
      default: {
        const ext = getCommand(cmd);
        if (!ext) return this.notice(`Unknown command /${cmd}. Try /help.`, "warn");
        await this.busyWith(`/${cmd}`, async () => {
          try {
            await ext.run({ session: this.s, args: arg, ui: this, print: this.print });
          } catch (e) {
            this.notice(`/${cmd} failed: ${(e as Error).message}`, "error");
          }
        });
      }
    }
  }

  /** Sessions in this folder (Tab: all projects), subagent sessions nested; → shows a transcript. */
  sessionPicker(all = false) {
    const load = (all: boolean) => sessionRows(listSessionsCompat(this.s.data.cwd, 1000, { all, includeChildren: true }), { all, currentId: this.s.id });
    let scopeAll = all;
    let rows = load(scopeAll);
    if (!rows.length && !scopeAll) {
      scopeAll = true;
      rows = load(true);
    }
    if (!rows.length) return this.notice("No saved sessions yet.");
    const title = () => (scopeAll ? "Sessions · all projects" : "Sessions · this folder");
    const p = this.openPicker({
      title: title(),
      rows,
      sel: Math.max(0, rows.findIndex((r) => !r.current)),
      footer: `tab ${scopeAll ? "this folder" : "all projects"} · → transcript`,
      onPick: (r) => this.resume(r.value),
      onKey: (k, row) => {
        if (k.name === "tab" && !k.shift) {
          scopeAll = !scopeAll;
          p.rows = load(scopeAll);
          p.title = title();
          p.footer = `tab ${scopeAll ? "this folder" : "all projects"} · → transcript`;
          p.sel = 0;
          return true;
        }
        if (row && (k.name === "right" || (k.ctrl && k.name === "t"))) {
          this.openTranscript(row.value, p);
          return true;
        }
        return false;
      },
    });
  }

  openTranscript(id: string, back: PickerState | null = null) {
    const f = loadSession(id);
    if (!f) return this.notice("Couldn't read that session.", "warn");
    this.transcript = { id, title: f.title ?? f.id, lines: transcriptLines(f, Math.max(this.size.cols - 4, 20)), offset: 0, back };
    this.picker = null;
    this.changed(true);
  }

  /** Subagents of this session: open the running one, or pick among several. */
  watchSubagents() {
    const list = liveSubagents(this.s.id);
    if (!list.length) return this.notice("No subagents in this session yet. Saved ones from earlier are under /resume.");
    const running = list.filter((l) => l.status === "running");
    if (list.length === 1 || running.length === 1) return this.openLive((running[0] ?? list[0]).id, null);
    const p = this.openPicker({
      title: "Subagents",
      rows: list.map((l) => ({ value: l.id, label: l.title, detail: `${l.agentType} · ${l.model} · ${l.status === "running" ? "running" : l.status} · ${ago(l.started)}` })),
      footer: "enter watch",
      onPick: (r) => this.openLive(r.value, p),
    });
  }

  /** A subagent's chat that keeps updating while it works. */
  openLive(id: string, back: PickerState | null) {
    const entry = getLiveSubagent(id);
    if (!entry) return this.openTranscript(id, back);
    const width = () => Math.max(this.size.cols - 4, 20);
    const build = (): string[] => {
      const lines = transcriptLines(entry.session.data, width());
      if (entry.thinking.trim()) for (const l of entry.thinking.trim().split("\n").slice(-3)) lines.push(...wrapAnsi(st.italic(fg(P.dim)(`${G.think} ${l}`)), width()));
      if (entry.streaming.trim()) for (const l of entry.streaming.trim().split("\n")) lines.push(...wrapAnsi(l, width()));
      if (entry.tool) lines.push(fg(P.amber)(`${G.dot} ${entry.tool}…`));
      const state = entry.status === "running" ? fg(P.amber)("working…") : entry.status === "done" ? fg(P.green)("finished · enter to keep chatting with it") : fg(P.red)(entry.status);
      lines.push("", `${fg(P.dim)(`${entry.agentType} · ${entry.model} ·`)} ${state}`);
      return lines;
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const t = this.transcript;
      if (!t || t.id !== id || !t.live) return;
      t.lines = build();
      t.live.status = entry.status;
      if (t.live.follow) t.offset = Math.max(0, t.lines.length - this.transcriptHeight());
      this.changed();
    };
    const unsub = watchSubagent(id, () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 80);
    });
    const lines = build();
    this.transcript = { id, title: entry.title, lines, offset: Math.max(0, lines.length - this.transcriptHeight()), back, live: { follow: true, status: entry.status, unsub } };
    this.picker = null;
    this.changed(true);
  }

  /** Rows the transcript view shows at once. */
  transcriptHeight() {
    return Math.max(5, this.size.rows - 5);
  }

  private transcriptKey(k: KeyEvent) {
    const t = this.transcript!;
    const h = this.transcriptHeight();
    const max = Math.max(0, t.lines.length - h);
    const ch = k.name === "char" ? k.ch : "";
    if (k.name === "escape" || k.name === "left" || ch === "q" || (k.ctrl && k.name === "c") || (t.live && k.ctrl && k.name === "t")) {
      t.live?.unsub();
      this.transcript = null;
      this.picker = k.ctrl ? null : t.back;
      return this.changed(true);
    }
    if (k.name === "return") {
      if (t.live && t.live.status === "running") {
        this.hint = "Still working. Enter continues the chat once it has finished.";
        return this.changed(true);
      }
      if (this.busy && t.live) {
        this.hint = "The main session is still working; stop it (Esc) or wait, then continue with the subagent.";
        return this.changed(true);
      }
      t.live?.unsub();
      this.transcript = null;
      this.resume(t.id);
      return this.changed(true);
    }
    if (t.live) {
      if (["up", "pageup", "home"].includes(k.name) || ["k", "b", "g"].includes(ch)) t.live.follow = false;
      if (k.name === "end" || ch === "G") t.live.follow = true;
    }
    if (k.name === "up" || ch === "k") t.offset--;
    else if (k.name === "down" || ch === "j") t.offset++;
    else if (k.name === "pageup" || ch === "b") t.offset -= h - 1;
    else if (k.name === "pagedown" || ch === " " || k.name === "space") t.offset += h - 1;
    else if (k.name === "home" || ch === "g") t.offset = 0;
    else if (k.name === "end" || ch === "G") t.offset = max;
    else return;
    t.offset = Math.min(Math.max(t.offset, 0), max);
    this.changed(true);
  }

  private setMode(m: Mode) {
    this.s.setMode(m);
    this.notice(`Mode: ${MODE_STYLE[m].label} — ${MODES.find((x) => x.id === m)?.description ?? ""}`);
  }

  private async modelCommand(arg: string) {
    // "/model default …" and "/model project …" set what new sessions start with.
    const scoped = /^(default|global|project)\b\s*(.*)$/i.exec(arg);
    const scope = scoped ? (scoped[1].toLowerCase() === "project" ? "project" : "global") : null;
    const saveDefault = (m: string) => defaultModelCommand({ session: this.s, args: `${scope} ${m}`, ui: this, print: (t) => this.print(t) });
    if (scoped) arg = scoped[2].trim();
    const setModel = (m: string) => {
      if (scope) return void saveDefault(m);
      this.s.setModel(m);
      this.notice(`Model: ${m}`);
    };
    if (arg) {
      let list: string[] = [];
      try {
        list = (await this.o.gateway.models()).map((m) => m.id);
      } catch (e) {
        this.notice(`Couldn't list models: ${(e as Error).message}`, "warn");
      }
      // "sonnet-5-5" means the plain subscription model when several pools offer it.
      const exact = list.find((m) => m === arg) ?? list.find((m) => !m.includes("/") && (m === `claude-${arg}` || m.endsWith(arg)));
      const hits = exact ? [exact] : list.filter((m) => m.toLowerCase().includes(arg.toLowerCase()));
      if (hits.length === 1 || !list.length) return setModel(hits[0] ?? arg);
      if (!hits.length) return this.notice(`No model matches "${arg}".`, "warn");
      // Several match: let the person choose among them.
      const p = this.openPicker({ title: `Models matching "${arg}"`, rows: hits.map((m) => ({ value: m, label: m, current: m === this.s.data.model })), onPick: (r) => setModel(r.value) });
      void p;
      return;
    }
    const cur = scope === "project" ? (defaultModel(this.o.cfg, this.s.data.cwd) ?? this.s.data.model) : scope === "global" ? (loadConfig().model ?? this.s.data.model) : this.s.data.model;
    const title = scope === "project" ? "Default model for this project" : scope === "global" ? "Default model everywhere" : "Model";
    const p = this.openPicker({ title, rows: [], loading: true, footer: scope ? undefined : "/model project · /model default to save a default", onPick: (r) => setModel(r.value) });
    try {
      const models = await this.o.gateway.models();
      p.rows = groupModels(models).flatMap((g) => g.models.map((m) => ({ value: m, label: m, group: g.group, current: m === cur })));
      p.sel = Math.max(0, p.rows.findIndex((r) => r.current));
    } catch (e) {
      p.error = `Couldn't list models: ${(e as Error).message}`;
    }
    p.loading = false;
    this.changed(true);
  }

  private switchSession(next: Session) {
    const old = this.o.session;
    this.o.session = next;
    this.files.cwd = next.data.cwd;
    if (old !== next) void old.dispose().catch(() => {});
    this.changed(true);
  }

  private resume(id: string) {
    const f = loadSession(id);
    if (!f) return this.notice("No such session. See /resume.", "warn");
    if (f.id === this.s.id) return this.notice("That's the current session.");
    this.switchSession(new Session(f, this.o.gateway, this.o.cfg));
    this.replay();
  }

  /** Show the end of a resumed conversation. */
  replay(max = 12) {
    const f = this.s.data;
    this.push({ kind: "event", icon: "info", color: P.teal, text: `Resumed "${f.title ?? f.id}" · ${f.messages.length} messages · ${f.model}` });
    const msgs = f.messages.slice(-max);
    const results = new Map<string, { output: string; isError?: boolean }>();
    for (const m of f.messages) for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p);
    for (const m of msgs) {
      let first = true;
      for (const p of m.parts) {
        if (p.type === "text" && p.text.trim()) {
          if (m.role === "user") this.push({ kind: "user", text: p.text.length > 2000 ? p.text.slice(0, 2000) + "…" : p.text });
          else {
            this.push({ kind: "md", text: p.text, first });
            first = false;
          }
        } else if (p.type === "tool_call") {
          const r = results.get(p.id);
          const call: ToolCallInfo = { id: p.id, name: p.name, input: p.input, title: toolTitle(p.name, p.input), kind: "other", paths: [] };
          this.push({ kind: "tool", tool: { call, status: r?.isError ? "failed" : "done", started: 0, subs: [], summary: { lines: [], error: false, hidden: 0 } } });
          first = true;
        }
      }
    }
  }
}

function toolTitle(name: string, input: any): string {
  const i = input && typeof input === "object" ? input : {};
  const arg = i.description ?? i.path ?? i.pattern ?? i.command ?? i.prompt ?? "";
  return `${name}${arg ? ` ${String(arg).split("\n")[0].slice(0, 80)}` : ""}`;
}

// ---------------- history file ----------------

/** One entry per line; entries with newlines are stored as JSON strings. */
export function encodeHistory(text: string): string {
  return text.includes("\n") || text.startsWith('"') ? JSON.stringify(text) : text;
}

export function loadHistory(file: string, max = 1000): string[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-max)
      .map((l) => {
        if (l.startsWith('"')) {
          try {
            const v = JSON.parse(l);
            if (typeof v === "string") return v;
          } catch {}
        }
        return l;
      });
  } catch {
    return [];
  }
}
