import OpenAI from "openai";
import type { Llm, LlmRequest, LlmSink, LlmTurn, Msg, Part } from "../types";
import { dataUrl, jsonOr, headers, pairToolCalls } from "./util";

/** Output items are replayed without their ids (nothing is stored server-side); reasoning keeps its encrypted content. */
function replayItem(it: any): any {
  if (it?.type === "reasoning") return { type: "reasoning", id: it.id, summary: it.summary ?? [], ...(it.encrypted_content ? { encrypted_content: it.encrypted_content } : {}) };
  const { id: _id, status: _s, ...rest } = it ?? {};
  return rest;
}

export function toResponsesInput(model: string, messages: Msg[]): any[] {
  const out: any[] = [];
  for (const m of pairToolCalls(messages)) {
    if (m.role === "assistant") {
      if (m.native?.api === "responses" && m.native.model === model && Array.isArray(m.native.data)) {
        for (const it of m.native.data as any[]) out.push(replayItem(it));
        continue;
      }
      const text = m.parts.filter((p) => p.type === "text").map((p: any) => p.text).join("");
      if (text) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const p of m.parts) if (p.type === "tool_call") out.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.input ?? {}) });
      continue;
    }
    const content: any[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && p.text) content.push({ type: "input_text", text: p.text });
      else if (p.type === "image") content.push({ type: "input_image", image_url: dataUrl(p.mediaType, p.data), detail: "auto" });
      else if (p.type === "tool_result") out.push({ type: "function_call_output", call_id: p.id, output: p.output || "(no output)" });
    }
    if (content.length) out.push({ role: "user", content });
  }
  return out;
}

export class ResponsesLlm implements Llm {
  private client: OpenAI;
  constructor(url: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.client = new OpenAI({ apiKey: key, baseURL: `${url}/v1`, fetch: fetchImpl, maxRetries: 2, timeout: 15 * 60_000 });
  }

  async turn(req: LlmRequest, sink: LlmSink): Promise<LlmTurn> {
    const body: any = {
      model: req.model,
      instructions: req.system,
      input: toResponsesInput(req.model, req.messages),
      tools: req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "auto", ...(req.effort !== "auto" ? { effort: req.effort === "max" ? "xhigh" : req.effort } : {}) },
      prompt_cache_key: req.sessionId,
      parallel_tool_calls: true,
    };
    const stream: any = await this.client.responses.create(body, { headers: headers(req.sessionId, req.labels), signal: req.signal });
    let final: any = null;
    let lastSummary = -1;
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === "response.output_text.delta") sink.text(ev.delta);
      else if (ev.type === "response.reasoning_summary_text.delta") {
        if (lastSummary !== -1 && ev.summary_index !== lastSummary) sink.thinking("\n\n");
        lastSummary = ev.summary_index;
        sink.thinking(ev.delta);
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete") final = ev.response;
      else if (ev.type === "response.failed") throw new Error(ev.response?.error?.message ?? "the model failed to answer");
      else if (ev.type === "error") throw new Error(ev.message ?? "stream error");
    }
    if (!final) throw new Error("the stream ended without a response");
    const items: any[] = final.output ?? [];
    const parts: Part[] = [];
    for (const it of items) {
      if (it.type === "reasoning") {
        const t = (it.summary ?? []).map((s: any) => s.text).join("\n\n");
        if (t) parts.push({ type: "thinking", text: t });
      } else if (it.type === "message") {
        const t = (it.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
        if (t) parts.push({ type: "text", text: t });
      } else if (it.type === "function_call") parts.push({ type: "tool_call", id: it.call_id, name: it.name, input: jsonOr(it.arguments) });
    }
    const u = final.usage ?? {};
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const truncated = final.status === "incomplete" && final.incomplete_details?.reason === "max_output_tokens";
    const refused = items.some((it) => it.type === "message" && (it.content ?? []).some((c: any) => c.type === "refusal"));
    return {
      parts,
      native: items,
      stop: parts.some((p) => p.type === "tool_call") ? "tool_use" : truncated ? "max_tokens" : refused ? "refusal" : "end",
      model: final.model,
      usage: { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
    };
  }
}
