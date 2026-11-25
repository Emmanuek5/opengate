import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "og-mcp-home-"));
process.env.OPENGATE_HOME ??= home;

const { Session } = await import("../src/agent");
const mcp = await import("../src/mcp");
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

const ui = (answers: ("once" | "always" | "deny")[] = []) => {
  const log: string[] = [];
  const events: any[] = [];
  return {
    log,
    events,
    text: () => {},
    thinking: () => {},
    toolStart: (c: any) => log.push(`start:${c.name}`),
    toolEnd: (c: any, r: any) => log.push(`end:${c.name}:${r.isError ? "error" : "ok"}`),
    ask: async (c: any) => {
      log.push(`ask:${c.name}`);
      return answers.shift() ?? "deny";
    },
    event: (e: any) => events.push(e),
  };
};

const fixture = join(import.meta.dir, "fixtures", "mcp-server.ts");
const server = (...extra: string[]) => ({ command: process.execPath, args: [fixture, ...extra] });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sessions: any[] = [];
afterAll(async () => {
  for (const s of sessions) await s.dispose();
});
const newSession = (llm: Llm, cfg: any, extra: Record<string, unknown> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "og-mcp-proj-"));
  const s = Session.create({ llm: () => llm }, cfg, { cwd: dir, model: "m" });
  for (const [k, v] of Object.entries(extra)) s.runtime.set(k, v);
  sessions.push(s);
  return s;
};

