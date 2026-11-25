import type { Api, Llm } from "./types";
import type { Config } from "./config";
import { learnedWindow } from "./compaction";
import { headers } from "./llm/util";
import { AnthropicLlm } from "./llm/anthropic";
import { ResponsesLlm } from "./llm/responses";
import { ChatLlm } from "./llm/chat";

export interface GatewayModel {
  id: string;
  ownedBy: string | null;
  /** context window and output limit, when the gateway publishes them (OpenRouter-style fields) */
  contextWindow?: number;
  maxOutput?: number;
}

const positive = (...vals: unknown[]): number | undefined => {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
};

/** Limits from a /v1/models entry, in any of the common spellings. */
export function limitsOf(m: any): { contextWindow?: number; maxOutput?: number } {
  const contextWindow = positive(m?.context_length, m?.context_window, m?.max_input_tokens, m?.input_token_limit, m?.top_provider?.context_length, m?.limits?.context, m?.unlid?.context_length);
  const maxOutput = positive(m?.max_output_tokens, m?.max_completion_tokens, m?.output_token_limit, m?.top_provider?.max_completion_tokens, m?.limits?.output, m?.unlid?.max_output);
  return { ...(contextWindow ? { contextWindow } : {}), ...(maxOutput ? { maxOutput } : {}) };
}

/** Models that aren't chat models (images, video, speech) are hidden from the picker. */
const NOT_CHAT = /(^|[\/-])(image|imagine|video|tts|voice|embedding|embed|whisper|transcribe|moderation|dall-e|sora)([\/-]|$)|auto-review/i;

/** Which wire format a model is spoken to in. The gateway translates between them. */
export function apiFor(model: string): Api {
  const base = model.toLowerCase().split("/").pop()!;
  // OpenRouter / Unlid etc. are OpenAI-compatible only, whatever the model.
  const prefix = model.includes("/") ? model.split("/")[0].toLowerCase() : "";
  if (["openrouter", "unlid"].includes(prefix)) return "chat";
  if (base.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|codex|o[1-9])/.test(base)) return "responses";
  return "chat";
}

/**
 * A model's context window: your config, then what the gateway publishes, then what a provider's
 * "too long" error revealed, then a conservative per-family estimate.
 */
export function contextWindow(model: string, cfg: Config = {}, fromGateway?: number): number {
  const over = cfg.contextWindows ?? {};
  if (over[model]) return over[model];
  for (const [k, v] of Object.entries(over)) if (k.endsWith("*") && model.startsWith(k.slice(0, -1))) return v;
  if (fromGateway) return fromGateway;
  const seen = learnedWindow(model);
  if (seen) return seen;
  const base = model.toLowerCase().split("/").pop()!;
  if (base.startsWith("claude-")) return 200_000;
  if (/^gpt-(5|6)/.test(base)) return 272_000;
  if (base.startsWith("grok-4")) return 256_000;
  if (base.startsWith("gemini-")) return 1_000_000;
  return 128_000;
}

