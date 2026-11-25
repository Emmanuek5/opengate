import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const home = mkdtempSync(join(tmpdir(), "og-home-"));
process.env.OPENGATE_HOME = home;

const { Session } = await import("../src/agent");
const { createAgent } = await import("../src/acp");
const { apiFor } = await import("../src/gateway");
const { toAnthropic } = await import("../src/llm/anthropic");
const { toResponsesInput } = await import("../src/llm/responses");
const { toChat } = await import("../src/llm/chat");
const { applyEdit, applyEdits, toolByName, runProcess } = await import("../src/tools");
const { untilStopped } = await import("../src/agent");
const { pairToolCalls, LOST_RESULT } = await import("../src/llm/util");
const { parseArgs } = await import("../src/cli-args");
const ext = await import("../src/ext");
import type { Llm, LlmRequest, LlmTurn, Msg } from "../src/types";

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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "og-proj-"));
});

const ui = (answers: ("once" | "always" | "deny")[] = []) => {
  const log: string[] = [];
  return {
    log,
    text: (d: string) => log.push(`text:${d}`),
    thinking: () => {},
    toolStart: (c: any) => log.push(`start:${c.name}`),
    toolEnd: (c: any, r: any) => log.push(`end:${c.name}:${r.isError ? "error" : "ok"}`),
    ask: async (c: any) => {
      log.push(`ask:${c.name}`);
      return answers.shift() ?? "deny";
    },
  };
};

describe("tools", () => {
  test("edits keep CRLF line endings and need a unique match", () => {
    const r = applyEdit("a\r\nb\r\nc\r\n", "b\nc", "B\nC", false);
    expect(r).toEqual({ text: "a\r\nB\r\nC\r\n", count: 1 });
    expect(applyEdit("x x", "x", "y", false)).toContain("appears 2 times");
    expect(applyEdit("x x", "x", "y", true)).toEqual({ text: "y y", count: 2 });
    expect(applyEdit("abc", "zzz", "y", false)).toContain("not found");
  });

  test("several edits in one call apply in order, all or nothing", async () => {
    expect(applyEdits("a b c", [{ old_string: "a", new_string: "A" }, { old_string: "A b", new_string: "AB" }])).toEqual({ text: "AB c", count: 2 });
    expect(applyEdits("a b c", [{ old_string: "a", new_string: "A" }, { old_string: "zzz", new_string: "y" }])).toBe(
      "Edit 2 of 2: old_string was not found in the file. Read the file again and copy the exact text, including whitespace. No edits were made.",
    );
    const f = join(dir, "multi.txt");
    writeFileSync(f, "one\ntwo\nthree\n");
    const edit = toolByName.get("edit_file")!;
    const readFiles = new Map<string, number>();
    await toolByName.get("read_file")!.run({ path: f }, { cwd: dir, readFiles } as any);
    const bad = await edit.run({ path: f, edits: [{ old_string: "one", new_string: "1" }, { old_string: "four", new_string: "4" }] }, { cwd: dir, readFiles } as any);
    expect(bad.isError).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("one\ntwo\nthree\n"); // untouched
    const ok = await edit.run({ path: f, edits: [{ old_string: "one", new_string: "1" }, { old_string: "three", new_string: "3" }] }, { cwd: dir, readFiles } as any);
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(f, "utf8")).toBe("1\ntwo\n3\n");
  });

  test("files must be read before they're edited, and re-read after outside changes", async () => {
    const f = join(dir, "a.txt");
    writeFileSync(f, "one\ntwo\n");
    const ctx = { cwd: dir, readFiles: new Map<string, number>() };
    const edit = toolByName.get("edit_file")!;
    expect((await edit.run({ path: "a.txt", old_string: "two", new_string: "2" }, ctx)).output).toContain("Read");
    const read = await toolByName.get("read_file")!.run({ path: "a.txt" }, ctx);
    expect(read.output).toBe("1\tone\n2\ttwo\n3\t");
    const r = await edit.run({ path: "a.txt", old_string: "two", new_string: "2" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.diff).toEqual({ path: f, oldText: "one\ntwo\n", newText: "one\n2\n" });
    await Bun.sleep(5);
    writeFileSync(f, "changed elsewhere\n");
    expect((await edit.run({ path: "a.txt", old_string: "changed", new_string: "x" }, ctx)).output).toContain("changed since you read it");
  });

  test("glob, grep and shell", async () => {
    writeFileSync(join(dir, "x.ts"), "const needle = 1;\n");
    writeFileSync(join(dir, "y.md"), "no match\n");
    const ctx = { cwd: dir, readFiles: new Map<string, number>() };
    expect((await toolByName.get("glob")!.run({ pattern: "**/*.ts" }, ctx)).output).toBe("x.ts");
    expect((await toolByName.get("grep")!.run({ pattern: "needle" }, ctx)).output).toContain("x.ts:1:const needle = 1;");
    expect((await toolByName.get("grep")!.run({ pattern: "needle", files_only: true }, ctx)).output.trim()).toBe("x.ts");
    const sh = await toolByName.get("shell")!.run({ command: process.platform === "win32" ? "Write-Output hi; exit 3" : "echo hi; exit 3" }, ctx);
    expect(sh.output).toContain("hi");
    expect(sh.exitCode).toBe(3);
    expect(sh.isError).toBe(true);
  });
});

