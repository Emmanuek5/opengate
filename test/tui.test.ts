import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";

const home = mkdtempSync(join(tmpdir(), "og-tui-home-"));
process.env.OPENGATE_HOME = home;
// The UI falls back to ASCII glyphs in old Windows consoles; tests check the Unicode ones.
process.env.WT_SESSION ??= "tests";

const { render, cleanup } = await import("ink-testing-library");
const { Session } = await import("../src/agent");
const { Controller, encodeHistory, loadHistory } = await import("../src/tui/controller");
const { App, clipTail, inputLines } = await import("../src/tui/app");
const { decodeKey, isNewlineKey } = await import("../src/tui/keys");
const E = await import("../src/tui/editor");
const { fuzzyScore, tokenAt, walkFiles } = await import("../src/tui/complete");
const { parseMarkdown, stableCut, inline, highlightCode } = await import("../src/tui/markdown");
const { diffView } = await import("../src/tui/diff");
const { summarizeTool } = await import("../src/tui/format");
const { sessionRows, wrapAnsi, transcriptLines } = await import("../src/tui/sessions");
const { setColorLevel, stripAnsi } = await import("../src/tui/theme");
const ext = await import("../src/ext");
const tuiExports = await import("../src/tui");
import type { Llm, LlmRequest, LlmTurn } from "../src/types";

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(20);
}

class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(private script: ((req: LlmRequest) => Partial<LlmTurn> & { thinking?: string; gate?: Promise<void> })[]) {}
  async turn(req: LlmRequest, sink: { text(d: string): void; thinking(d: string): void }): Promise<LlmTurn> {
    this.calls.push(req);
    const next = this.script.shift();
    if (!next) throw new Error("no more scripted turns");
    const t = next(req);
    if (t.thinking) sink.thinking(t.thinking);
    if (t.gate) await t.gate;
    for (const p of t.parts ?? []) if (p.type === "text") sink.text(p.text);
    const parts = t.parts ?? [];
    return { parts, native: null, stop: t.stop ?? (parts.some((p) => p.type === "tool_call") ? "tool_use" : "end"), usage: { input: 1200, output: 30, cacheRead: 800, cacheWrite: 0 } };
  }
}

function setup(script: ConstructorParameters<typeof FakeLlm>[0] = [], opts: { files?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "og-tui-proj-"));
  for (const [p, body] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  const llm = new FakeLlm(script);
  const gw = { llm: () => llm, models: async () => [{ id: "claude-sonnet-5-5", ownedBy: null }, { id: "claude-haiku-5-5", ownedBy: null }, { id: "gpt-6", ownedBy: null }] } as any;
  const session = Session.create(gw, {}, { cwd: dir, model: "claude-sonnet-5-5" });
  const ctl = new Controller({ cfg: {}, gateway: gw, session, historyFile: join(dir, ".history"), size: () => ({ cols: 100, rows: 40 }) });
  ctl.start();
  const ui = render(createElement(App, { ctl }));
  const frame = () => stripAnsi(ui.lastFrame() ?? "");
  const type = async (s: string) => {
    ui.stdin.write(s);
    await wait();
  };
  return { dir, llm, ctl, ui, frame, type, session };
}

afterEach(() => cleanup());

describe("keys", () => {
  test("decodes legacy, kitty and modifyOtherKeys sequences", () => {
    expect(decodeKey("\r")).toMatchObject({ name: "return", shift: false });
    expect(decodeKey("a")).toMatchObject({ name: "char", ch: "a" });
    expect(decodeKey("\x1b[A")).toMatchObject({ name: "up" });
    expect(decodeKey("\x1b[1;5D")).toMatchObject({ name: "left", ctrl: true });
    expect(decodeKey("\x1b[Z")).toMatchObject({ name: "tab", shift: true });
    expect(decodeKey("\x03")).toMatchObject({ name: "c", ctrl: true });
    expect(decodeKey("\x1b[99;5u")).toMatchObject({ name: "c", ctrl: true });
    expect(decodeKey("\x1b[27u")).toMatchObject({ name: "escape" });
    expect(decodeKey("\x1b[3~")).toMatchObject({ name: "delete" });
    expect(decodeKey("\x1bb")).toMatchObject({ name: "b", meta: true });
    // every newline variant
    for (const s of ["\x1b[13;2u", "\x1b\r", "\n", "\x1b[27;2;13~", "\x1b[106;5u"]) expect(isNewlineKey(decodeKey(s)!)).toBe(true);
    expect(isNewlineKey(decodeKey("\r")!)).toBe(false);
  });
});

