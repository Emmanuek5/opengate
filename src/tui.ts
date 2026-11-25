import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import { Session, type AgentUI, type Decision, type ToolCallInfo } from "./agent";
import { dataDir, EFFORTS, MODES, VERSION, type Config, type Mode } from "./config";
import { Gateway, groupModels } from "./gateway";
import { listSessions, loadSession } from "./store";
import type { Diff, ToolResult } from "./tools";
import { getCommand, getCommands } from "./ext";

// ---------------- colors ----------------

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

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const fmtK = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A short line diff: the changed middle of the file, at most `max` lines. */
export function diffLines(d: Diff, max = 16): string[] {
  const split = (t: string) => {
    const l = t.split("\n");
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    return l;
  };
  const a = split(d.oldText ?? "");
  const b = split(d.newText);
  if (d.oldText === null) return b.slice(0, max).map((l) => c.green(`+ ${l}`)).concat(b.length > max ? [c.dim(`  … ${b.length - max} more lines`)] : []);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const out: string[] = [];
  const removed = a.slice(s, ea + 1);
  const added = b.slice(s, eb + 1);
  out.push(c.dim(`  @ line ${s + 1}`));
  for (const l of removed.slice(0, max / 2)) out.push(c.red(`- ${l}`));
  if (removed.length > max / 2) out.push(c.dim(`  … ${removed.length - max / 2} more removed`));
  for (const l of added.slice(0, max / 2)) out.push(c.green(`+ ${l}`));
  if (added.length > max / 2) out.push(c.dim(`  … ${added.length - max / 2} more added`));
  return out;
}

function resultSummary(call: ToolCallInfo, r: ToolResult, diffShown = false): string[] {
  const pad = (l: string) => `  ${c.gray("⎿")} ${l}`;
  if (r.diff && !r.isError) {
    const lines = diffShown ? [] : diffLines(r.diff);
    return [pad(c.dim(r.output)), ...lines.map((l) => `    ${l}`)];
  }
  const lines = r.output.split("\n");
  if (call.kind === "read" && !r.isError) return [pad(c.dim(`${lines.filter((l) => /^\s*\d+\t/.test(l)).length} lines`))];
  if (call.kind === "search" && !r.isError) return [pad(c.dim(r.output === "No matches." || r.output === "No files found." ? r.output : `${lines.length} results`))];
  const shown = call.kind === "execute" ? lines.slice(-6) : lines.slice(0, 6);
  const col = r.isError ? c.red : c.dim;
  return shown.map((l, i) => (i === 0 ? pad(col(l.slice(0, 200))) : `    ${col(l.slice(0, 200))}`));
}

// ---------------- the terminal UI ----------------

export interface TuiOptions {
  cfg: Config;
  gateway: Gateway;
  session: Session;
  initialPrompt?: string;
}

export class Tui implements AgentUI {
  private rl!: readline.Interface;
  private pendingLine: ((line: string | null) => void) | null = null;
  private inThinking = false;
  private atLineStart = true;
  private paste: string[] = [];
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCtrlC = 0;
  private historyFile = join(dataDir(), "history");
  private askedId: string | null = null;

  constructor(private o: TuiOptions) {}

  get s() {
    return this.o.session;
  }

  // ----- AgentUI -----
  private write(s: string) {
    if (!s) return;
    process.stdout.write(s);
    this.atLineStart = s.endsWith("\n");
  }
  private newline() {
    if (!this.atLineStart) this.write("\n");
  }
  text(d: string) {
    if (this.inThinking) {
      this.inThinking = false;
      this.newline();
      this.write("\n");
    }
    this.write(d);
  }
  thinking(d: string) {
    if (!this.inThinking) {
      this.inThinking = true;
      this.newline();
      this.write(c.gray(c.italic("✻ ")));
    }
    this.write(c.gray(c.italic(d)));
  }
  step() {
    this.inThinking = false;
  }
  toolStart(call: ToolCallInfo) {
    this.inThinking = false;
    this.newline();
    const color = call.kind === "execute" ? c.yellow : call.kind === "edit" ? c.magenta : c.cyan;
    let line = `${color("●")} ${c.bold(call.title)}`;
    if (call.kind === "execute" && call.input?.command && call.title !== `Run ${String(call.input.command).split("\n")[0].slice(0, 80)}`) line += `\n  ${c.dim("$ " + String(call.input.command).split("\n")[0].slice(0, 160))}`;
    this.write(line + "\n");
  }
  toolEnd(call: ToolCallInfo, r: ToolResult) {
    this.write(resultSummary(call, r, this.askedId === call.id).join("\n") + "\n");
  }
  async ask(call: ToolCallInfo, diff: Diff | null): Promise<Decision> {
    this.newline();
    if (diff) this.askedId = call.id;
    if (diff) this.write(diffLines(diff, 24).map((l) => `    ${l}`).join("\n") + "\n");
    if (call.kind === "execute") this.write(`    ${c.yellow("$ " + String(call.input?.command ?? ""))}\n`);
    const what = call.kind === "execute" ? "run this command" : "make this change";
    const ans = (await this.readLine(`${c.yellow("?")} Allow ${call.name} to ${what}? ${c.dim("[y]es / [a]lways / [n]o")} `))?.trim().toLowerCase() ?? "n";
    if (ans === "a" || ans === "always") return "always";
    if (ans === "y" || ans === "yes" || ans === "") return "once";
    return "deny";
  }
  notice(message: string, level: "info" | "warn" | "error") {
    this.newline();
    const col = level === "error" ? c.red : level === "warn" ? c.yellow : c.dim;
    this.write(col(message) + "\n");
  }
  usage() {}