describe("wire formats", () => {
  const history: Msg[] = [
    { role: "user", parts: [{ type: "text", text: "fix it" }] },
    {
      role: "assistant",
      parts: [{ type: "thinking", text: "hmm" }, { type: "text", text: "Reading." }, { type: "tool_call", id: "t1", name: "read_file", input: { path: "a" } }],
      native: { api: "anthropic", model: "claude-opus-5-5", data: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }] },
    },
    { role: "user", parts: [{ type: "tool_result", id: "t1", name: "read_file", output: "1\tx", isError: false }] },
  ];

  test("models are spoken to in their own format", () => {
    expect(apiFor("claude-opus-5-5")).toBe("anthropic");
    expect(apiFor("antigravity/claude-sonnet-5-5-high")).toBe("anthropic");
    expect(apiFor("gpt-6.1-sol")).toBe("responses");
    expect(apiFor("grok-4.7")).toBe("chat");
    expect(apiFor("openrouter/anthropic/claude-opus-5-5")).toBe("chat");
    expect(apiFor("unlid/glm-5.3-uncensored")).toBe("chat");
  });

  test("the same Claude model gets its thinking back unchanged; another model gets plain parts", () => {
    const same = toAnthropic("claude-opus-5-5", history);
    expect((same[1].content as any[])[0]).toEqual({ type: "thinking", thinking: "hmm", signature: "sig" });
    const other = toAnthropic("claude-sonnet-5-5", history);
    expect((other[1].content as any[]).map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect((other[2].content as any[])[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
  });

  test("Responses and Chat Completions carry tool calls and results", () => {
    const r = toResponsesInput("gpt-6.1-sol", history);
    expect(r.map((x) => x.type ?? x.role)).toEqual(["user", "assistant", "function_call", "function_call_output"]);
    const c = toChat("sys", history);
    expect(c.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(c[2].tool_calls[0]).toMatchObject({ id: "t1", function: { name: "read_file", arguments: '{"path":"a"}' } });
  });
});

describe("agent loop", () => {
  test("runs tools, asks before edits, and remembers 'always'", async () => {
    writeFileSync(join(dir, "a.txt"), "old\n");
    const llm = new FakeLlm([
      () => ({ parts: [{ type: "tool_call", id: "1", name: "read_file", input: { path: "a.txt" } }] }),
      () => ({ parts: [{ type: "tool_call", id: "2", name: "edit_file", input: { path: "a.txt", old_string: "old", new_string: "new" } }] }),
      () => ({ parts: [{ type: "tool_call", id: "3", name: "edit_file", input: { path: "a.txt", old_string: "new", new_string: "newer" } }] }),
      () => ({ parts: [{ type: "text", text: "Done." }] }),
    ]);
    const s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "claude-opus-5-5" });
    const u = ui(["always"]);
    expect(await s.prompt([{ type: "text", text: "change it" }], u)).toBe("end_turn");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("newer\n");
    expect(u.log.filter((l) => l.startsWith("ask:"))).toEqual(["ask:edit_file"]); // asked once, then always
    expect(llm.calls[1].messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", id: "1", output: "1\told\n2\t" });
    expect(s.data.title).toBe("change it");
    expect(s.data.messages.length).toBe(8);
  });

  test("a declined call tells the model and nothing changes", async () => {
    const llm = new FakeLlm([() => ({ parts: [{ type: "tool_call", id: "1", name: "shell", input: { command: "rm -rf x" } }] }), () => ({ parts: [{ type: "text", text: "OK." }] })]);
    const s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "m", mode: "edits" });
    await s.prompt([{ type: "text", text: "go" }], ui(["deny"]));
    expect(llm.calls[1].messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", isError: true });
    expect((llm.calls[1].messages.at(-1)!.parts[0] as any).output).toContain("declined");
  });

  test("cut-off tool calls don't run", async () => {
    const llm = new FakeLlm([() => ({ parts: [{ type: "tool_call", id: "1", name: "write_file", input: { path: "z.txt", content: "x" } }], stop: "max_tokens" }), () => ({ parts: [{ type: "text", text: "ok" }] })]);
    const s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "m", mode: "auto" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    expect((llm.calls[1].messages.at(-1)!.parts[0] as any).output).toContain("cut off");
  });

  test("compaction replaces the history with a summary", async () => {
    const llm = new FakeLlm([() => ({ parts: [{ type: "text", text: "hi" }], usage: { input: 190_000, output: 10, cacheRead: 0, cacheWrite: 0 } }), () => ({ parts: [{ type: "text", text: "SUMMARY" }] }), () => ({ parts: [{ type: "text", text: "again" }] })]);
    const s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "claude-opus-5-5" });
    await s.prompt([{ type: "text", text: "one" }], ui());
    await s.prompt([{ type: "text", text: "two" }], ui());
    const sent = llm.calls[2].messages;
    expect((sent[0].parts[0] as any).text).toContain("SUMMARY");
    expect((sent.at(-1)!.parts[0] as any).text).toBe("two");
  });
});