describe("editor", () => {
  test("edits, moves by word and line, and kills", () => {
    let e = E.insert(E.empty, "hello world");
    e = E.wordLeft(e);
    expect(e.cursor).toBe(6);
    e = E.deleteWordBefore(e);
    expect(e.text).toBe("world");
    e = E.edOf("ab\ncdef\ng", 5);
    expect(E.vertical(e, -1)!.cursor).toBe(2);
    expect(E.vertical(e, 1)!.cursor).toBe(9);
    expect(E.vertical(E.edOf("one", 1), -1)).toBeNull();
    expect(E.killBefore(e).text).toBe("ab\nef\ng");
    expect(E.killAfter(e).text).toBe("ab\ncd\ng");
    // surrogate pairs move as one character
    const emoji = E.edOf("a😀");
    expect(E.backspace(emoji).text).toBe("a");
  });

  test("typing, multi-line keys, cursor movement and backspace in the input box", async () => {
    const { type, frame, ctl } = setup();
    await type("hello");
    await type("\x1b\r"); // Alt+Enter
    await type("world");
    await type("\x1b[13;2u"); // Shift+Enter (kitty)
    await type("x");
    await type("\x7f");
    expect(ctl.ed.text).toBe("hello\nworld\n");
    await type("\x1b[A"); // up a line
    await type("\x01"); // Ctrl+A
    await type("> ");
    expect(ctl.ed.text).toBe("hello\n> world\n");
    expect(frame()).toContain("› hello");
    expect(frame()).toContain("> world");
    await type("\x03"); // Ctrl+C clears
    expect(ctl.ed.text).toBe("");
    expect(inputLines(E.edOf("ab", 1), "")[0]).toBe("a\x1b[7mb\x1b[27m");
  });

  test("a bracketed paste with newlines is one message, and long pastes collapse", async () => {
    const { type, ctl, frame } = setup();
    await type("\x1b[200~line one\nline two\x1b[201~");
    expect(ctl.ed.text).toBe("line one\nline two");
    await type("\x03");
    const big = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
    await type(`\x1b[200~${big}\x1b[201~`);
    expect(frame()).toContain("[Pasted text #1 +30 lines]");
  });

  test("history is saved, survives newlines and is browsed with Up/Down", async () => {
    const { type, ctl, dir } = setup();
    await ctl.submit("/usage");
    await ctl.submit("/help");
    await type("\x1b[A");
    expect(ctl.ed.text).toBe("/help");
    await type("\x1b[A");
    expect(ctl.ed.text).toBe("/usage");
    await type("\x1b[B");
    await type("\x1b[B");
    expect(ctl.ed.text).toBe("");
    expect(loadHistory(join(dir, ".history"))).toEqual(["/usage", "/help"]);
    const f = join(dir, "h2");
    writeFileSync(f, ["plain", encodeHistory("two\nlines")].join("\n") + "\n");
    expect(loadHistory(f)).toEqual(["plain", "two\nlines"]);
  });
});