export class Gateway {
  private cache: { at: number; models: GatewayModel[] } | null = null;
  constructor(
    public url: string,
    private key: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async models(force = false): Promise<GatewayModel[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 5 * 60_000) return this.cache.models;
    const r = await this.fetchImpl(`${this.url}/v1/models`, { headers: { ...headers(), Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 401 || r.status === 403) throw new Error("the gateway rejected this key");
    if (!r.ok) throw new Error(`the gateway answered ${r.status} for /v1/models`);
    const j: any = await r.json();
    const models = (Array.isArray(j?.data) ? j.data : [])
      .map((m: any) => ({ id: String(m?.id ?? ""), ownedBy: m?.owned_by ? String(m.owned_by) : null, ...limitsOf(m) }))
      .filter((m: GatewayModel) => m.id && !NOT_CHAT.test(m.id))
      .sort((a: GatewayModel, b: GatewayModel) => a.id.localeCompare(b.id));
    this.cache = { at: Date.now(), models };
    return models;
  }

  /** The window the gateway published for a model (from the last model list), if any. */
  windowFor(model: string): number | undefined {
    return this.cache?.models.find((m) => m.id === model)?.contextWindow;
  }

  llm(model: string): Llm {
    const api = apiFor(model);
    if (api === "anthropic") return new AnthropicLlm(this.url, this.key, this.fetchImpl);
    if (api === "responses") return new ResponsesLlm(this.url, this.key, this.fetchImpl);
    return new ChatLlm(this.url, this.key, this.fetchImpl);
  }
}

const BRANDS: Record<string, string> = {
  claude: "Claude", gpt: "GPT", grok: "Grok", gemini: "Gemini", gemma: "Gemma", glm: "GLM", qwen: "Qwen", deepseek: "DeepSeek", kimi: "Kimi",
  mimo: "MiMo", llama: "Llama", mistral: "Mistral", codex: "Codex", supergemma4: "SuperGemma 4", dolphin: "Dolphin", oss: "OSS", fable: "Fable", mythos: "Mythos",
};
const POOLS: Record<string, string> = { anthropic: "Anthropic API", openai: "OpenAI API", gemini: "Gemini API", openrouter: "OpenRouter", unlid: "Unlid", antigravity: "Antigravity", xai: "xAI" };

/**
 * A model id as a name for pickers: "claude-haiku-5-5" → "Claude Haiku 5.5",
 * "anthropic/claude-haiku-5-5" → "Claude Haiku 5.5" (the pool shows as its group),
 * "gpt-6.1-sol" → "GPT-6.1 Sol", "qwen3.8-27b-uncensored:thinking" → "Qwen3.8 27B Uncensored (thinking)".
 */
export function modelLabel(id: string): string {
  let base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  let variant = "";
  const colon = base.indexOf(":");
  if (colon > 0) {
    variant = ` (${base.slice(colon + 1)})`;
    base = base.slice(0, colon);
  }
  base = base.replace(/-\d{8}$/, ""); // date stamps
  const parts = base.split("-");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    const low = t.toLowerCase();
    if (/^\d+$/.test(t) && out.length && /\d$/.test(out[out.length - 1]) && !/\d{3,}/.test(t)) {
      out[out.length - 1] += `.${t}`; // claude-opus-5-5 → Opus 5.5
      continue;
    }
    if (low === "gpt" && parts[i + 1] && /^\d/.test(parts[i + 1])) {
      out.push(`GPT-${parts[++i]}`);
      continue;
    }
    if (BRANDS[low]) out.push(BRANDS[low]);
    else if (/^\d+(\.\d+)?b$/i.test(t)) out.push(t.toUpperCase());
    else if (/^[a-z]+\d/.test(low) && BRANDS[low.replace(/[\d.]+$/, "")]) out.push(BRANDS[low.replace(/[\d.]+$/, "")] + low.slice(low.replace(/[\d.]+$/, "").length));
    else out.push(t.charAt(0).toUpperCase() + t.slice(1));
  }
  return out.join(" ") + variant;
}

/** A picker group's name: pools by their product name, subscription families as they are. */
export const groupLabel = (group: string): string => POOLS[group.toLowerCase()] ?? group.charAt(0).toUpperCase() + group.slice(1);

/** Group models for pickers: plain names are subscriptions, prefixed ones are pools ("openrouter/…"). */
export function groupModels(models: GatewayModel[]): { group: string; models: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const m of models) {
    const g = m.id.includes("/") ? m.id.split("/")[0] : familyOf(m.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m.id);
  }
  return [...groups.entries()].map(([group, models]) => ({ group, models }));
}

function familyOf(id: string): string {
  const s = id.toLowerCase();
  if (s.startsWith("claude")) return "Claude";
  if (s.startsWith("gpt") || s.startsWith("codex") || /^o\d/.test(s)) return "OpenAI";
  if (s.startsWith("grok")) return "Grok";
  if (s.startsWith("gemini")) return "Gemini";
  if (s.startsWith("qwen")) return "Qwen";
  return "Other";
}