describe("steering", () => {
  test("a message sent during a turn goes after the tool results, in the same user message", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    let s: any;
    const llm = new FakeLlm([
      () => {
        // the person speaks while the model is answering
        s.steer([{ type: "text", text: "also check b.txt" }]);
        return { parts: [{ type: "tool_call", id: "1", name: "read_file", input: { path: "a.txt" } }] };
      },
      () => ({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "m" });
    const events: any[] = [];
    await s.prompt([{ type: "text", text: "go" }], { ...ui(), event: (e: any) => events.push(e) });
    const msg = llm.calls[1].messages.at(-1)!;
    expect(msg.parts.map((p: any) => p.type)).toEqual(["tool_result", "text"]);
    expect((msg.parts[1] as any).text).toContain("also check b.txt");
    expect(events).toContainEqual(expect.objectContaining({ type: "steer", status: "delivered" }));
    expect(s.steer([{ type: "text", text: "late" }])).toBe(false); // no turn running
  });
});

describe("a stuck tool doesn't hold the turn", () => {
  // A child that starts a grandchild sharing its output pipe (like `cmd &` or Start-Process
  // -NoNewWindow), prints the grandchild's pid, then exits or waits.
  const spawner = (parentWaits: boolean) =>
    `const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"inherit",detached:true});c.unref();console.log("pid",c.pid);${parentWaits ? "setTimeout(()=>{},30000)" : ""}`;
  const reap = (out: string) => {
    const pid = Number(out.match(/pid (\d+)/)?.[1]);
    try {
      if (pid) process.kill(pid);
    } catch {}
  };

  test("ends when the command exits, even if a process it started keeps the output open", async () => {
    const t = Date.now();
    const r = await runProcess(process.execPath, ["-e", spawner(false)], dir, 60_000);
    reap(r.out);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r).toMatchObject({ code: 0, timedOut: false, leftRunning: true });
    expect(r.out).toContain("pid");
  });

  test("a timeout ends it even when the kill can't reach the process holding the output", async () => {
    const t = Date.now();
    const r = await runProcess(process.execPath, ["-e", spawner(true)], dir, 500);
    reap(r.out);
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(r.timedOut).toBe(true);
  });

  test("a tool that ignores the stop signal is given up on after a grace period", async () => {
    const ac = new AbortController();
    const p = untilStopped(new Promise(() => {}), ac.signal, 20);
    ac.abort();
    expect((await p).output).toContain("may still be running");
    expect(await untilStopped(Promise.resolve({ output: "fine" }), new AbortController().signal)).toEqual({ output: "fine" });
  });

  test("stopping the running tool keeps the turn going and delivers the waiting message", async () => {
    ext.registerToolProvider({
      name: "stuck-tools",
      tools: () => [
        {
          spec: { name: "hang", description: "test", parameters: { type: "object", properties: {} } },
          kind: "read" as const,
          asks: () => false,
          title: () => "hang",
          paths: () => [],
          run: () => new Promise(() => {}), // ignores the signal, never ends
        },
      ],
    });
    let s: any;
    const llm = new FakeLlm([
      () => ({ parts: [{ type: "tool_call", id: "h", name: "hang", input: {} }] }),
      () => ({ parts: [{ type: "text", text: "redirected" }] }),
    ]);
    s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "m" });
    const done = s.prompt([{ type: "text", text: "go" }], ui());
    while (!s.toolsRunning) await Bun.sleep(5);
    expect(s.steer([{ type: "text", text: "you got stuck" }])).toBe(true);
    expect(s.stopTools()).toBe(true);
    expect(await done).toBe("end_turn");
    const msg = llm.calls[1].messages.at(-1)!;
    expect(msg.parts.map((p: any) => p.type)).toEqual(["tool_result", "text"]);
    expect((msg.parts[0] as any).output).toContain("stopped this call to redirect you");
    expect((msg.parts[1] as any).text).toContain("you got stuck");
    expect(s.stopTools()).toBe(false); // nothing running now
  }, 15_000);

  test("a session saved mid-tool (calls without results) still works", () => {
    const call = (id: string) => ({ type: "tool_call" as const, id, name: "shell", input: {} });
    const msgs: Msg[] = [
      { role: "user", parts: [{ type: "text", text: "go" }] },
      { role: "assistant", parts: [call("a"), call("b")] },
      { role: "user", parts: [{ type: "text", text: "you got stuck" }] },
      { role: "assistant", parts: [{ type: "text", text: "sorry" }] },
      { role: "user", parts: [{ type: "tool_result", id: "zz", name: "shell", output: "stray" }, { type: "text", text: "next" }] },
      { role: "assistant", parts: [call("c")] },
    ];
    const fixed = pairToolCalls(msgs);
    expect(fixed[2].parts.map((p: any) => p.id ?? p.text)).toEqual(["a", "b", "you got stuck"]);
    expect((fixed[2].parts[0] as any).output).toBe(LOST_RESULT);
    expect(fixed[4].parts.map((p: any) => p.type)).toEqual(["text"]);
    expect(fixed.at(-1)!.parts.map((p: any) => p.id)).toEqual(["c"]);
    expect(msgs[2].parts.length).toBe(1); // the saved session isn't changed
    const ok: Msg[] = [msgs[0], { role: "assistant", parts: [call("x")] }, { role: "user", parts: [{ type: "tool_result", id: "x", name: "shell", output: "1" }] }];
    expect(pairToolCalls(ok)).toBe(ok);
    // and every API format gets the pairs
    const claude = toAnthropic("claude-opus-5-5", msgs) as any[];
    expect(claude[2].content.map((b: any) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(toChat("sys", msgs).filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id)).toEqual(["a", "b", "c"]);
    expect(toResponsesInput("gpt-6.2-sol", msgs).filter((m: any) => m.type === "function_call_output").map((m: any) => m.call_id)).toEqual(["a", "b", "c"]);
  });
});

