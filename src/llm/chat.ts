import OpenAI from "openai";
import type { Llm, LlmRequest, LlmSink, LlmTurn, Msg, Part } from "../types";
import { dataUrl, jsonOr, headers } from "./util";

/** Chat Completions: the format every OpenAI-compatible provider speaks (OpenRouter, Unlid, Grok, …). */
export function toChat(system: string, messages: Msg[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("");
      const calls = m.parts.filter((p) => p.type === "tool_call") as Extract<Part, { type: "tool_call" }>[];
      if (!text && !calls.length) continue;
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
      continue;
    }
    const content: any[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: p.output || "(no output)" });
      else if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      else if (p.type === "image") content.push({ type: "image_url", image_url: { url: dataUrl(p.mediaType, p.data) } });
    }
    if (content.length) out.push({ role: "user", content: content.length === 1 && content[0].type === "text" ? content[0].text : content });
  }
  return out;
}

export class ChatLlm implements Llm {
  private client: OpenAI;
  constructor(url: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.client = new OpenAI({ apiKey: key, baseURL: `${url}/v1`, fetch: fetchImpl, maxRetries: 2, timeout: 15 * 60_000 });
  }

  async turn(req: LlmRequest, sink: LlmSink): Promise<LlmTurn> {
    const body: any = {
      model: req.model,
      messages: toChat(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.effort !== "auto" ? { reasoning_effort: req.effort === "xhigh" || req.effort === "max" ? "high" : req.effort } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    };
    // xAI routes requests with the same conversation id to the same cache.
    const h = { ...headers(req.sessionId), ...(/(^|\/)grok-/i.test(req.model) ? { "x-grok-conv-id": req.sessionId } : {}) };
    const stream: any = await this.client.chat.completions.create(body, { headers: h, signal: req.signal });
    let text = "";
    let thinking = "";
    let finish: string | null = null;
    let model: string | undefined;
    let usage: any = null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream as AsyncIterable<any>) {
      model ??= chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const ch = chunk.choices?.[0];
      if (!ch) continue;
      const d = ch.delta ?? {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string" && r) {
        thinking += r;
        sink.thinking(r);
      }
      if (typeof d.content === "string" && d.content) {
        text += d.content;
        sink.text(d.content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    const parts: Part[] = [];
    if (thinking) parts.push({ type: "thinking", text: thinking });
    if (text) parts.push({ type: "text", text });
    let n = 0;
    for (const c of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
      if (!c.name) continue;
      parts.push({ type: "tool_call", id: c.id || `call_${Date.now().toString(36)}_${n++}`, name: c.name, input: jsonOr(c.args) });
    }
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      parts,
      native: null,
      stop: parts.some((p) => p.type === "tool_call") ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end",
      model,
      usage: { input: (usage?.prompt_tokens ?? 0) - cached, output: usage?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
    };
  }
}
