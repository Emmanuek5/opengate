import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "og-mem-home-"));
process.env.OPENGATE_HOME = home;

const { Session } = await import("../src/agent");
const mem = await import("../src/memory");
const ext = await import("../src/ext");
import type { Llm, LlmRequest, LlmTurn } from "../src/types";

/** A model that plays back scripted turns and records what it was sent. */
class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(private script: ((req: LlmRequest) => Partial<LlmTurn>)[]) {}
  async turn(req: LlmRequest, sink: { text(d: string): void; thinking(d: string): void }): Promise<LlmTurn> {
    this.calls.push(structuredClone({ ...req, signal: undefined }));
    const next = this.script.shift();
    if (!next) throw new Error("no more scripted turns");
    const t = next(req);
    for (const p of t.parts ?? []) if (p.type === "text") sink.text(p.text);
    const parts = t.parts ?? [];
    return { parts, native: t.native ?? null, stop: t.stop ?? (parts.some((p) => p.type === "tool_call") ? "tool_use" : "end"), usage: t.usage ?? { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
  }
}

const ui = () => {
  const log: string[] = [];
  const events: any[] = [];
  return {
    log,
    events,
    text: (d: string) => log.push(`text:${d}`),
    thinking: () => {},
    toolStart: (c: any) => log.push(`start:${c.name}`),
    toolEnd: (c: any, r: any) => log.push(`end:${c.name}:${r.isError ? "error" : "ok"}`),
    ask: async (c: any) => {
      log.push(`ask:${c.name}`);
      return "deny" as const;
    },
    event: (e: any) => events.push(e),
  };
};

let dir: string;
beforeEach(() => {
  rmSync(join(home, "config", "memory"), { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "og-mem-proj-"));
});

const session = (llm: Llm = new FakeLlm([]), cwd = dir) => Session.create({ llm: () => llm }, {}, { cwd, model: "m" });

const runCommand = async (s: InstanceType<typeof Session>, args: string, u = ui()) => {
  const out: string[] = [];
  await ext.getCommand("memory")!.run({ session: s, args, print: (t) => out.push(t), ui: u });
  return out.join("\n");
};

describe("locations", () => {
  test("project root is the git root above the cwd, else the cwd", () => {
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(mem.projectRoot(sub)).toBe(sub);
    mkdirSync(join(dir, ".git"));
    expect(mem.projectRoot(sub)).toBe(dir);
    expect(mem.projectMemoryDir(sub)).toBe(mem.projectMemoryDir(dir));
    expect(mem.projectMemoryDir(dir).startsWith(join(home, "data", "projects"))).toBe(true);
    expect(mem.globalMemoryDir()).toBe(join(home, "config", "memory"));
  });

  test("slugs are readable, stable, filesystem-safe, and Windows paths fold case", () => {
    const a = mem.projectSlug("/home/me/My Project");
    // Windows folds case (C:\\App and c:\\app are one folder); elsewhere case is kept.
    expect(a).toMatch(process.platform === "win32" ? /^home-me-my-project-[0-9a-f]{8}$/ : /^home-me-My-Project-[0-9a-f]{8}$/);
    expect(mem.projectSlug("/home/me/My Project")).toBe(a);
    expect(mem.projectSlug("/home/me/My Project/")).toBe(a);
    expect(mem.projectSlug("/home/me/my-project")).not.toBe(a);
    const w = mem.projectSlug("C:\\Users\\Me\\Code\\app", "win32");
    expect(w).toMatch(/^c-users-me-code-app-[0-9a-f]{8}$/);
    expect(mem.projectSlug("c:/users/me/code/app", "win32")).toBe(w);
    for (const s of [a, w, mem.projectSlug("/"), mem.projectSlug("\\\\server\\share\\..\\x", "win32")]) expect(s).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(mem.projectSlug("/" + "x".repeat(300)).length).toBeLessThanOrEqual(70);
  });
});

describe("storage", () => {
  test("names must be kebab-case and stay inside the folder", () => {
    for (const ok of ["prefers-bun", "a", "x1-y2"]) expect(mem.nameError(ok)).toBeNull();
    for (const bad of ["", "Prefers-Bun", "a_b", "a--b", "-a", "a-", "../x", "a/b", "a\\b", "..", "con", "memory", "x".repeat(65), 42])
      expect(mem.nameError(bad)).not.toBeNull();
    expect(() => mem.memoryFile(dir, "../../etc/passwd")).toThrow();
    expect(() => mem.memoryFile(dir, "..\\x")).toThrow();
    expect(mem.memoryFile(dir, "ok-name")).toBe(join(dir, "ok-name.md"));
  });

  test("files have frontmatter, the index is kept up to date, and delete removes both", () => {
    const d = join(dir, "mem");
    const m = mem.writeMemory(d, "project", { name: "uses-bun", type: "project", description: "Use bun,\nnot npm", body: "Run `bun test`.\r\nAlways.", updated: "2026-01-02T00:00:00.000Z" });
    expect(m.description).toBe("Use bun, not npm");
    expect(readFileSync(join(d, "uses-bun.md"), "utf8")).toBe(
      "---\nname: uses-bun\ndescription: Use bun, not npm\ntype: project\nupdated: 2026-01-02T00:00:00.000Z\n---\n\nRun `bun test`.\nAlways.\n",
    );
    mem.writeMemory(d, "project", { name: "api-docs", type: "reference", description: "API docs live in docs/api", body: "See docs/api." });
    const index = readFileSync(join(d, "MEMORY.md"), "utf8");
    expect(index).toContain("- [api-docs](api-docs.md) (reference): API docs live in docs/api\n- [uses-bun](uses-bun.md) (project): Use bun, not npm\n");
    expect(mem.listMemories(d, "project").map((x) => x.name)).toEqual(["api-docs", "uses-bun"]);
    expect(mem.readMemory(d, "project", "uses-bun")).toMatchObject({ type: "project", body: "Run `bun test`.\nAlways.", updated: "2026-01-02T00:00:00.000Z" });
    expect(mem.deleteMemory(d, "project", "uses-bun")).toBe(true);
    expect(mem.deleteMemory(d, "project", "uses-bun")).toBe(false);
    expect(existsSync(join(d, "uses-bun.md"))).toBe(false);
    expect(readFileSync(join(d, "MEMORY.md"), "utf8")).not.toContain("uses-bun");
    // no temp files are left behind by the atomic writes
    expect(readdirSync(d).sort()).toEqual(["MEMORY.md", "api-docs.md"]);
  });

  test("hand-written files with CRLF and odd entries are read or skipped, never crash", () => {
    const d = join(dir, "mem");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "crlf-note.md"), '\uFEFF---\r\nname: crlf-note\r\ndescription: "quoted"\r\ntype: feedback\r\nupdated: 2026-03-01\r\n---\r\nbody\r\n');
    writeFileSync(join(d, "Not_Valid.md"), "x");
    writeFileSync(join(d, "no-frontmatter.md"), "just text");
    writeFileSync(join(d, "notes.txt"), "x");
    const list = mem.listMemories(d, "project");
    expect(list.map((x) => x.name)).toEqual(["crlf-note", "no-frontmatter"]);
    expect(list[0]).toMatchObject({ description: "quoted", type: "feedback", body: "body" });
  });

  test("secrets and empty memories are refused", () => {
    const d = join(dir, "mem");
    expect(() => mem.writeMemory(d, "global", { name: "key", type: "reference", description: "gateway key", body: "sk-abcdefghijklmnopqrstuvwxyz123456" })).toThrow(/secret/);
    expect(() => mem.writeMemory(d, "global", { name: "empty", type: "reference", description: "x", body: "  " })).toThrow();
    expect(() => mem.writeMemory(d, "global", { name: "nodesc", type: "reference", description: "", body: "x" })).toThrow();
    expect(() => mem.writeMemory(d, "global", { name: "badtype", type: "nope" as any, description: "x", body: "x" })).toThrow();
    expect(existsSync(d)).toBe(false);
  });
});

