import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig, saveConfig, writeAtomic, type Config } from "./config";
import { registerCommand } from "./ext";

/**
 * When to compact. The gateway doesn't publish context windows, so they come from (in order):
 * your config (`contextWindows`), what a provider's "too long" error revealed (remembered in
 * the data folder), then a per-family estimate. `autoCompact` sets the compaction point per
 * model; the default is 80% of the window.
 */

const learnedFile = () => join(dataDir(), "context-windows.json");
let learned: Record<string, number> | null = null;

function loadLearned(): Record<string, number> {
  if (learned) return learned;
  try {
    learned = existsSync(learnedFile()) ? JSON.parse(readFileSync(learnedFile(), "utf8")) : {};
  } catch {
    learned = {};
  }
  return learned!;
}

export const learnedWindow = (model: string): number | undefined => loadLearned()[model];

export function learnWindow(model: string, tokens: number): void {
  if (!(tokens > 1000)) return;
  const l = loadLearned();
  if (l[model] === tokens) return;
  l[model] = tokens;
  try {
    writeAtomic(learnedFile(), JSON.stringify(l, null, 2));
  } catch {}
}

/** Does this error say the request was too long for the model? */
export function isContextOverflow(message: string): boolean {
  return /context[_ ]length|context[_ ]window|maximum context|too many tokens|prompt is too long|input is too long|context_length_exceeded|reduce the length|exceeds the (?:model'?s? )?(?:maximum|max|context)|request too large|token limit/i.test(message);
}

/** The model's limit, if the error names it ("maximum context length is 131072 tokens", "… > 200000 maximum"). */
export function parseContextLimit(message: string): number | undefined {
  const num = (s: string) => Number(s.replace(/[,_\s]/g, ""));
  const pats = [/>\s*([\d,]+)\s*maximum/i, /maximum context length is\s*([\d,]+)/i, /context (?:window|length) (?:of|is)\s*([\d,]+)/i, /limit (?:of|is)\s*([\d,]+)\s*tokens/i, /maximum (?:of\s*)?([\d,]+)\s*tokens/i];
  for (const re of pats) {
    const m = re.exec(message);
    if (m && num(m[1]) > 1000) return num(m[1]);
  }
  return undefined;
}

/** "180k", "1m", "180000", "1.5M" → tokens. */
export function parseTokens(s: string): number | undefined {
  const m = /^\s*([\d.,_]+)\s*([km])?\s*(?:tokens?)?\s*$/i.exec(s);
  if (!m) return undefined;
  const n = Number(m[1].replace(/[,_]/g, "")) * (m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1000 : 1);
  return Number.isFinite(n) && n >= 1000 ? Math.round(n) : undefined;
}

function lookup(map: Record<string, number> | undefined, model: string): number | undefined {
  if (!map) return undefined;
  if (map[model]) return map[model];
  let best: [string, number] | undefined;
  for (const [k, v] of Object.entries(map)) if (k.endsWith("*") && model.startsWith(k.slice(0, -1)) && (!best || k.length > best[0].length)) best = [k, v];
  return best?.[1];
}

/** The compaction point set for a model, if any (exact id, or the longest matching "prefix*"). */
export const autoCompactFor = (cfg: Config, model: string): number | undefined => lookup(cfg.autoCompact, model);

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

registerCommand({
  name: "auto-compact",
  args: "[tokens|off]",
  description: "When to summarize the conversation for the current model, e.g. /auto-compact 180k",
  run({ session, args, print }) {
    const model = session.data.model;
    const arg = args.trim();
    if (arg) {
      const cfg = loadConfig();
      const map = { ...(cfg.autoCompact ?? {}) };
      if (/^(off|default|reset|auto|none)$/i.test(arg)) delete map[model];
      else {
        const n = parseTokens(arg);
        if (!n) return print("Give a size like 180k, 1m or 120000 (or off for the default).");
        map[model] = n;
      }
      saveConfig({ autoCompact: map });
      (session.cfg as Config).autoCompact = map; // this session too
    }
    const set = autoCompactFor(session.cfg, model);
    const win = session.contextSize;
    const src = lookup(session.cfg.contextWindows, model) ? "from your config" : learnedWindow(model) ? "learned from the provider" : "estimated";
    print(
      [
        `Model: ${model}`,
        `Context window: ${fmtTokens(win)} (${src})`,
        `Compacts at: ${fmtTokens(session.compactAt)}${set ? " (your setting)" : " (80% of the window)"}`,
        `Now: ${fmtTokens(session.data.contextUsed)} used (${Math.round((session.data.contextUsed / session.compactAt) * 100)}% of the way to compacting)`,
        "",
        "Change it with /auto-compact 180k (or off). Set exact windows in the config: contextWindows.",
      ].join("\n"),
    );
  },
});