describe("autocomplete", () => {
  test("fuzzy scores and tokens", () => {
    expect(fuzzyScore("mdl", "model")).not.toBeNull();
    expect(fuzzyScore("xyz", "model")).toBeNull();
    expect(fuzzyScore("tui", "src/tui.ts")!).toBeGreaterThan(fuzzyScore("tui", "test/util/index.ts") ?? -Infinity);
    expect(tokenAt("/mo", 3)).toMatchObject({ kind: "slash", query: "mo" });
    expect(tokenAt("look at @src/ap", 15)).toMatchObject({ kind: "mention", query: "src/ap", start: 8 });
    expect(tokenAt("email a@b", 9)).toBeNull();
  });

  test("/ commands list built-ins and registered commands; Tab completes", async () => {
    ext.registerCommand({ name: "tuitest", description: "a test command", run: ({ print }) => print("ran tuitest") });
    const { type, frame, ctl } = setup();
    await type("/mo");
    expect(frame()).toContain("/model");
    expect(frame()).toContain("/mode");
    await type("\t");
    expect(ctl.ed.text).toBe("/model ");
    await type("\x03");
    await type("/mode"); // an exact name beats a longer prefix match
    await type("\r");
    expect(ctl.picker?.title).toBe("Mode");
    await type("\x1b");
    await type("\x03");
    await type("/tuit");
    expect(frame()).toContain("a test command");
    await type("\r"); // Enter on a suggestion runs it
    await wait(60);
    expect(frame()).toContain("ran tuitest");
  });

  test("@ mentions fuzzy-match files and skip node_modules", async () => {
    const { type, frame, ctl, dir } = setup([], { files: { "src/app.tsx": "x", "src/util.ts": "y", "node_modules/pkg/index.js": "z", "README.md": "r" } });
    expect(await walkFiles(dir)).not.toContain("node_modules/pkg/index.js");
    await ctl.files.load();
    await type("see @apptsx");
    expect(frame()).toContain("src/app.tsx");
    expect(frame()).not.toContain("node_modules");
    await type("\t");
    expect(ctl.ed.text).toBe("see @src/app.tsx ");
  });
});