describe("mcp", () => {
  test("tools are listed and callable through a prompt; read-only tools don't ask; dispose closes the server", async () => {
    const llm = new FakeLlm([
      (req) => {
        const names = req.tools.map((t) => t.name);
        expect(names).toContain("mcp__fix__echo");
        expect(names).toContain("mcp__fix__write_note");
        expect(names).toContain("mcp__fix__broken");
        const echo = req.tools.find((t) => t.name === "mcp__fix__echo")!;
        expect(echo.description).toBe("Echo the text back");
        expect((echo.parameters as any).properties.text.type).toBe("string");
        expect(req.system).toContain("FIXTURE-INSTRUCTIONS");
        return {
          parts: [
            { type: "tool_call", id: "a", name: "mcp__fix__echo", input: { text: "hi" } },
            { type: "tool_call", id: "b", name: "mcp__fix__write_note", input: { note: "n1" } },
            { type: "tool_call", id: "c", name: "mcp__fix__broken", input: {} },
          ],
        };
      },
      () => ({ parts: [{ type: "text", text: "done" }] }),
    ]);
    const s = newSession(llm, { mcpServers: { fix: server() } });
    const u = ui(["once", "once"]);
    expect(await s.prompt([{ type: "text", text: "go" }], u)).toBe("end_turn");
    // echo is read-only: no ask. write_note and broken ask.
    expect(u.log).not.toContain("ask:mcp__fix__echo");
    expect(u.log).toContain("ask:mcp__fix__write_note");
    expect(u.log).toContain("ask:mcp__fix__broken");
    const results = s.data.messages[2].parts as any[];
    expect(results[0]).toMatchObject({ id: "a", output: "echo: hi" });
    expect(results[0].isError).toBeFalsy();
    expect(results[1].output).toContain("saved n1");
    expect(results[1].output).toContain("[image: image/png]");
    expect(results[1].output).toContain("[resource: note://1, text/plain]\nnote body");
    expect(results[2]).toMatchObject({ output: "it broke", isError: true });
    expect(u.events).toContainEqual({ type: "mcp", server: "fix", status: "connected", tools: 3 });

    const st = mcp.mcpState(s)!.servers[0];
    expect(st.status).toBe("connected");
    const pid = st.pid!;
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    await s.dispose();
    expect(st.status).toBe("closed");
    for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("a failing server is reported and skipped; the others still work", async () => {
    const llm = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"))).toEqual(["mcp__good__echo", "mcp__good__write_note", "mcp__good__broken"]);
        return { parts: [{ type: "tool_call", id: "a", name: "mcp__good__echo", input: { text: "x" } }] };
      },
      () => ({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const s = newSession(llm, {
      mcpServers: { crash: server("--crash"), missing: { command: "opengate-no-such-command-xyz" }, good: server() },
    });
    const u = ui();
    expect(await s.prompt([{ type: "text", text: "go" }], u)).toBe("end_turn");
    const by = Object.fromEntries(mcp.mcpState(s)!.servers.map((x) => [x.name, x]));
    expect(by.good.status).toBe("connected");
    expect(by.crash.status).toBe("failed");
    expect(by.missing.status).toBe("failed");
    expect(by.missing.error).toMatch(/not found|not recognized/);
    expect(u.events.find((e) => e.server === "crash")).toMatchObject({ type: "mcp", status: "failed" });

    let printed = "";
    await ext.getCommand("mcp")!.run({ session: s, args: "", print: (t) => (printed += t), ui: u as any });
    expect(printed).toContain("good (stdio, from config): connected, 3 tools");
    expect(printed).toContain("crash (stdio, from config): failed");
    expect(printed).toContain("missing");
  }, 30_000);

  test("ACP servers come first; project .mcp.json only with projectMcp", async () => {
    const llm = new FakeLlm([]);
    const s = newSession(llm, { mcpServers: { a: { command: "x" }, web: { type: "http", url: "https://example.invalid/mcp?token=${OG_TEST_TOKEN}", headers: { Authorization: "Bearer ${OG_TEST_TOKEN:-none}" } } } }, {
      "acp.mcpServers": [{ name: "a", command: "from-acp", args: ["1"], env: [{ name: "K", value: "V" }] }, { type: "sse", name: "s", url: "https://example.invalid/sse", headers: [{ name: "H", value: "1" }] }],
    });
    writeFileSync(join(s.data.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "p" } } }));
    let { specs } = mcp.collectServers(s);
    expect(specs.map((x) => `${x.name}:${x.source}:${x.transport}`)).toEqual(["a:acp:stdio", "s:acp:sse", "web:config:http"]);
    expect(specs[0]).toMatchObject({ command: "from-acp", args: ["1"], env: { K: "V" } });
    expect(specs[2]).toMatchObject({ headers: { Authorization: "Bearer none" } });
    (s.cfg as any).projectMcp = true;
    ({ specs } = mcp.collectServers(s));
    expect(specs.map((x) => x.name)).toEqual(["a", "s", "web", "proj"]);
  });

  test("tool names are sanitized, at most 64 characters and unique", () => {
    const taken = new Set<string>();
    expect(mcp.mcpToolName("my server", "do.thing", taken)).toBe("mcp__my_server__do_thing");
    const long = mcp.mcpToolName("s", "x".repeat(100), taken);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(mcp.mcpToolName("my.server", "do thing", taken)).not.toBe("mcp__my_server__do_thing");
  });

  test("results: text, images, resources, errors, cap", () => {
    expect(mcp.formatResult({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/jpeg", data: "" }], isError: true })).toEqual({ output: "a\n[image: image/jpeg]", isError: true });
    expect(mcp.formatResult({ content: [], structuredContent: { x: 1 } }).output).toContain('"x": 1');
    expect(mcp.formatResult({ content: [{ type: "text", text: "y".repeat(40_000) }] }).output.length).toBeLessThan(31_000);
  });

  test("on Windows, .cmd shims like npx run through cmd /c", () => {
    const which = (c: string) => (c === "npx" ? "C:\\Program Files\\nodejs\\npx.cmd" : c === "node" ? "C:\\Program Files\\nodejs\\node.exe" : null);
    expect(mcp.stdioCommand("npx", ["-y", "pkg", "a&b"], "win32", which)).toEqual({ command: process.env.ComSpec || "cmd.exe", args: ["/d", "/c", "npx", "-y", "pkg", "a^&b"] });
    expect(mcp.stdioCommand("node", ["s.js"], "win32", which)).toEqual({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["s.js"] });
    expect(mcp.stdioCommand("npx", ["-y"], "linux", which)).toEqual({ command: "npx", args: ["-y"] });
  });
});