describe("permissions and extensions", () => {
  test("auto mode follows the policy; deny wins in every mode; yolo never asks", async () => {
    const decisions: Record<string, "allow" | "ask" | "deny"> = { "echo ok": "allow", "make deploy": "ask", "rm -rf /": "deny" };
    ext.registerPermissionPolicy({ name: "test-guard", decide: ({ call }) => (call.name === "shell" ? { decision: decisions[call.input.command] ?? "ask", reason: `policy says ${decisions[call.input.command]}` } : null) });
    const run = async (mode: any, command: string, answer: "once" | "deny" = "deny") => {
      const llm = new FakeLlm([() => ({ parts: [{ type: "tool_call", id: "1", name: "shell", input: { command } }] }), () => ({ parts: [{ type: "text", text: "ok" }] })]);
      const s = Session.create({ llm: () => llm }, { guard: false }, { cwd: dir, model: "m", mode });
      const u = ui([answer]);
      await s.prompt([{ type: "text", text: "go" }], u);
      const out = (llm.calls[1].messages.at(-1)!.parts[0] as any).output as string;
      return { asked: u.log.includes("ask:shell"), out };
    };
    expect(await run("auto", "echo ok")).toMatchObject({ asked: false });
    expect((await run("auto", "echo ok")).out).toContain("ok");
    expect((await run("auto", "make deploy")).asked).toBe(true);
    const blocked = await run("yolo", "rm -rf /");
    expect(blocked.asked).toBe(false);
    expect(blocked.out).toContain("blocked by test-guard");
    expect((await run("yolo", "make deploy", "deny")).asked).toBe(false);
    expect((await run("ask", "echo ok")).asked).toBe(true);
  });

  test("extension tools are offered, prompt sections are added, and parallel tools run together", async () => {
    let running = 0;
    let peak = 0;
    const slow = (name: string) => ({
      spec: { name, description: "test", parameters: { type: "object", properties: {} } },
      kind: "read" as const,
      parallel: true,
      asks: () => false,
      title: () => name,
      paths: () => [],
      async run() {
        running++;
        peak = Math.max(peak, running);
        await Bun.sleep(30);
        running--;
        return { output: `${name} done` };
      },
    });
    ext.registerToolProvider({ name: "test-tools", tools: () => [slow("slow_a"), slow("slow_b")] });
    ext.registerPromptSection({ name: "test-section", render: () => "SECTION-MARKER" });
    const llm = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).toContain("slow_a");
        expect(req.system).toContain("SECTION-MARKER");
        return { parts: [{ type: "tool_call", id: "a", name: "slow_a", input: {} }, { type: "tool_call", id: "b", name: "slow_b", input: {} }] };
      },
      () => ({ parts: [{ type: "text", text: "ok" }] }),
    ]);
    const s = Session.create({ llm: () => llm }, {}, { cwd: dir, model: "m" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    expect(peak).toBe(2);
    expect(llm.calls[1].messages.at(-1)!.parts.map((p: any) => p.output)).toEqual(["slow_a done", "slow_b done"]);
  });
});

