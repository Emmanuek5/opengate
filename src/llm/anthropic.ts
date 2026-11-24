import Anthropic from "@anthropic-ai/sdk";
import type { Llm, LlmRequest, LlmSink, LlmTurn, Msg, Part, StopKind } from "../types";
import { jsonOr, headers } from "./util";

/** Claude models with adaptive thinking and effort (4.6 and later, the 5 family, Fable, Mythos). */
export function modernClaude(model: string): boolean {
  const m = model.toLowerCase().split("/").pop()!;
  return /^claude-(fable|mythos)/.test(m) || /^claude-(opus|sonnet|haiku)-5/.test(m) || /^claude-(opus|sonnet)-4-[6-9]/.test(m);
}

export function toAnthropic(model: string, messages: Msg[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Same model and API: send the answer back exactly as it came (thinking blocks included).
      if (m.native?.api === "anthropic" && m.native.model === model && Array.isArray(m.native.data)) {
        out.push({ role: "assistant", content: m.native.data as Anthropic.ContentBlockParam[] });
        continue;
      }
      const content: Anthropic.ContentBlockParam[] = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        else if (p.type === "tool_call") content.push({ type: "tool_use", id: p.id, name: p.name, input: (p.input ?? {}) as Record<string, unknown> });
      }
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }
    const content: Anthropic.ContentBlockParam[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      else if (p.type === "image") content.push({ type: "image", source: { type: "base64", media_type: p.mediaType as any, data: p.data } });
      else if (p.type === "tool_result") content.push({ type: "tool_result", tool_use_id: p.id, content: p.output || "(no output)", ...(p.isError ? { is_error: true } : {}) });
    }
    if (content.length) out.push({ role: "user", content });
  }
  return out;
}

export function stopOf(reason: string | null | undefined): StopKind {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "end";
}

export class AnthropicLlm implements Llm {
  private client: Anthropic;
  constructor(url: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.client = new Anthropic({ apiKey: key, baseURL: url, fetch: fetchImpl, maxRetries: 2, timeout: 15 * 60_000 });
  }

  async turn(req: LlmRequest, sink: LlmSink): Promise<LlmTurn> {
    const modern = modernClaude(req.model);
    const effort = req.effort === "auto" ? "high" : req.effort;
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens ?? (modern ? 64_000 : 32_000),
      system: [{ type: "text", text: req.system }],
      messages: toAnthropic(req.model, req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
      // Cache the whole prefix; each turn only adds to the end.
      cache_control: { type: "ephemeral" },
      stream: true,
      ...(modern ? { thinking: { type: "adaptive", display: "summarized" } as any, output_config: { effort: effort as any } } : {}),
    };
    const stream = this.client.messages.stream(params, { headers: headers(req.sessionId), signal: req.signal });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") sink.text(ev.delta.text);
        else if (ev.delta.type === "thinking_delta") sink.thinking(ev.delta.thinking);
      }
    }
    const msg = await stream.finalMessage();
    const parts: Part[] = [];
    for (const b of msg.content) {
      if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "thinking") parts.push({ type: "thinking", text: b.thinking });
      else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, input: jsonOr(b.input) });
    }
    const u: any = msg.usage ?? {};
    return {
      parts,
      native: msg.content,
      stop: stopOf(msg.stop_reason),
      model: msg.model,
      usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    };
  }
}