describe("prompt section", () => {
  test("lists both scopes, stays stable, and changes when memories do", async () => {
    const s = session();
    const empty = await s.systemPrompt();
    expect(empty).toContain("# Memory");
    expect(empty).toContain("No memories saved yet.");
    mem.writeMemory(mem.projectMemoryDir(dir), "project", { name: "no-orm", type: "project", description: "We write raw SQL, no ORM", body: "Decided in 2025.", updated: "2026-05-01T00:00:00.000Z" });
    mem.writeMemory(mem.globalMemoryDir(), "global", { name: "terse-replies", type: "feedback", description: "Keep answers short", body: "They said so.", updated: "2026-04-01T00:00:00.000Z" });
    const a = await s.systemPrompt();
    expect(a).toContain("Project:\n- no-orm (project): We write raw SQL, no ORM");
    expect(a).toContain("Global:\n- terse-replies (feedback): Keep answers short");
    expect(a.indexOf("Project:")).toBeLessThan(a.indexOf("Global:"));
    expect(await s.systemPrompt()).toBe(a);
    // another folder of the same project sees the same memories; another project doesn't
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "pkg"));
    expect(await session(undefined, join(dir, "pkg")).systemPrompt()).toContain("no-orm");
    const other = await session(undefined, mkdtempSync(join(tmpdir(), "og-mem-other-"))).systemPrompt();
    expect(other).not.toContain("no-orm");
    expect(other).toContain("terse-replies");
  });

  test("capped at about 4k characters, keeping the most recently updated", () => {
    const d = mem.projectMemoryDir(dir);
    for (let i = 0; i < 80; i++)
      mem.writeMemory(d, "project", { name: `note-${String(i).padStart(2, "0")}`, type: "project", description: `Memory number ${i} `.padEnd(80, "x"), body: "b", updated: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    const text = mem.renderMemorySection(dir);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("note-79");
    expect(text).not.toContain("note-00 ");
    expect(text).toMatch(/\(\d+ older memories not shown/);
  });
});

describe("memory tool", () => {
  test("save, list, view, update and delete through Session.prompt", async () => {
    const call = (id: string, input: any) => () => ({ parts: [{ type: "tool_call" as const, id, name: "memory", input }] });
    const llm = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).toContain("memory");
        expect(req.system).toContain("No memories saved yet.");
        return { parts: [{ type: "tool_call", id: "1", name: "memory", input: { action: "save", scope: "project", name: "tabs-not-spaces", type: "feedback", description: "Indent with tabs", body: "The person corrected this twice." } }] };
      },
      call("2", { action: "save", scope: "global", name: "likes-bun", type: "user", description: "Prefers Bun over Node", body: "Use bun for scripts." }),
      call("3", { action: "save", scope: "project", name: "tabs-not-spaces", type: "feedback", description: "dup", body: "dup" }),
      call("4", { action: "list" }),
      call("5", { action: "update", name: "tabs-not-spaces", description: "Indent with tabs, width 4" }),
      call("6", { action: "view", name: "tabs-not-spaces" }),
      call("7", { action: "delete", name: "likes-bun", scope: "global" }),
      call("8", { action: "save", scope: "project", name: "../escape", type: "project", description: "x", body: "x" }),
      call("9", { action: "view", name: "likes-bun" }),
      () => ({ parts: [{ type: "text", text: "Done." }] }),
    ]);
    const s = session(llm);
    s.setMode("ask");
    const u = ui();
    expect(await s.prompt([{ type: "text", text: "remember things" }], u)).toBe("end_turn");
    const out = (n: number) => (llm.calls[n].messages.at(-1)!.parts[0] as any) as { output: string; isError?: boolean };
    expect(u.log.some((l) => l.startsWith("ask:"))).toBe(false); // never asks, even in ask mode
    expect(out(1).output).toContain('Saved project memory "tabs-not-spaces"');
    expect(out(2).output).toContain('Saved global memory "likes-bun"');
    expect(out(3)).toMatchObject({ isError: true });
    expect(out(3).output).toContain("already exists");
    expect(out(4).output).toContain("tabs-not-spaces (feedback)");
    expect(out(4).output).toContain("likes-bun (user)");
    expect(out(5).output).toContain('Updated project memory "tabs-not-spaces"');
    expect(out(6).output).toContain("description: Indent with tabs, width 4");
    expect(out(6).output).toContain("The person corrected this twice.");
    expect(out(7).output).toContain('Deleted global memory "likes-bun"');
    expect(out(8)).toMatchObject({ isError: true });
    expect(out(9)).toMatchObject({ isError: true });
    expect(u.events).toEqual([
      { type: "memory", action: "saved", scope: "project", name: "tabs-not-spaces" },
      { type: "memory", action: "saved", scope: "global", name: "likes-bun" },
      { type: "memory", action: "updated", scope: "project", name: "tabs-not-spaces" },
      { type: "memory", action: "deleted", scope: "global", name: "likes-bun" },
    ]);
    // nothing was written outside the memory folders
    expect(readdirSync(mem.projectMemoryDir(dir)).sort()).toEqual(["MEMORY.md", "tabs-not-spaces.md"]);
    expect(readdirSync(dir)).toEqual([]);
    expect(readFileSync(join(mem.globalMemoryDir(), "MEMORY.md"), "utf8")).toContain("(none yet)");

    // the next prompt sees the saved memory in its system prompt
    const llm2 = new FakeLlm([() => ({ parts: [{ type: "text", text: "ok" }] })]);
    const s2 = session(llm2);
    await s2.prompt([{ type: "text", text: "hi" }], ui());
    expect(llm2.calls[0].system).toContain("- tabs-not-spaces (feedback): Indent with tabs, width 4");
  });

  test("the tool is read-only for permissions and not parallel", () => {
    expect(mem.memoryTool.asks("ask")).toBe(false);
    expect(mem.memoryTool.asks("edits")).toBe(false);
    expect(mem.memoryTool.parallel).toBe(false);
  });
});

