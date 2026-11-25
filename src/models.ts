/**
 * Model tiers and speeds: which of the gateway's models are small, which are frontier, and how fast
 * each answers, so the agent can pick the right one for a subagent, and the guard and compaction
 * can find a small model.
 *
 * Sizes go small < medium < large < frontier, from each vendor's own naming (Nov 2026):
 * - Anthropic: Haiku < Sonnet < Opus < Fable (Mythos is Fable for security orgs)
 * - OpenAI GPT-6: Luna < Terra < Sol < Astra (older: nano < mini < plain)
 * - Google Gemini 4: Hydrogen < Neon < Argon / Carbon (Carbon is the newer Argon); Gemini 3 Flash(-Lite) is small, Pro large
 * - xAI: grok-3-mini is small, grok-build (code) mid, grok-4.x the flagship. "-fast" Grok ids
 *   are the same model served faster at a higher price, so they aren't a smaller tier.
 * Speed is separate from size (a small model behind a slow route can stream slower than a large
 * one): each line has a speed class, and measured speeds from this machine's own turns win.
 * Models that match none of these (DeepSeek, Qwen, GLM, … via OpenRouter or Unlid) have no tier;
 * they're still listed and usable by id.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, writeAtomic } from "./config";

export type Tier = "small" | "medium" | "large" | "frontier";
export const TIERS: Tier[] = ["small", "medium", "large", "frontier"];
export type Speed = "very fast" | "fast" | "medium" | "slow";

export const TIER_USE: Record<Tier, string> = {
  small: "lookups, finding files and usages, reading and summarizing, simple mechanical edits",
  medium: "ordinary coding and tests, exploration that needs judgment (tracing logic across files)",
  large: "hard debugging, subtle code review, design and security questions",
  frontier: "the hardest problems, when a large model isn't enough",
};

/** Rough output tokens per second per speed class, for ranking models never measured here. */
const SPEED_TPS: Record<Speed, number> = { "very fast": 200, fast: 120, medium: 70, slow: 35 };

interface Line {
  family: string;
  tier: Tier;
  speed: Speed;
  re: RegExp;
}

/** Earlier lines win within a family and tier (e.g. Carbon over Argon). Matched on the id without its prefix. */
const CATALOG: Line[] = [
  { family: "Claude", tier: "small", speed: "very fast", re: /^claude-(\d+-)*haiku\b/ },
  { family: "Claude", tier: "medium", speed: "fast", re: /^claude-(\d+-)*sonnet\b/ },
  { family: "Claude", tier: "large", speed: "medium", re: /^claude-(\d+-)*opus\b/ },
  { family: "Claude", tier: "frontier", speed: "slow", re: /^claude-(fable|mythos)\b/ },

  { family: "GPT", tier: "small", speed: "fast", re: /^gpt-[\d.]+-luna\b/ },
  { family: "GPT", tier: "medium", speed: "fast", re: /^gpt-[\d.]+-terra\b/ },
  { family: "GPT", tier: "large", speed: "slow", re: /^gpt-[\d.]+-sol\b/ },
  { family: "GPT", tier: "frontier", speed: "slow", re: /^gpt-[\d.]+-astra\b/ },
  { family: "GPT", tier: "small", speed: "fast", re: /^gpt-[\d.]+-nano$/ },
  { family: "GPT", tier: "medium", speed: "fast", re: /^gpt-[\d.]+-mini$/ },
  { family: "GPT", tier: "large", speed: "medium", re: /^gpt-[\d.]+$/ },

  { family: "Gemini", tier: "small", speed: "very fast", re: /^gemini-[\d.]+-hydrogen\b/ },
  { family: "Gemini", tier: "small", speed: "very fast", re: /^gemini-[\d.]+-flash(?!-lite|-image)\b/ },
  { family: "Gemini", tier: "small", speed: "very fast", re: /^gemini-[\d.]+-flash-lite\b/ },
  { family: "Gemini", tier: "medium", speed: "fast", re: /^gemini-[\d.]+-neon\b/ },
  { family: "Gemini", tier: "large", speed: "medium", re: /^gemini-[\d.]+-carbon\b/ },
  { family: "Gemini", tier: "large", speed: "medium", re: /^gemini-[\d.]+-argon\b/ },
  { family: "Gemini", tier: "large", speed: "medium", re: /^gemini-[\d.]+-pro\b/ },

  { family: "Grok", tier: "small", speed: "very fast", re: /^grok-[\d.]+-mini$/ },
  { family: "Grok", tier: "medium", speed: "fast", re: /^grok-(build|code)-/ },
  { family: "Grok", tier: "large", speed: "fast", re: /^grok-\d+\.\d$/ },
];

const FAMILY_ORDER = ["Claude", "GPT", "Gemini", "Grok"];

const base = (id: string) => id.toLowerCase().split("/").pop()!;

/** 0: the gateway's own (unprefixed), 1: another pool, 2: pay-per-use (OpenRouter, Unlid). */
function prefixRank(id: string): number {
  if (!id.includes("/")) return 0;
  return /^(openrouter|unlid)\//i.test(id) ? 2 : 1;
}

/** The numbers in an id, for "newest first": claude-haiku-5-5 → [5, 5], gpt-6.2-sol → [6, 2]. */
export function versionKey(id: string): number[] {
  return (base(id).match(/\d+/g) ?? []).map(Number);
}

