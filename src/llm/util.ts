import { VERSION } from "../config";
import type { Msg, Part } from "../types";

/** What the model is told for a call whose result was lost. */
export const LOST_RESULT = "No result: opengate was stopped while this call ran, so it may or may not have finished. Check before relying on it.";

/**
 * Every API rejects a tool call without its result in the next message, and a result without its
 * call. A session stopped mid-tool (killed, crashed, closed) is saved with the calls but no
 * results, and would fail on every request after. Give such calls a stand-in result and drop
 * stray results. Returns the messages unchanged (same array) when they're already paired.
 */
export function pairToolCalls(messages: Msg[]): Msg[] {
  let out: Msg[] | null = null;
  const put = (i: number, m: Msg) => {
    out ??= messages.slice();
    out[i] = m;
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const prev = messages[i - 1];
    const calls = prev?.role === "assistant" ? prev.parts.filter((p) => p.type === "tool_call") : [];
    const ids = new Set(calls.map((c: any) => c.id));
    const has = new Set(m.parts.filter((p) => p.type === "tool_result").map((p: any) => p.id));
    const stray = [...has].some((id) => !ids.has(id));
    const missing = calls.filter((c: any) => !has.has(c.id));
    if (!stray && !missing.length) continue;
    const lost: Part[] = missing.map((c: any) => ({ type: "tool_result", id: c.id, name: c.name, output: LOST_RESULT, isError: true }));
    put(i, { ...m, parts: [...lost, ...m.parts.filter((p) => p.type !== "tool_result" || ids.has((p as any).id))] });
  }
  // Calls at the very end, or followed by another assistant message.
  const src: Msg[] = out ?? messages;
  const fixed: Msg[] = [];
  let changed = false;
  for (let i = 0; i < src.length; i++) {
    fixed.push(src[i]);
    const calls = src[i].role === "assistant" ? src[i].parts.filter((p) => p.type === "tool_call") : [];
    if (calls.length && src[i + 1]?.role !== "user") {
      changed = true;
      fixed.push({ role: "user", parts: calls.map((c: any) => ({ type: "tool_result", id: c.id, name: c.name, output: LOST_RESULT, isError: true })) });
    }
  }
  return changed ? fixed : src;
}
/** Tool arguments arrive as objects or JSON strings; a broken string becomes { _raw }. */
export function jsonOr(v: unknown): unknown {
  if (typeof v !== "string") return v ?? {};
  if (!v.trim()) return {};
  try {
    return JSON.parse(v);
  } catch {
    return { _raw: v };
  }
}

export const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

/** How opengate is being used, for the User-Agent: "terminal" or "acp", and which app drives it over ACP. */
export const surface = { mode: "terminal", client: "" };

export function userAgent(): string {
  const os = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  return `opengate/${VERSION} (${surface.mode}${surface.client ? `; ${surface.client}` : ""}; ${os})`;
}

export function headers(sessionId?: string, labels?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": userAgent() };
  for (const [k, v] of Object.entries(labels ?? {})) if (v) h[`x-opengate-${k}`] = String(v).replace(/[^\x20-\x7e]/g, "").slice(0, 200);
  // Lets the gateway group a session's calls into one conversation.
  if (sessionId) h["x-session-id"] = sessionId;
  return h;
}
