import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const home = mkdtempSync(join(tmpdir(), "og-sub-home-"));
const userHome = mkdtempSync(join(tmpdir(), "og-sub-user-"));
process.env.OPENGATE_HOME = home;
process.env.HOME = userHome;
process.env.USERPROFILE = userHome;

const { Session } = await import("../src/agent");
const { createAgent } = await import("../src/acp");
const { configDir } = await import("../src/config");
const { listSessions, loadSession } = await import("../src/store");
const ext = await import("../src/ext");
const sub = await import("../src/subagents");
import type { Llm, LlmRequest, LlmTurn, Part } from "../src/types";

type Script = (req: LlmRequest) => Partial<LlmTurn> | Promise<Partial<LlmTurn>>;

/** A model that plays back scripted turns and records what it was sent. */
class FakeLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(private script: Script[]) {}
  async turn(req: LlmRequest, sink: { text(d: string): void; thinking(d: string): void }): Promise<LlmTurn> {
    this.calls.push(structuredClone({ ...req, signal: undefined }));
    const next = this.script.shift();
    if (!next) throw new Error("no more scripted turns");
    const t = await next(req);
    for (const p of t.parts ?? []) if (p.type === "text") sink.text(p.text);
    const parts = t.parts ?? [];
    return { parts, native: t.native ?? null, stop: t.stop ?? (parts.some((p) => p.type === "tool_call") ? "tool_use" : "end"), usage: t.usage ?? { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } };
  }
}

/** One fake per model id, so parent and children can be scripted separately. */
const gateway = (byModel: Record<string, Llm>) => ({
  llm: (model: string) => {
    const l = byModel[model];
    if (!l) throw new Error(`no fake for ${model}`);
    return l;
  },
});

const text = (t: string): Partial<LlmTurn> => ({ parts: [{ type: "text", text: t }] });
const call = (id: string, name: string, input: unknown): Part => ({ type: "tool_call", id, name, input });
const lastResults = (llm: FakeLlm, i: number) => llm.calls[i].messages.at(-1)!.parts as Extract<Part, { type: "tool_result" }>[];

const ui = (answers: ("once" | "always" | "deny")[] = []) => {
  const log: string[] = [];
  const events: any[] = [];
  const asked: any[] = [];
  return {
    log,
    events,
    asked,
    text: (d: string) => log.push(`text:${d}`),
    thinking: () => {},
    toolStart: (c: any) => log.push(`start:${c.name}`),
    toolEnd: (c: any, r: any) => log.push(`end:${c.name}:${r.isError ? "error" : "ok"}`),
    ask: async (c: any) => {
      asked.push(c);
      return answers.shift() ?? "deny";
    },
    notice: (m: string) => log.push(`notice:${m}`),
    event: (e: any) => events.push(e),
  };
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "og-sub-proj-"));
});