  // ----- input -----
  private readLine(prompt: string): Promise<string | null> {
    return new Promise((res) => {
      this.pendingLine = res;
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  private promptText() {
    const mode = this.s.data.mode;
    const tag = mode === "yolo" ? c.red(" full-auto") : mode === "auto" ? c.yellow(" auto") : mode === "edits" ? c.magenta(" auto-edit") : "";
    return `${c.cyan("›")}${tag} `;
  }

  private status() {
    const s = this.s.data;
    const pct = s.contextUsed ? ` · context ${Math.round((s.contextUsed / this.s.contextSize) * 100)}%` : "";
    return c.dim(`${s.model} · ${MODES.find((m) => m.id === s.mode)?.name ?? s.mode}${s.effort !== "auto" ? ` · effort ${s.effort}` : ""}${pct}`);
  }

  async run(): Promise<void> {
    const history = existsSync(this.historyFile) ? readFileSync(this.historyFile, "utf8").split("\n").filter(Boolean).slice(-500).reverse() : [];
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY, history, historySize: 500, prompt: this.promptText() });
    if (process.stdin.isTTY) {
      // Shift+Tab cycles the permission mode.
      process.stdin.on("keypress", (_s, key) => {
        if (key?.name === "tab" && key.shift && !this.s.busy && !this.pendingLine) {
          const i = MODES.findIndex((m) => m.id === this.s.data.mode);
          this.s.setMode(MODES[(i + 1) % MODES.length].id);
          this.rl.setPrompt(this.promptText());
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          this.rl.prompt(true);
        }
      });
    }
    this.rl.on("SIGINT", () => this.onCtrlC());
    this.rl.on("close", () => {
      if (this.pendingLine) {
        const p = this.pendingLine;
        this.pendingLine = null;
        p(null);
        return;
      }
      if (this.s.busy) this.s.cancel();
      this.write("\n");
      process.exit(0);
    });
    this.rl.on("line", (line) => this.onLine(line));

    this.write(`${c.bold("opengate")} ${c.dim(VERSION)}  ${c.dim(tilde(this.s.data.cwd))}\n${this.status()}\n${c.dim("/help for commands · Shift+Tab changes mode · Ctrl+C stops · Ctrl+D quits")}\n`);
    if (this.s.data.messages.length) this.write(c.dim(`Resumed "${this.s.data.title ?? this.s.id}" (${this.s.data.messages.length} messages)\n`));
    this.write("\n");
    if (this.o.initialPrompt) await this.submit(this.o.initialPrompt);
    else this.showPrompt();
  }

  private showPrompt() {
    this.rl.setPrompt(this.promptText());
    this.rl.prompt();
  }

  private onCtrlC() {
    if (this.pendingLine) {
      const p = this.pendingLine;
      this.pendingLine = null;
      this.write("\n");
      p("n");
      return;
    }
    if (this.s.busy) {
      this.s.cancel();
      this.notice("Stopping…", "warn");
      return;
    }
    const now = Date.now();
    if ((this.rl as any).line) {
      (this.rl as any).line = "";
      this.write("\n");
      this.showPrompt();
      return;
    }
    if (now - this.lastCtrlC < 1500) {
      this.write("\n");
      process.exit(0);
    }
    this.lastCtrlC = now;
    this.write(c.dim("\n(press Ctrl+C again or Ctrl+D to quit)\n"));
    this.showPrompt();
  }

  private onLine(line: string) {
    if (this.pendingLine) {
      const p = this.pendingLine;
      this.pendingLine = null;
      p(line);
      return;
    }
    if (this.s.busy) return;
    // Pasted text arrives as many lines at once: gather them into one prompt.
    this.paste.push(line);
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      const text = this.paste.join("\n");
      this.paste = [];
      if (text.endsWith("\\")) {
        this.paste.push(text.slice(0, -1));
        this.rl.setPrompt(c.dim("… "));
        this.rl.prompt();
        return;
      }
      void this.submit(text);
    }, 25);
  }

  private async submit(raw: string) {
    const text = raw.trim();
    if (!text) return this.showPrompt();
    try {
      appendFileSync(this.historyFile, text.replace(/\n/g, " ") + "\n");
    } catch {
      mkdirSync(dataDir(), { recursive: true });
    }
    if (text.startsWith("/") && !text.startsWith("//")) {
      await this.command(text);
      return this.showPrompt();
    }
    this.write("\n");
    try {
      const stop = await this.s.prompt([{ type: "text", text }], this);
      this.newline();
      if (stop === "cancelled") this.write(c.yellow("Stopped.\n"));
      else if (stop === "max_tokens") this.write(c.yellow("The answer hit the output token limit.\n"));
      else if (stop === "max_turn_requests") this.write(c.yellow("Stopped after too many steps in one turn.\n"));
    } catch (e) {
      this.newline();
      this.write(c.red(`Error: ${(e as Error).message}\n`));
    }
    const u = this.s.data.usage;
    this.write(c.dim(`\n${this.status()} · ${fmtK(u.input + u.cacheRead + u.cacheWrite)} in (${fmtK(u.cacheRead)} cached) · ${fmtK(u.output)} out\n\n`));
    this.showPrompt();
  }

  // ----- slash commands -----
  private async command(line: string) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
      case "?":
        this.write(
          [
            "",
            `${c.bold("/model")} [name]     pick a model (lists them without a name; partial names work)`,
            `${c.bold("/mode")} [ask|edits|auto]  when to ask before edits and commands`,
            `${c.bold("/effort")} [${EFFORTS.join("|")}]`,
            `${c.bold("/new")}              start a new session`,
            `${c.bold("/sessions")}         recent sessions in this folder`,
            `${c.bold("/resume")} [n|id]    continue a session`,
            `${c.bold("/compact")}          summarize the conversation to free up context`,
            `${c.bold("/usage")}            tokens used in this session`,
            `${c.bold("/exit")}             quit`,
            ...getCommands().map((x) => `${c.bold("/" + x.name)}${x.args ? " " + x.args : ""}  ${x.description}`),
            c.dim("End a line with \\ to keep typing on the next line. Pasting several lines sends them as one message."),
            "",
          ].join("\n") + "\n",
        );
        return;
      case "model":
      case "models": {
        let list: string[] = [];
        try {
          list = (await this.o.gateway.models()).map((m) => m.id);
        } catch (e) {
          this.notice(`Couldn't list models: ${(e as Error).message}`, "error");
        }
        if (arg) {
          // "sonnet-5-5" means the plain subscription model when several pools offer it.
          const exact = list.find((m) => m === arg) ?? list.find((m) => !m.includes("/") && (m === `claude-${arg}` || m.endsWith(arg)));
          const hits = exact ? [exact] : list.filter((m) => m.toLowerCase().includes(arg.toLowerCase()));
          if (hits.length === 1 || (!list.length && arg)) {
            this.s.setModel(hits[0] ?? arg);
            this.write(`Model: ${c.bold(this.s.data.model)}\n`);
            return;
          }
          if (!hits.length) return this.notice(`No model matches "${arg}".`, "warn");
          this.write(hits.map((m) => `  ${m}`).join("\n") + "\n");
          return this.notice(`${hits.length} models match; be more specific.`, "info");
        }
        for (const g of groupModels(list.map((id) => ({ id, ownedBy: null })))) {
          this.write(`${c.bold(g.group)}\n`);
          this.write(g.models.map((m) => (m === this.s.data.model ? c.green(`● ${m}`) : `  ${m}`)).join("\n") + "\n");
        }
        this.write(c.dim(`Current: ${this.s.data.model}. Switch with /model <name>.\n`));
        return;
      }
      case "mode": {
        const m = MODES.find((x) => x.id === arg || x.name.toLowerCase() === arg.toLowerCase());
        if (!arg) return this.write(MODES.map((x) => `${x.id === this.s.data.mode ? c.green("●") : " "} ${c.bold(x.id.padEnd(6))} ${x.description}`).join("\n") + "\n");
        if (!m) return this.notice(`Modes: ${MODES.map((x) => x.id).join(", ")}`, "warn");
        this.s.setMode(m.id as Mode);
        this.write(`Mode: ${c.bold(m.name)} — ${m.description}\n`);
        return;
      }
      case "effort":
        if (!arg) return this.write(`Effort: ${this.s.data.effort} (${EFFORTS.join(", ")})\n`);
        if (!(EFFORTS as readonly string[]).includes(arg)) return this.notice(`Effort: ${EFFORTS.join(", ")}`, "warn");
        this.s.setEffort(arg);
        this.write(`Effort: ${c.bold(arg)}\n`);
        return;
      case "new":
        this.o.session = Session.create(this.o.gateway, this.o.cfg, { cwd: this.s.data.cwd, model: this.s.data.model, mode: this.s.data.mode, effort: this.s.data.effort });
        this.write(c.dim("New session.\n"));
        return;
      case "sessions": {
        const list = listSessions(this.s.data.cwd, 15);
        if (!list.length) return this.notice("No saved sessions in this folder.", "info");
        list.forEach((m, i) => this.write(`${c.dim(String(i + 1).padStart(2))} ${m.id === this.s.id ? c.green("●") : " "} ${(m.title ?? "(untitled)").slice(0, 60).padEnd(60)} ${c.dim(`${ago(m.updated)} · ${m.model}`)}\n`));
        this.write(c.dim("Continue one with /resume <n>.\n"));
        return;
      }
      case "resume": {
        const list = listSessions(this.s.data.cwd, 15);
        const n = Number(arg);
        const id = !arg ? list.find((m) => m.id !== this.s.id)?.id : Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1].id : arg;
        const f = id ? loadSession(id) : null;
        if (!f) return this.notice("No such session. See /sessions.", "warn");
        this.o.session = new Session(f, this.o.gateway, this.o.cfg);
        this.write(c.dim(`Resumed "${f.title ?? f.id}" (${f.messages.length} messages, ${f.model}).\n`));
        printTranscript(f.messages.slice(-6), (s) => this.write(s));
        return;
      }
      case "compact":
        try {
          await this.s.compact(this);
        } catch (e) {
          this.notice(`Couldn't compact: ${(e as Error).message}`, "error");
        }
        return;
      case "usage": {
        const u = this.s.data.usage;
        this.write(`Input ${fmtK(u.input)} · cached reads ${fmtK(u.cacheRead)} · cache writes ${fmtK(u.cacheWrite)} · output ${fmtK(u.output)}\nContext: ${fmtK(this.s.data.contextUsed)} of ${fmtK(this.s.contextSize)}\n`);
        return;
      }
      case "exit":
      case "quit":
        process.exit(0);
      default: {
        const ext = getCommand(cmd);
        if (ext) {
          try {
            await ext.run({ session: this.s, args: arg, ui: this, print: (t) => this.write(t.endsWith("\n") ? t : t + "\n") });
          } catch (e) {
            this.notice(`/${cmd} failed: ${(e as Error).message}`, "error");
          }
          return;
        }
        this.notice(`Unknown command /${cmd}. Try /help.`, "warn");
      }
    }
  }
}