describe("rendering", () => {
  test("markdown blocks: headings, emphasis, lists, quotes, tables and code", () => {
    const b = parseMarkdown("# Title\n\nSome **bold**, *it* and `code`.\n\n- one\n  - nested\n1. first\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```");
    expect(b.map((x) => x.t).filter((t) => t !== "blank")).toEqual(["h", "p", "li", "li", "li", "quote", "table", "code"]);
    expect(stripAnsi((b[2] as any).text)).toBe("Some bold, it and code.");
    expect((b.find((x) => x.t === "li" && (x as any).indent === 1) as any).bullet).toBe("◦");
    expect((b.filter((x) => x.t === "li")[2] as any).bullet).toBe("1.");
    setColorLevel(3);
    try {
      expect(inline("**b**")).toBe("\x1b[1mb\x1b[22m");
      expect(highlightCode("const x = 1;", "ts").join("\n")).toContain("\x1b[38;2;");
      expect(stripAnsi(highlightCode("const x = 1;", "ts").join(""))).toBe("const x = 1;");
    } finally {
      setColorLevel(0);
    }
  });

  test("streamed text is committed at block boundaries, never inside a code fence", () => {
    expect(stableCut("para one\n\npara two")).toBe("para one\n\n".length);
    expect(stableCut("```js\nlet a;\n\nlet b;\n")).toBe(0);
    expect(stableCut("```js\nlet a;\n```\nmore")).toBe("```js\nlet a;\n```\n".length);
    const long = "```py\n" + Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const c = clipTail(long, 5, 80);
    expect(c.clipped).toBe(true);
    expect(c.text.startsWith("```py\n")).toBe(true);
    expect(c.text.endsWith("line49")).toBe(true);
  });

  test("diffs have line numbers, context and collapsed gaps", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const next = old.replace("l3\n", "L3\n").replace("l25\n", "L25\nnew\n");
    const v = diffView({ path: "f", oldText: old, newText: next });
    expect(v.added).toBe(3);
    expect(v.removed).toBe(2);
    expect(v.rows.find((r) => r.kind === "del" && r.text === "l3")!.no).toBe(3);
    expect(v.rows.find((r) => r.kind === "add" && r.text === "new")!.no).toBe(26);
    expect(v.rows.some((r) => r.kind === "gap")).toBe(true);
    const created = diffView({ path: "f", oldText: null, newText: "a\nb\n" });
    expect(created.rows.map((r) => [r.kind, r.no])).toEqual([["add", 1], ["add", 2]]);
  });

  test("tool summaries collapse long output", () => {
    const call = { id: "1", name: "shell", input: { command: "seq 20" }, title: "Run seq 20", kind: "execute" as const, paths: [] };
    const s = summarizeTool(call, { output: Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n") + "\nexit code: 0", exitCode: 0 });
    expect(s.lines).toEqual(["17", "18", "19", "20"]);
    expect(s.hidden).toBe(16);
    expect(s.full).toBeDefined();
  });

  test("a full turn: user message, thinking, markdown answer and a tool row; Ctrl+O expands", async () => {
    const out = Array.from({ length: 12 }, (_, i) => `out${i}`).join("\n");
    const { type, frame, dir } = setup([
      () => ({ thinking: "Let me look.\nStep two.\nStep three.\nStep four.", parts: [{ type: "text", text: "## Plan\n\nI'll **read** it.\n\n" }, { type: "tool_call", id: "r1", name: "read_file", input: { path: "a.txt" } }] }),
      () => ({ parts: [{ type: "text", text: "Done:\n\n- `a.txt` has " + out.length + " chars" }] }),
    ], { files: { "a.txt": out } });
    void dir;
    await type("read a.txt");
    await type("\r");
    await wait(150);
    const f = frame();
    expect(f).toContain("› read a.txt");
    expect(f).toContain("Thought");
    expect(f).toContain("Step four.");
    expect(f).toContain("… 1 earlier lines");
    expect(f).toContain("Plan");
    expect(f).toContain("I'll read it.");
    expect(f).toContain("● Read a.txt");
    expect(f).toContain("Read 12 lines");
    expect(f).toContain("• a.txt has");
    await type("\x0f"); // Ctrl+O: the thinking is the last collapsed thing
    expect(frame()).toContain("── Thinking ──");
    expect(frame()).toContain("Let me look.");
  });
});

describe("permission prompt", () => {
  test("shows the diff and the guard's reason; arrows + Enter pick 'always'", async () => {
    const { ctl, frame, type } = setup();
    const call = { id: "e1", name: "edit_file", input: {}, title: "Edit src/a.ts", kind: "edit" as const, paths: [], reason: "Touches a config file outside the task" };
    ctl.toolStart(call);
    const p = ctl.ask(call, { path: "src/a.ts", oldText: "one\ntwo\n", newText: "one\n2\n" });
    await wait();
    const f = frame();
    expect(f).toContain("Allow make this edit?");
    expect(f).toContain("! Touches a config file outside the task");
    expect(f).toContain("2 - two");
    expect(f).toContain("2 + 2");
    expect(f).toContain("1. Yes, allow once");
    await type("\x1b[B");
    await type("\r");
    expect(await p).toBe("always");
    // keys go back to the input afterwards
    await type("z");
    expect(ctl.ed.text).toBe("z");
  });

  test("Esc and 'n' deny; shell calls show the command", async () => {
    const { ctl, frame, type } = setup();
    const call = { id: "s1", name: "shell", input: { command: "rm -rf build" }, title: "Run rm -rf build", kind: "execute" as const, paths: [] };
    const p = ctl.ask(call, null);
    await wait();
    expect(frame()).toContain("$ rm -rf build");
    await type("n");
    expect(await p).toBe("deny");
    const p2 = ctl.ask(call, null);
    await wait();
    await type("\x1b");
    await wait(80);
    expect(await p2).toBe("deny");
  });

  test("a real turn asks, runs on 'y', and shows the result", async () => {
    const { frame, type, ctl } = setup([() => ({ parts: [{ type: "tool_call", id: "w1", name: "write_file", input: { path: "n.txt", content: "a\nb\n" } }] }), () => ({ parts: [{ type: "text", text: "Wrote it." }] })]);
    await type("make n.txt");
    await type("\r");
    await wait(80);
    expect(ctl.pending?.call.name).toBe("write_file");
    expect(frame()).toContain("1 + a");
    await type("y");
    await wait(120);
    expect(frame()).toContain("Wrote it.");
    expect(frame()).toContain("+2 -0");
  });
});

describe("events and queue", () => {
  test("subagent rows nest under their tool; memory/skill/mcp notices; unknown events ignored", async () => {
    const { ctl, frame } = setup();
    const call = { id: "t1", name: "task", input: {}, title: "Explore the code", kind: "other" as const, paths: [] };
    ctl.toolStart(call);
    ctl.event({ type: "subagent", id: "a1", parentCallId: "t1", status: "running", title: "explore auth", model: "claude-haiku-5-5", activity: "Reading src/auth.ts" });
    ctl.event({ type: "subagent", id: "a2", parentCallId: "t1", status: "running", title: "explore tests", model: "claude-haiku-5-5" });
    await wait();
    let f = frame();
    expect(f).toContain("Explore the code");
    expect(f).toMatch(/├ . explore auth \(claude-haiku-5-5\) · Reading src\/auth\.ts/);
    expect(f).toMatch(/└ . explore tests/);
    ctl.event({ type: "subagent", id: "a1", parentCallId: "t1", status: "done", title: "explore auth", model: "claude-haiku-5-5" });
    ctl.event({ type: "memory", action: "saved", scope: "project", name: "build steps" });
    ctl.event({ type: "skill", action: "loaded", name: "pdf" });
    ctl.event({ type: "mcp", server: "github", status: "connected", tools: ["a", "b"] });
    ctl.event({ type: "mcp", server: "db", status: "failed", error: "spawn ENOENT" });
    ctl.event({ type: "something-new", x: 1 });
    ctl.toolEnd(call, { output: "Found it" });
    await wait();
    f = frame();
    expect(f).toContain("✓ explore auth");
    expect(f).toContain("Memory saved: build steps (project)");
    expect(f).toContain("Skill loaded: pdf");
    expect(f).toContain("MCP github connected · 2 tools");
    expect(f).toContain("MCP db failed: spawn ENOENT");
    expect(f).toContain("Found it");
  });

  test("messages typed during a turn are queued, shown, and sent afterwards; Esc gives them back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ctl, frame, type, llm } = setup([() => ({ gate, parts: [{ type: "text", text: "first answer" }] }), () => ({ parts: [{ type: "text", text: "second answer" }] })]);
    await type("one");
    await type("\r");
    await type("two");
    await type("\r");
    expect(ctl.busy).toBe(true);
    expect(frame()).toContain("queued two");
    expect(frame()).toContain("esc to interrupt");
    release();
    await wait(150);
    expect(frame()).toContain("second answer");
    expect(llm.calls.length).toBe(2);
    expect(ctl.queue.length).toBe(0);
  });

  test("Esc interrupts and returns queued text to the input", async () => {
    const { ctl, type } = setup([(req) => ({ gate: new Promise<void>((r) => req.signal?.addEventListener("abort", () => r())), parts: [] })]);
    await type("long task");
    await type("\r");
    await type("later");
    await type("\r");
    await type("\x1b");
    await wait(100);
    expect(ctl.busy).toBe(false);
    expect(ctl.ed.text).toBe("later");
  });

  test("Shift+Tab cycles modes and the status bar shows mode, context and tokens", async () => {
    const { ctl, type, frame, session } = setup();
    expect(frame()).toContain("claude-sonnet-5-5 · ask · effort auto");
    await type("\x1b[Z");
    expect(session.data.mode).toBe("edits");
    expect(frame()).toContain("auto-edit");
    await type("\x1b[Z");
    await type("\x1b[Z");
    expect(frame()).toContain("full-auto");
    await type("\x1b[Z");
    expect(session.data.mode).toBe("ask");
    session.data.usage = { input: 1500, cacheRead: 12_000, cacheWrite: 0, output: 900 };
    session.data.contextUsed = 100_000;
    ctl.changed(true);
    await wait();
    expect(frame()).toContain("50%");
    expect(frame()).toContain("13.5k in 12.0k cached 900 out");
  });

  test("! runs a shell command and shows its output", async () => {
    const { type, frame } = setup();
    await type("!echo hi-from-shell");
    await type("\r");
    await until(() => frame().includes("· 0s") || frame().includes("· 1s"));
    expect(frame()).toContain("! echo hi-from-shell");
    expect(frame()).toContain("hi-from-shell");
  });
});