describe("ACP", () => {
  test("new session, prompt with a permission request, list and load", async () => {
    writeFileSync(join(dir, "a.txt"), "old\n");
    const llm = new FakeLlm([
      () => ({ parts: [{ type: "tool_call", id: "1", name: "read_file", input: { path: "a.txt" } }] }),
      () => ({ parts: [{ type: "tool_call", id: "2", name: "edit_file", input: { path: "a.txt", old_string: "old", new_string: "new" } }] }),
      () => ({ parts: [{ type: "text", text: "Changed." }] }),
    ]);
    const gw: any = { models: async () => [{ id: "claude-opus-5-5", ownedBy: null }, { id: "unlid/x", ownedBy: null }], llm: () => llm };
    const agentApp = createAgent({ config: () => ({ url: "http://gw", key: "k" }), gateway: () => gw });
    const updates: string[] = [];
    const asked: string[] = [];
    const clientApp = acp
      .client({ name: "test" })
      .onRequest("session/request_permission", ({ params }) => {
        asked.push(`${params.toolCall.title}:${params.toolCall.content?.[0]?.type}`);
        return { outcome: { outcome: "selected", optionId: "once" } };
      })
      .onNotification("session/update", ({ params }) => {
        updates.push(params.update.sessionUpdate);
      });
    await clientApp.connectWith(agentApp as any, async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      expect(init.agentCapabilities?.loadSession).toBe(true);
      const s = await agent.request("session/new", { cwd: dir, mcpServers: [] });
      const model = s.configOptions!.find((o) => o.id === "model") as any;
      expect(model.currentValue).toBe("claude-opus-5-5");
      expect(model.options.map((g: any) => g.group)).toEqual(["Claude", "unlid"]);
      const r = await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "edit a" }] });
      expect(r.stopReason).toBe("end_turn");
      expect(asked).toEqual(["Edit a.txt:diff"]);
      expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n");
      expect(updates).toContain("tool_call");
      expect(updates).toContain("agent_message_chunk");
      const list = await agent.request("session/list", { cwd: dir });
      expect(list.sessions[0]).toMatchObject({ sessionId: s.sessionId, title: "edit a" });
      updates.length = 0;
      await agent.request("session/set_mode", { sessionId: s.sessionId, modeId: "auto" });
      await agent.request("session/load", { sessionId: s.sessionId, cwd: dir, mcpServers: [] });
      expect(updates.filter((u) => u === "tool_call").length).toBe(2);
    });
  });

  test("without a gateway configured, new sessions ask the client to log in", async () => {
    const agentApp = createAgent({ config: () => ({}) });
    const clientApp = acp.client({ name: "test" });
    await clientApp.connectWith(agentApp as any, async (agent) => {
      const init = await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      expect(init.authMethods?.[0]).toMatchObject({ id: "opengate-login", type: "terminal", args: ["login"] });
      await expect(agent.request("session/new", { cwd: dir, mcpServers: [] })).rejects.toThrow();
    });
  });
});

