import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "og-models-"));
process.env.OPENGATE_HOME = home;

const models = await import("../src/models");
const sub = await import("../src/subagents");
const { guardModelFor } = await import("../src/guard/model");
const { canDisableThinking } = await import("../src/llm/anthropic");

// A slice of a real gateway's list, in its (arbitrary) order.
const IDS = [
  "claude-haiku-4-5-20251001",
  "claude-haiku-5-5",
  "claude-3-5-haiku-20241022",
  "claude-sonnet-5-5",
  "claude-sonnet-4-6",
  "claude-opus-5-5",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-fable-5-2",
  "claude-fable-5",
  "anthropic/claude-haiku-5-5",
  "antigravity/claude-opus-5-5-high",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "gpt-6.1-terra",
  "gpt-6.2-sol",
  "gpt-6.1-sol",
  "gpt-6.2-astra",
  "gpt-6-chat-thinking",
  "antigravity/gemini-3.8-flash-high",
  "antigravity/gemini-4-hydrogen-xhigh",
  "antigravity/gemini-4-neon-xhigh",
  "antigravity/gemini-4-argon-high",
  "antigravity/gemini-4-carbon-high",
  "openrouter/google/gemini-4-neon",
  "grok-4.7",
  "grok-4.5",
  "grok-4.7-build-fast",
  "grok-4.20-0309-reasoning",
  "grok-3-mini",
  "grok-build-0.1",
  "unlid/glm-5.3-uncensored",
];

beforeEach(() => {
  rmSync(join(home, "data"), { recursive: true, force: true });
  models.resetSpeedCache();
});

describe("tiers", () => {
  test("each vendor's naming maps to a size", () => {
    expect(models.tierOf("claude-haiku-5-5")).toMatchObject({ family: "Claude", tier: "small" });
    expect(models.tierOf("claude-3-5-haiku-20241022")?.tier).toBe("small");
    expect(models.tierOf("claude-sonnet-5-5")?.tier).toBe("medium");
    expect(models.tierOf("claude-opus-5-5")?.tier).toBe("large");
    expect(models.tierOf("claude-fable-5-2")?.tier).toBe("frontier");
    expect(models.tierOf("gpt-6-luna")).toMatchObject({ family: "GPT", tier: "small" });
    expect(models.tierOf("gpt-6.1-terra")?.tier).toBe("medium");
    expect(models.tierOf("gpt-6.2-sol")?.tier).toBe("large");
    expect(models.tierOf("gpt-6.2-astra")?.tier).toBe("frontier");
    expect(models.tierOf("antigravity/gemini-4-hydrogen-xhigh")).toMatchObject({ family: "Gemini", tier: "small" });
    expect(models.tierOf("antigravity/gemini-4-carbon-high")?.tier).toBe("large");
    expect(models.tierOf("grok-3-mini")?.tier).toBe("small");
    expect(models.tierOf("grok-4.7")?.tier).toBe("large");
    // the same model served faster at a higher price is not a smaller tier
    expect(models.tierOf("grok-4.7-build-fast")).toBeNull();
    expect(models.tierOf("unlid/glm-5.3-uncensored")).toBeNull();
    expect(models.tierOf("gpt-6-chat-thinking")).toBeNull();
  });

  test("picks the newest of each line, the gateway's own over pools", () => {
    const p = models.tierPicks(IDS, "Claude");
    expect(p.small).toEqual(["claude-haiku-5-5", "gpt-6-luna", "antigravity/gemini-4-hydrogen-xhigh", "grok-3-mini"]);
    expect(p.medium).toEqual(["claude-sonnet-5-5", "gpt-6.1-terra", "antigravity/gemini-4-neon-xhigh", "grok-build-0.1"]);
    expect(p.large).toEqual(["claude-opus-5-5", "gpt-6.2-sol", "antigravity/gemini-4-carbon-high", "grok-4.7"]);
    expect(p.frontier).toEqual(["claude-fable-5-2", "gpt-6.2-astra"]);
  });

  test("a size prefers the session's family", () => {
    expect(models.pickTier(IDS, "large", "GPT")).toBe("gpt-6.2-sol");
    expect(models.pickTier(IDS, "large", "Claude")).toBe("claude-opus-5-5");
    expect(models.pickTier(IDS, "frontier", "Grok")).toBe("claude-fable-5-2");
    expect(models.pickTier([], "small")).toBeUndefined();
  });

  test("a small model for the guard and summaries: Haiku, else Luna, else another small one", () => {
    expect(models.smallModel(IDS)).toBe("claude-haiku-5-5");
    const noClaude = IDS.filter((id) => !id.includes("claude"));
    expect(models.smallModel(noClaude)).toBe("gpt-6-luna");
    expect(models.smallModel(noClaude.filter((id) => !id.includes("luna")))).toBe("antigravity/gemini-4-hydrogen-xhigh");
    expect(models.smallModel(["grok-4.7", "unlid/glm-5.3-uncensored"])).toBeUndefined();
  });
});