describe("/memory command", () => {
  test("add, global, list, show, forget and path", async () => {
    const s = session();
    const u = ui();
    expect(await runCommand(s, "")).toContain("(none)");
    expect(await runCommand(s, "add Always run the linter before committing. It catches import cycles.", u)).toBe('Saved project memory "always-run-linter-before-committing" (feedback).');
    expect(await runCommand(s, "add Always run the linter before committing!")).toContain('"always-run-linter-before-committing-2"');
    expect(await runCommand(s, "global Design docs are at https://example.com/docs")).toBe('Saved global memory "design-docs-https-example-com" (reference).');
    const m = mem.readMemory(mem.projectMemoryDir(dir), "project", "always-run-linter-before-committing")!;
    expect(m).toMatchObject({ type: "feedback", description: "Always run the linter before committing.", body: "Always run the linter before committing. It catches import cycles." });
    const list = await runCommand(s, "");
    expect(list).toContain("Project memories");
    expect(list).toContain("always-run-linter-before-committing (feedback)");
    expect(list).toContain("design-docs-https-example-com (reference)");
    expect(await runCommand(s, "show design-docs-https-example-com")).toContain("https://example.com/docs");
    expect(await runCommand(s, "forget global design-docs-https-example-com", u)).toContain("Forgot global memory");
    expect(await runCommand(s, "show design-docs-https-example-com")).toContain("No memory");
    expect(await runCommand(s, "forget ../x")).toContain("not a kebab-case name");
    const path = await runCommand(s, "path");
    expect(path).toContain(mem.projectMemoryDir(dir));
    expect(path).toContain(mem.globalMemoryDir());
    expect(await runCommand(s, "add")).toContain("Give the text");
    expect(await runCommand(s, "add my key is sk-abcdefghijklmnopqrstuvwxyz123456")).toContain("secrets must never be saved");
    expect(await runCommand(s, "bogus")).toContain("Usage:");
    expect(u.events.map((e) => `${e.action}:${e.scope}`)).toEqual(["saved:project", "deleted:global"]);
  });

  test("derived names are always valid", () => {
    for (const t of ["!!!", "日本語のメモ", "The a an", "Café crème rules", "123 go", "con"]) {
      const d = mem.deriveNote(t, "project");
      expect(mem.nameError(d.name)).toBeNull();
    }
    expect(mem.deriveNote("Café crème rules", "global")).toMatchObject({ name: "cafe-creme-rules", type: "user" });
  });
});