export function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function printTranscript(messages: Session["data"]["messages"], write: (s: string) => void) {
  for (const m of messages)
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) write((m.role === "user" ? c.cyan("› ") : "") + (m.role === "user" ? p.text : p.text).slice(0, 600) + "\n");
      else if (p.type === "tool_call") write(c.dim(`● ${p.name}\n`));
    }
  write("\n");
}

// ---------------- print mode ----------------

/** `opengate -p "…"`: run one prompt, print the answer to stdout, activity to stderr. */
export class PrintUI implements AgentUI {
  private err = (s: string) => process.stderr.write(s);
  text(d: string) {
    process.stdout.write(d);
  }
  thinking() {}
  toolStart(call: ToolCallInfo) {
    this.err(c.dim(`● ${call.title}\n`));
  }
  toolEnd(call: ToolCallInfo, r: ToolResult) {
    if (r.isError) this.err(c.red(`  ${r.output.split("\n")[0].slice(0, 200)}\n`));
  }
  async ask(call: ToolCallInfo): Promise<Decision> {
    this.err(c.yellow(`  not allowed in ${call.kind === "execute" ? "this mode (use --mode auto)" : "ask mode (use --mode edits or auto)"}\n`));
    return "deny";
  }
  notice(message: string) {
    this.err(c.dim(message + "\n"));
  }
}
