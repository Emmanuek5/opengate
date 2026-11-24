import { VERSION } from "../config";
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

export function headers(sessionId?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": `opengate/${VERSION}` };
  // Lets the gateway group a session's calls into one conversation.
  if (sessionId) h["x-session-id"] = sessionId;
  return h;
}
