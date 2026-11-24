/** The three wire formats opengate speaks to a gateway. */
export type Api = "anthropic" | "responses" | "chat";

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: string; isError?: boolean };

export interface Msg {
  role: "user" | "assistant";
  parts: Part[];
  /**
   * Assistant turns keep the provider's own output so it can be sent back unchanged to the same
   * API and model (thinking signatures, encrypted reasoning). Other models get the plain parts.
   */
  native?: { api: Api; model: string; data: unknown };
  ts?: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StopKind = "end" | "tool_use" | "max_tokens" | "refusal";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  effort: string;
  sessionId: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface LlmSink {
  text(delta: string): void;
  thinking(delta: string): void;
}

export interface LlmTurn {
  parts: Part[];
  native: unknown;
  stop: StopKind;
  usage: Usage;
  /** the model the gateway says answered */
  model?: string;
}

export interface Llm {
  turn(req: LlmRequest, sink: LlmSink): Promise<LlmTurn>;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
