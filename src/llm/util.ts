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
