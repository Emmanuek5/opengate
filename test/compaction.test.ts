import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENGATE_HOME = mkdtempSync(join(tmpdir(), "og-compact-"));
const { Session, cleanTail } = await import("../src/agent");
const c = await import("../src/compaction");
const { getCommand } = await import("../src/ext");
import type { Llm, LlmRequest, LlmTurn } from "../src/types";

const ui = () => ({ text() {}, thinking() {}, toolStart() {}, toolEnd() {}, ask: async () => "deny" as const, notices: [] as string[], notice(m: string) { this.notices.push(m); } });

test("parsing sizes and provider errors", () => {
  expect(c.parseTokens("180k")).toBe(180_000);
  expect(c.parseTokens("1.5M")).toBe(1_500_000);
  expect(c.parseTokens("120,000 tokens")).toBe(120_000);
  expect(c.parseTokens("lots")).toBeUndefined();
  expect(c.isContextOverflow("This model's maximum context length is 131072 tokens. However, you requested 140000")).toBe(true);
  expect(c.parseContextLimit("This model's maximum context length is 131072 tokens.")).toBe(131072);
  expect(c.parseContextLimit("prompt is too long: 210000 tokens > 200000 maximum")).toBe(200000);
  expect(c.isContextOverflow("rate limited")).toBe(false);
});

test("a too-long error: remember the limit, compact, retry the step", async () => {
  const calls: LlmRequest[] = [];
  let n = 0;
  const llm: Llm = {
    async turn(req): Promise<LlmTurn> {
      calls.push(structuredClone({ ...req, signal: undefined }));
      n++;
      if (n === 1) return { parts: [{ type: "text", text: "hello" }], native: null, stop: "end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
      if (n === 2) throw Object.assign(new Error("400 This model's maximum context length is 65536 tokens"), { status: 400 });
      if (n === 3) return { parts: [{ type: "text", text: "SUMMARY" }], native: null, stop: "end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
      return { parts: [{ type: "text", text: "answer after compaction" }], native: null, stop: "end", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const s = Session.create({ llm: () => llm }, {}, { cwd: process.env.OPENGATE_HOME!, model: "unlid/some-model" });
  await s.prompt([{ type: "text", text: "first" }], ui());
  const u = ui();
  expect(await s.prompt([{ type: "text", text: "second" }], u)).toBe("end_turn");
  expect(u.notices.some((m) => m.includes("too long"))).toBe(true);
  expect(c.learnedWindow("unlid/some-model")).toBe(65536);
  expect(s.contextSize).toBe(65536);
  expect(calls[2].labels).toEqual({ purpose: "compact" });
  expect((calls[3].messages[0].parts[0] as any).text).toContain("SUMMARY");
});

test("/auto-compact sets the point per model; cleanTail keeps calls with their results", async () => {
  const s = Session.create({ llm: () => ({}) as any }, {}, { cwd: process.env.OPENGATE_HOME!, model: "claude-opus-5-5" });
  expect(s.compactAt).toBe(160_000);
  const out: string[] = [];
  await getCommand("auto-compact")!.run({ session: s, args: "120k", print: (t) => out.push(t), ui: ui() as any });
  expect(s.compactAt).toBe(120_000);
  expect(out.join("\n")).toContain("Compacts at: 120k (your setting)");
  await getCommand("auto-compact")!.run({ session: s, args: "off", print: (t) => out.push(t), ui: ui() as any });
  expect(s.compactAt).toBe(160_000);

  const msgs: any[] = [
    { role: "user", parts: [{ type: "text", text: "a" }] },
    { role: "assistant", parts: [{ type: "tool_call", id: "1", name: "x", input: {} }] },
    { role: "user", parts: [{ type: "tool_result", id: "1", name: "x", output: "r" }] },
    { role: "assistant", parts: [{ type: "text", text: "b" }] },
    { role: "user", parts: [{ type: "text", text: "c" }] },
  ];
  expect(cleanTail(msgs, 3).map((m) => m.parts[0].type)).toEqual(["text"]); // skips the orphaned tool_result
  expect(cleanTail(msgs, 5)).toHaveLength(5);
});

test("the gateway's published windows are read in every common spelling and used", async () => {
  const { limitsOf, contextWindow } = await import("../src/gateway");
  expect(limitsOf({ id: "a", context_length: 200000, max_output_tokens: 64000 })).toEqual({ contextWindow: 200000, maxOutput: 64000 });
  expect(limitsOf({ id: "b", top_provider: { context_length: "262144", max_completion_tokens: 16384 } })).toEqual({ contextWindow: 262144, maxOutput: 16384 });
  expect(limitsOf({ id: "c", max_input_tokens: 1000000 })).toEqual({ contextWindow: 1000000 });
  expect(limitsOf({ id: "d" })).toEqual({});
  expect(contextWindow("x-model", {}, 300000)).toBe(300000); // gateway beats the estimate
  expect(contextWindow("x-model", { contextWindows: { "x-model": 50000 } }, 300000)).toBe(50000); // your config beats the gateway
  const gw: any = { llm: () => ({}), models: async () => [{ id: "unlid/big", ownedBy: null, contextWindow: 1048576 }], windowFor: (m: string) => (m === "unlid/big" ? 1048576 : undefined) };
  const s = Session.create(gw, {}, { cwd: process.env.OPENGATE_HOME!, model: "unlid/big" });
  expect(s.contextSize).toBe(1048576);
  expect(s.compactAt).toBe(Math.round(1048576 * 0.8));
});