describe("subagents", () => {
  test("model aliases", () => {
    expect(sub.resolveModel("opus")).toBe("claude-opus-5-5");
    expect(sub.resolveModel("Sonnet")).toBe("claude-sonnet-5-5");
    expect(sub.resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(sub.resolveModel("grok-4.7")).toBe("grok-4.7");
    expect(sub.resolveModel("inherit")).toBeUndefined();
    expect(sub.resolveModel("")).toBeUndefined();
  });

  test("two agents run at once on different models and their answers come back in order", async () => {
    let running = 0;
    let peak = 0;
    const slow = (answer: string): Script => async () => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(40);
      running--;
      return text(answer);
    };
    const haiku = new FakeLlm([slow("answer from haiku")]);
    const sonnet = new FakeLlm([slow("answer from sonnet")]);
    const parent = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).toContain("agent");
        const spec = req.tools.find((t) => t.name === "agent")!;
        expect(spec.description).toContain("- explore:");
        expect(spec.description).toContain("parallel");
        return {
          parts: [
            call("a", "agent", { description: "Look at area A", prompt: "Study A", model: "haiku" }),
            call("b", "agent", { description: "Look at area B", prompt: "Study B", model: "sonnet" }),
          ],
        };
      },
      () => text("both done"),
    ]);
    const s = Session.create(gateway({ "claude-opus-5-5": parent, "claude-haiku-5-5": haiku, "claude-sonnet-5-5": sonnet }), {}, { cwd: dir, model: "claude-opus-5-5" });
    const u = ui();
    expect(await s.prompt([{ type: "text", text: "research" }], u)).toBe("end_turn");
    expect(peak).toBe(2);
    const [ra, rb] = lastResults(parent, 1);
    expect(ra.output).toStartWith("answer from haiku");
    expect(ra.output).toContain("claude-haiku-5-5 · 1 step · 100 in / 10 out tokens");
    expect(rb.output).toStartWith("answer from sonnet");
    expect(rb.isError).toBeFalsy();
    expect(haiku.calls[0].messages[0].parts[0]).toEqual({ type: "text", text: "Study A" });
    expect(haiku.calls[0].system).toContain("running as a subagent");
    // child text isn't streamed into the parent's answer
    expect(u.log.filter((l) => l.startsWith("text:"))).toEqual(["text:both done"]);
    const ev = u.events.filter((e) => e.type === "subagent" && e.parentCallId === "a");
    expect(ev[0]).toMatchObject({ status: "running", title: "Look at area A", model: "claude-haiku-5-5" });
    expect(ev.at(-1)).toMatchObject({ status: "done" });
    // children are saved but hidden from session lists
    const childId = ev[0].id as string;
    expect(loadSession(childId)?.parentId).toBe(s.id);
    expect(listSessions(dir).map((m) => m.id)).toEqual([s.id]);
  });

  test("a child's permission request goes to the parent, titled with the description", async () => {
    const child = new FakeLlm([() => ({ parts: [call("w1", "write_file", { path: "out.txt", content: "hi" })] }), () => text("wrote it")]);
    const parent = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Write the file", prompt: "write out.txt", model: "haiku" })] }), () => text("ok")]);
    const s = Session.create(gateway({ m: parent, "claude-haiku-5-5": child }), {}, { cwd: dir, model: "m", mode: "ask" });
    const u = ui(["once"]);
    await s.prompt([{ type: "text", text: "go" }], u);
    expect(u.asked.length).toBe(1);
    expect(u.asked[0].title).toBe("Write the file: Write out.txt");
    expect(u.asked[0].name).toBe("write_file");
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("hi");
    expect(u.events.some((e) => e.activity === "Write out.txt")).toBe(true);
    expect(lastResults(parent, 1)[0].output).toStartWith("wrote it");
  });

  test("a denied child call is denied in the child; the child keeps the parent's mode", async () => {
    const child = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).not.toContain("agent");
        return { parts: [call("w1", "write_file", { path: "no.txt", content: "x" })] };
      },
      (req) => {
        expect((req.messages.at(-1)!.parts[0] as any).output).toContain("declined");
        return text("couldn't");
      },
    ]);
    const parent = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Try writing", prompt: "write", model: "haiku" })] }), () => text("ok")]);
    const s = Session.create(gateway({ m: parent, "claude-haiku-5-5": child }), {}, { cwd: dir, model: "m", mode: "ask" });
    const u = ui(["deny"]);
    await s.prompt([{ type: "text", text: "go" }], u);
    expect(u.asked.length).toBe(1);
    expect(existsSync(join(dir, "no.txt"))).toBe(false);
    const childId = u.events[0].id as string;
    expect(loadSession(childId)?.mode).toBe("ask");
  });

  test("cancelling the parent cancels the child", async () => {
    let started!: () => void;
    const childStarted = new Promise<void>((r) => (started = r));
    const child = new FakeLlm([
      (req) =>
        new Promise((_, reject) => {
          started();
          req.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ]);
    const parent = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Long task", prompt: "take forever", model: "haiku" })] })]);
    const s = Session.create(gateway({ m: parent, "claude-haiku-5-5": child }), {}, { cwd: dir, model: "m" });
    const u = ui();
    const done = s.prompt([{ type: "text", text: "go" }], u);
    await childStarted;
    s.cancel();
    expect(await done).toBe("cancelled");
    expect(u.events.at(-1)).toMatchObject({ type: "subagent", status: "cancelled", parentCallId: "p1" });
    const r = s.data.messages.at(-1)!.parts[0] as any;
    expect(r).toMatchObject({ type: "tool_result", isError: true });
    expect(r.output).toContain("cancelled");
  });

  test("explore only gets read-only tools and can use a configured cheaper model", async () => {
    const child = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name).sort()).toEqual(["glob", "grep", "read_file"]);
        return { parts: [call("x", "shell", { command: "echo hi" })] };
      },
      (req) => {
        expect((req.messages.at(-1)!.parts[0] as any).output).toContain("There is no tool called shell");
        return text("found it in a.ts");
      },
    ]);
    const parent = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Find the code", prompt: "where is x", agent_type: "explore" })] }), () => text("ok")]);
    const s = Session.create(gateway({ m: parent, "claude-haiku-5-5": child }), { subagentModels: { explore: "haiku" } }, { cwd: dir, model: "m", mode: "yolo" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    const r = lastResults(parent, 1)[0];
    expect(r.output).toStartWith("found it in a.ts");
    expect(r.output).toContain("[explore agent · claude-haiku-5-5");
    expect(child.calls[0].system).toContain("exploration agent");
  });

  test("no nesting: children don't get the agent tool and can't run it", async () => {
    const parentSession = Session.create(gateway({}), {}, { cwd: dir, model: "m" });
    expect((await parentSession.tools()).map((t) => t.spec.name)).toContain("agent");
    const child = Session.create(gateway({}), {}, { cwd: dir, model: "m", parentId: parentSession.id });
    expect((await child.tools()).map((t) => t.spec.name)).not.toContain("agent");
    const r = await sub.runSubagent({ description: "x", prompt: "y" }, { cwd: dir, readFiles: new Map(), session: child }, sub.loadAgentDefs(dir));
    expect(r.isError).toBe(true);
    expect(r.output).toContain("can't start their own subagents");
    // a file definition that lists the agent tool still doesn't get it
    const d = join(dir, ".opengate", "agents");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "nester.md"), "---\nname: nester\ndescription: tries to nest\ntools: Read, agent\n---\n");
    const c = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(["read_file"]);
        return text("done");
      },
    ]);
    const p = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Nest", prompt: "nest", agent_type: "nester", model: "n" })] }), () => text("ok")]);
    const s = Session.create(gateway({ m: p, n: c }), {}, { cwd: dir, model: "m" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    expect(c.calls.length).toBe(1);
    expect(lastResults(p, 1)[0].output).toStartWith("done");
  });

  test("definitions load from the agent folders; project files win", async () => {
    mkdirSync(join(userHome, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(userHome, ".claude", "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews code (user version)\ntools: Read, Grep\nmodel: sonnet\n---\nUSER-BODY\n",
    );
    writeFileSync(join(userHome, ".claude", "agents", "docs.md"), "---\ndescription: >\n  Writes docs\n  for the project\ntools:\n  - Read\n  - Write\n---\r\nDOCS-BODY\r\n");
    mkdirSync(join(configDir(), "agents"), { recursive: true });
    writeFileSync(join(configDir(), "agents", "tester.md"), '---\nname: tester\ndescription: "Runs tests"\ntools: [Bash, Read]\nmodel: inherit\n---\nTESTER-BODY\n');
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code (claude project)\ntools: Read\n---\nCLAUDE-PROJECT-BODY\n");
    mkdirSync(join(dir, ".opengate", "agents"), { recursive: true });
    writeFileSync(join(dir, ".opengate", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code (project)\ntools: Read, Grep\nmodel: sonnet\n---\nPROJECT-BODY\n");

    const defs = sub.loadAgentDefs(dir);
    const by = Object.fromEntries(defs.map((d) => [d.name, d]));
    expect(Object.keys(by).sort()).toEqual(["docs", "explore", "general", "reviewer", "tester"]);
    expect(by.reviewer).toMatchObject({ description: "Reviews code (project)", tools: ["read_file", "grep"], model: "sonnet", prompt: "PROJECT-BODY", source: join(dir, ".opengate", "agents", "reviewer.md") });
    expect(by.docs).toMatchObject({ description: "Writes docs for the project", tools: ["read_file", "write_file"], prompt: "DOCS-BODY" });
    expect(by.tester).toMatchObject({ description: "Runs tests", tools: ["shell", "read_file"] });
    expect(by.tester.model).toBeUndefined();

    const child = new FakeLlm([
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(["read_file", "grep"]);
        expect(req.system).toContain("PROJECT-BODY");
        expect(req.system).not.toContain("USER-BODY");
        return text("looks good");
      },
    ]);
    const parent = new FakeLlm([
      (req) => {
        const spec = req.tools.find((t) => t.name === "agent")!;
        expect(spec.description).toContain("- reviewer: Reviews code (project)");
        expect((spec.parameters as any).properties.agent_type.enum).toContain("reviewer");
        return { parts: [call("p1", "agent", { description: "Review the change", prompt: "review", agent_type: "reviewer" })] };
      },
      () => text("ok"),
    ]);
    const s = Session.create(gateway({ m: parent, "claude-sonnet-5-5": child }), {}, { cwd: dir, model: "m" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    expect(lastResults(parent, 1)[0].output).toStartWith("looks good");

    // /agents lists the types and where they came from
    const out: string[] = [];
    await ext.getCommand("agents")!.run({ session: s, args: "", print: (t) => out.push(t), ui: ui() });
    expect(out.join("\n")).toContain("reviewer: Reviews code (project)");
    expect(out.join("\n")).toContain(join(dir, ".opengate", "agents", "reviewer.md"));
    expect(out.join("\n")).toContain("from: built-in");
  });

  test("long answers are truncated; failures come back as errors", async () => {
    const long = "A".repeat(30_000) + "THE-END";
    const child = new FakeLlm([() => text(long)]);
    const broken = new FakeLlm([
      () => {
        throw Object.assign(new Error("model not supported"), { status: 400 });
      },
    ]);
    const parent = new FakeLlm([
      () => ({
        parts: [call("p1", "agent", { description: "Big answer", prompt: "write a lot", model: "haiku" }), call("p2", "agent", { description: "Will fail", prompt: "x", model: "grok-4.7" })],
      }),
      () => text("ok"),
    ]);
    const s = Session.create(gateway({ m: parent, "claude-haiku-5-5": child, "grok-4.7": broken }), {}, { cwd: dir, model: "m" });
    const u = ui();
    await s.prompt([{ type: "text", text: "go" }], u);
    const [big, bad] = lastResults(parent, 1);
    expect(big.isError).toBeFalsy();
    expect(big.output.length).toBeLessThan(20_300);
    expect(big.output).toContain("characters cut");
    expect(big.output).toContain("THE-END");
    expect(big.output.split("\n").at(-1)).toStartWith("[general agent · claude-haiku-5-5");
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("model not supported");
    expect(u.events.filter((e) => e.parentCallId === "p2").at(-1)).toMatchObject({ status: "failed" });
  });

  test("unknown agent types and models are reported to the model", async () => {
    const parent = new FakeLlm([
      () => ({ parts: [call("p1", "agent", { description: "x", prompt: "y", agent_type: "nope" }), call("p2", "agent", { description: "x", prompt: "y", model: "no-such-model" })] }),
      () => text("ok"),
    ]);
    const gw = { ...gateway({ m: parent }), models: async () => [{ id: "m", ownedBy: null }, { id: "claude-haiku-5-5", ownedBy: null }] };
    const s = Session.create(gw, {}, { cwd: dir, model: "m" });
    await s.prompt([{ type: "text", text: "go" }], ui());
    const [a, b] = lastResults(parent, 1);
    expect(a).toMatchObject({ isError: true });
    expect(a.output).toContain('no agent type "nope"');
    expect(b).toMatchObject({ isError: true });
    expect(b.output).toContain('no model "no-such-model"');
  });

  test("over ACP, subagent progress updates the parent tool call", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    const child = new FakeLlm([() => ({ parts: [call("c1", "read_file", { path: "a.txt" })] }), () => text("a.txt holds x")]);
    const parent = new FakeLlm([() => ({ parts: [call("p1", "agent", { description: "Read a", prompt: "read a.txt", agent_type: "explore", model: "haiku" })] }), () => text("done")]);
    const gw: any = { models: async () => [{ id: "claude-opus-5-5", ownedBy: null }, { id: "claude-haiku-5-5", ownedBy: null }], llm: (m: string) => (m === "claude-haiku-5-5" ? child : parent) };
    const agentApp = createAgent({ config: () => ({ url: "http://gw", key: "k" }), gateway: () => gw });
    const updates: any[] = [];
    const clientApp = acp.client({ name: "test" }).onNotification("session/update", ({ params }) => {
      updates.push(params.update);
    });
    await clientApp.connectWith(agentApp as any, async (agent) => {
      await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const s = await agent.request("session/new", { cwd: dir, mcpServers: [] });
      const r = await agent.request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "go" }] });
      expect(r.stopReason).toBe("end_turn");
      await Bun.sleep(10);
    });
    const onCall = updates.filter((u) => u.toolCallId === "p1");
    expect(onCall[0]).toMatchObject({ sessionUpdate: "tool_call", title: "Agent (explore): Read a [claude-haiku-5-5]" });
    const progress = onCall.filter((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress");
    expect(progress.some((u) => /Subagent.* is working:\n(.*\n)*- Read a\.txt/.test(u.content?.[0]?.content?.text ?? ""))).toBe(true);
    expect(onCall.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
    expect(onCall.at(-1).rawOutput.output).toStartWith("a.txt holds x");
    // the child's text never reaches the parent's message stream
    const said = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text).join("");
    expect(said).toBe("done");
  });
});