describe("pickers", () => {
  test("/model groups models, filters by typing, and switches", async () => {
    const { type, frame, session } = setup();
    await ctlSubmit(type, "/model");
    await wait(60);
    expect(frame()).toContain("claude-sonnet-5-5 ✓");
    await type("gpt");
    expect(frame()).toContain("gpt-6");
    expect(frame()).not.toContain("claude-haiku-5-5");
    await type("\r");
    await wait();
    expect(session.data.model).toBe("gpt-6");
  });

  test("/mode and /effort pickers", async () => {
    const { type, session } = setup();
    await ctlSubmit(type, "/mode");
    await type("\x1b[B");
    await type("\x1b[B");
    await type("\r");
    expect(session.data.mode).toBe("auto");
    await ctlSubmit(type, "/effort");
    await type("hig");
    await type("\r");
    expect(session.data.effort).toBe("high");
  });

  test("session rows nest subagent sessions, and the transcript view scrolls", async () => {
    const base = { mode: "ask" as const, effort: "auto", created: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextUsed: 0 };
    const rows = sessionRows(
      [
        { ...base, id: "p1", cwd: "/w", title: "Parent", model: "m", updated: Date.now(), messageCount: 4 },
        { ...base, id: "c1", cwd: "/w", title: "Child", model: "m", updated: Date.now(), parentId: "p1", agentLabel: "explore", messageCount: 2 },
        { ...base, id: "p2", cwd: "/x", title: "Other", model: "m", updated: Date.now() },
      ],
      { all: true, currentId: "p2" },
    );
    expect(rows.map((r) => [r.value, r.indent])).toEqual([["p1", 0], ["c1", 1], ["p2", 0]]);
    expect(rows[1].label).toBe("explore · Child");
    expect(rows[0].detail).toContain("4 msgs");
    expect(rows[2].current).toBe(true);
    expect(wrapAnsi("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);

    // a saved session, picked from /resume, viewed with →
    const { type, frame, ctl, session } = setup([() => ({ parts: [{ type: "text", text: "old answer" }] })]);
    await session.prompt([{ type: "text", text: "old question" }], ctl);
    const oldId = session.id;
    await ctlSubmit(type, "/new");
    expect(ctl.session.id).not.toBe(oldId);
    await ctlSubmit(type, "/resume");
    expect(frame()).toContain("Sessions · this folder");
    expect(frame()).toContain("old question");
    expect(frame()).toMatch(/1 msgs?|2 msgs/);
    await type("\t");
    expect(frame()).toContain("Sessions · all projects");
    await type("old q");
    expect(frame()).toContain("old question");
    await type("\x1b[C");
    expect(frame()).toContain("Transcript");
    expect(frame()).toContain("› old question");
    expect(frame()).toContain("● old answer");
    await type("\r");
    expect(ctl.session.id).toBe(oldId);
    const lines = transcriptLines(ctl.session.data, 60).map(stripAnsi);
    expect(lines[0]).toBe("old question");
  });
});

test("exports used by cli.ts", () => {
  expect(typeof tuiExports.Tui).toBe("function");
  expect(typeof tuiExports.PrintUI).toBe("function");
  expect(typeof tuiExports.c.bold).toBe("function");
  expect(tuiExports.ago(Date.now())).toBe("just now");
  void readFileSync;
});

async function ctlSubmit(type: (s: string) => Promise<void>, text: string) {
  await type(text);
  await type("\x1b"); // close the suggestion popup so Enter sends what was typed
  await type("\r");
  await wait(40);
}

describe("live subagent view", () => {
  test("Ctrl+T opens a running subagent's chat, follows it, and Enter continues with it once done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ctl, frame, type, session } = setup([
      () => ({ parts: [{ type: "tool_call", id: "a1", name: "agent", input: { description: "check things", prompt: "look around" } }] }),
      () => ({ thinking: "pondering the layout", gate, parts: [{ type: "text", text: "child says hello" }] }),
      () => ({ parts: [{ type: "text", text: "all done" }] }),
    ]);
    await type("delegate it");
    await type("\r");
    await until(() => ctl.tools.some((t) => t.subs.some((s) => s.status === "running")));
    expect(frame()).toContain("ctrl+t to watch");
    await type("\x14"); // Ctrl+T
    await until(() => !!ctl.transcript?.live);
    expect(frame()).toContain("Subagent");
    expect(frame()).toContain("check things");
    await until(() => frame().includes("pondering the layout"));
    expect(frame()).toContain("live");
    await type("\r");
    expect(ctl.hint).toContain("Still working");
    expect(ctl.transcript?.live).toBeTruthy();
    release();
    await until(() => ctl.transcript?.live?.status === "done");
    await until(() => frame().includes("child says hello"));
    await until(() => !ctl.busy);
    const childId = ctl.transcript!.id;
    await type("\r");
    await until(() => ctl.s.id === childId);
    expect(ctl.s.data.parentId).toBe(session.id);
  });
});