describe("speed", () => {
  test("measured speeds win over the speed class once there are a few turns", () => {
    expect(models.speedLabel("gpt-6-luna")).toBe("fast");
    expect(models.speedLabel("claude-opus-5-5")).toBe("medium speed");
    expect(models.fastestModel(IDS, "GPT")).toBe("claude-haiku-5-5"); // very fast beats fast
    for (let i = 0; i < 3; i++) models.recordSpeed("gpt-6-luna", 3000, 800, 5000); // 600 tok/s
    models.resetSpeedCache(); // read back from the file
    expect(models.measuredSpeed("gpt-6-luna")?.tps).toBeCloseTo(600);
    expect(models.speedLabel("gpt-6-luna")).toBe("fast, ~600 tok/s, first token ~0.8 s");
    expect(models.fastestModel(IDS, "Claude")).toBe("gpt-6-luna");
  });

  test("short answers aren't measured, and one slow turn doesn't swamp the average", () => {
    models.recordSpeed("claude-haiku-5-5", 20, 500, 1000);
    expect(models.measuredSpeed("claude-haiku-5-5")).toBeUndefined();
    for (let i = 0; i < 10; i++) models.recordSpeed("claude-haiku-5-5", 2000, 1000, 10_000); // 200 tok/s
    models.recordSpeed("claude-haiku-5-5", 2000, 1000, 100_000); // one 20 tok/s turn
    const m = models.measuredSpeed("claude-haiku-5-5")!;
    expect(m.n).toBe(11);
    expect(m.tps).toBeGreaterThan(150);
  });
});

describe("subagent model choice", () => {
  test("model takes a size or fastest, from the gateway's list", () => {
    expect(sub.resolveModel("fastest", IDS, "Claude")).toBe("claude-haiku-5-5");
    expect(sub.resolveModel("medium", IDS, "GPT")).toBe("gpt-6.1-terra");
    expect(sub.resolveModel("Large", IDS, "Claude")).toBe("claude-opus-5-5");
    expect(sub.resolveModel("small", [], "Claude")).toBeUndefined(); // no list: no guess
    expect(sub.resolveModel("haiku")).toBe("claude-haiku-5-5");
    expect(sub.resolveModel("grok-4.7", IDS)).toBe("grok-4.7");
  });

  test("explore defaults to the fastest model; asking for another wins; no list falls back to yours", () => {
    const explore = sub.loadAgentDefs(home).find((d) => d.name === "explore")!;
    const general = sub.loadAgentDefs(home).find((d) => d.name === "general")!;
    expect(sub.modelFor(explore, undefined, {}, "claude-opus-5-5", IDS)).toBe("claude-haiku-5-5");
    expect(sub.modelFor(explore, "large", {}, "claude-opus-5-5", IDS)).toBe("claude-opus-5-5");
    expect(sub.modelFor(explore, "gpt-6.1-terra", {}, "claude-opus-5-5", IDS)).toBe("gpt-6.1-terra");
    expect(sub.modelFor(explore, undefined, { subagentModels: { explore: "sonnet" } }, "claude-opus-5-5", IDS)).toBe("claude-sonnet-5-5");
    expect(sub.modelFor(explore, undefined, {}, "claude-opus-5-5", [])).toBe("claude-opus-5-5");
    expect(sub.modelFor(general, undefined, {}, "claude-opus-5-5", IDS)).toBe("claude-opus-5-5");
  });

  test("the tool tells the model the sizes, speeds and the fastest pick", () => {
    const d = sub.describeModels(IDS, "claude-opus-5-5");
    expect(d).toContain("You are on claude-opus-5-5 (large, medium speed).");
    expect(d).toContain("- small: for lookups");
    expect(d).toContain("claude-haiku-5-5 (very fast)");
    expect(d).toContain('use model "fastest", now claude-haiku-5-5');
    expect(d).toContain("grok-4.7-build-fast"); // unranked ids are still listed
    expect(d).not.toMatch(/Other models[\s\S]*- Claude: [^\n]*claude-haiku-5-5[,\n]/); // ranked ones aren't repeated
    expect(sub.describeModels([], "m")).toContain("opus / sonnet / haiku");
  });
});

describe("guard model", () => {
  const session = (ids: string[] | null, cfg: any = {}) =>
    ({
      cfg,
      data: { model: "grok-4.7" },
      gateway: ids ? { models: async () => ids.map((id) => ({ id })) } : {},
    }) as any;

  test("Haiku, else Luna, else another small model, else the session's own", async () => {
    expect(await guardModelFor(session(IDS))).toBe("claude-haiku-5-5");
    expect(await guardModelFor(session(["gpt-6-luna", "gpt-6.2-sol"]))).toBe("gpt-6-luna");
    expect(await guardModelFor(session(["grok-3-mini", "grok-4.7"]))).toBe("grok-3-mini");
    expect(await guardModelFor(session(["grok-4.7", "unlid/x"]))).toBe("grok-4.7");
    expect(await guardModelFor(session(IDS, { guardModel: "gpt-6.1-terra" }))).toBe("gpt-6.1-terra");
    expect(await guardModelFor(session(null))).toBe("claude-haiku-5-5");
  });
});

describe("thinking off for short checks", () => {
  test("only on Claude models that accept it", () => {
    for (const m of ["claude-haiku-5-5", "anthropic/claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6"]) expect(canDisableThinking(m)).toBe(true);
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-mythos-5-2"]) expect(canDisableThinking(m)).toBe(false);
  });
});