function newer(a: string, b: string): number {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/** The family, tier and speed class of a model id, if it's one we know. */
export function tierOf(id: string): { family: string; tier: Tier; speed: Speed } | null {
  const b = base(id);
  const line = CATALOG.find((l) => l.re.test(b));
  return line ? { family: line.family, tier: line.tier, speed: line.speed } : null;
}

/** The family of a model id ("Claude", "GPT", …), or null. */
export function familyOf(id: string): string | null {
  return tierOf(id)?.family ?? null;
}

/** The best model of one family and tier among ids: the first catalogue line with a match, the gateway's own over pools, newest. */
function bestOf(ids: string[], family: string, tier: Tier): string | undefined {
  for (const line of CATALOG) {
    if (line.family !== family || line.tier !== tier) continue;
    const hits = ids.filter((id) => line.re.test(base(id)));
    if (!hits.length) continue;
    const rank = Math.min(...hits.map(prefixRank));
    return hits
      .filter((id) => prefixRank(id) === rank)
      .sort((a, b) => newer(b, a) || a.length - b.length || a.localeCompare(b))[0];
  }
  return undefined;
}

const familiesFirst = (prefer?: string | null) => (prefer ? [prefer, ...FAMILY_ORDER.filter((f) => f !== prefer)] : FAMILY_ORDER);

/** Per tier, the best model of each family the gateway has (the preferred family first). */
export function tierPicks(ids: string[], preferFamily?: string | null): Record<Tier, string[]> {
  const out = { small: [], medium: [], large: [], frontier: [] } as Record<Tier, string[]>;
  for (const tier of TIERS) {
    for (const fam of familiesFirst(preferFamily)) {
      const m = bestOf(ids, fam, tier);
      if (m) out[tier].push(m);
    }
  }
  return out;
}

/** One model for a tier: the preferred family's (e.g. the session's), else the first family that has one. */
export function pickTier(ids: string[], tier: Tier, preferFamily?: string | null): string | undefined {
  return tierPicks(ids, preferFamily)[tier][0];
}

export const isTier = (s: unknown): s is Tier => typeof s === "string" && (TIERS as string[]).includes(s.trim().toLowerCase());

/**
 * A small model for background jobs (safety checks, summaries): Claude Haiku, else GPT Luna, else
 * any other small model the gateway has. Undefined when the gateway offers none (or can't say).
 */
export function smallModel(ids: string[]): string | undefined {
  return bestOf(ids, "Claude", "small") ?? bestOf(ids, "GPT", "small") ?? pickTier(ids, "small");
}

/** Expected output tokens per second: measured here if known, else the speed class's rough figure. */
export function expectedTps(id: string): number {
  const m = measuredSpeed(id);
  if (m) return m.tps;
  const t = tierOf(id);
  return t ? SPEED_TPS[t.speed] : 0;
}

/** The quickest small model for really light work: measured speed first, then the speed class; the preferred family breaks ties. */
export function fastestModel(ids: string[], preferFamily?: string | null): string | undefined {
  const picks = tierPicks(ids, preferFamily).small;
  return picks.map((id, i) => ({ id, i, tps: expectedTps(id) })).sort((a, b) => b.tps - a.tps || a.i - b.i)[0]?.id;
}

/** "very fast, ~263 tok/s" (measured) or "very fast" (class only), "" for unknown models. */
export function speedLabel(id: string): string {
  const t = tierOf(id);
  const m = measuredSpeed(id);
  const parts = [t ? (t.speed === "medium" ? "medium speed" : t.speed) : "", m ? `~${Math.round(m.tps)} tok/s, first token ~${(m.ttftMs / 1000).toFixed(1)} s` : ""].filter(Boolean);
  return parts.join(", ");
}

// ---------------- measured speeds ----------------

export interface MeasuredSpeed {
  /** output tokens per second while streaming */
  tps: number;
  /** time to the first token, in ms */
  ttftMs: number;
  /** how many turns went into it */
  n: number;
}

const speedFile = () => join(dataDir(), "model-speeds.json");
let speeds: Record<string, MeasuredSpeed> | null = null;

function loadSpeeds(): Record<string, MeasuredSpeed> {
  if (speeds) return speeds;
  try {
    speeds = existsSync(speedFile()) ? JSON.parse(readFileSync(speedFile(), "utf8")) : {};
  } catch {
    speeds = {};
  }
  return speeds!;
}

/** Forget the cached file (tests). */
export function resetSpeedCache(): void {
  speeds = null;
}

/** Measured speed for a model, once it has a few turns behind it. */
export function measuredSpeed(id: string): MeasuredSpeed | undefined {
  const m = loadSpeeds()[id];
  return m && m.n >= 3 ? m : undefined;
}

/**
 * Record one turn: output tokens, ms from the request to the first streamed token, and ms from
 * there to the end. Short answers say little about speed and are skipped. A moving average, so
 * a slow day fades.
 */
export function recordSpeed(id: string, outputTokens: number, ttftMs: number, streamMs: number): void {
  if (!(outputTokens >= 100) || !(streamMs >= 300) || !(ttftMs >= 0)) return;
  const tps = (outputTokens * 1000) / streamMs;
  if (!Number.isFinite(tps) || tps > 5000) return;
  const all = loadSpeeds();
  const old = all[id];
  const a = old ? Math.max(0.2, 1 / (old.n + 1)) : 1;
  all[id] = old ? { tps: old.tps + a * (tps - old.tps), ttftMs: old.ttftMs + a * (ttftMs - old.ttftMs), n: old.n + 1 } : { tps, ttftMs, n: 1 };
  try {
    writeAtomic(speedFile(), JSON.stringify(all, null, 2));
  } catch {}
}