describe("cli", () => {
  test("arguments", () => {
    expect(parseArgs(["acp"]).cmd).toBe("acp");
    expect(parseArgs(["-m", "grok-4.7", "--mode", "auto", "fix", "it"])).toMatchObject({ model: "grok-4.7", mode: "auto", rest: ["fix", "it"] });
    expect(parseArgs(["-r"]).resume).toBe(true);
    expect(parseArgs(["-r", "abc"]).resume).toBe("abc");
    expect(parseArgs(["--mode", "yolo"]).mode).toBe("yolo");
    expect(() => parseArgs(["--mode", "nope"])).toThrow();
  });
});

describe("login", () => {
  test("--key-stdin reads a piped key, checks it and saves the settings", async () => {
    const seen: string[] = [];
    const gw = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization") ?? "");
        return Response.json({ object: "list", data: [{ id: "claude-opus-5-5" }, { id: "gpt-image-2" }] });
      },
    });
    const ogHome = mkdtempSync(join(tmpdir(), "og-login-"));
    try {
      const p = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "login", "--url", `http://127.0.0.1:${gw.port}`, "--key-stdin"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENGATE_HOME: ogHome, OPENGATE_URL: "", OPENGATE_KEY: "", NO_COLOR: "1" },
      });
      p.stdin.write("sk-test-key-123\r\n");
      await p.stdin.end();
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("1 models available");
      expect(out).not.toContain("sk-test-key-123");
      expect(seen).toEqual(["Bearer sk-test-key-123"]);
      const saved = JSON.parse(readFileSync(join(ogHome, "config", "config.json"), "utf8"));
      expect(saved).toMatchObject({ url: `http://127.0.0.1:${gw.port}`, key: "sk-test-key-123", model: "claude-opus-5-5" });
    } finally {
      gw.stop(true);
    }
  });
});
