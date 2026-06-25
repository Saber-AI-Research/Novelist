/**
 * Minimal helpers for the OpenAI Chat Completions API (or any compatible
 * endpoint that mirrors the same SSE shape: vLLM, Ollama-OAI, LM Studio, etc).
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatRequestArgs = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ChatMessage[];
};

export function buildChatRequest(args: ChatRequestArgs): {
  url: string;
  headers: [string, string][];
  body: string;
  sse: boolean;
} {
  const baseUrl = args.baseUrl.replace(/\/+$/, '');
  return {
    url: `${baseUrl}/chat/completions`,
    headers: [
      ['Content-Type', 'application/json'],
      ['Authorization', `Bearer ${args.apiKey}`],
    ],
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      temperature: args.temperature,
      stream: true,
    }),
    sse: true,
  };
}

/** A single streamed delta: answer text and/or reasoning ("thinking") text. */
export type ChatDelta = { content?: string; reasoning?: string };

/**
 * Parse a single SSE `data:` payload from a chat completions stream into its
 * answer text and reasoning text. Reasoning models stream the chain-of-thought
 * separately from the answer — DeepSeek uses `delta.reasoning_content`,
 * OpenRouter uses `delta.reasoning` — often leaving `delta.content` null until
 * the answer phase. Returns `null` only when neither field carries text.
 */
export function parseChatChunk(jsonChunk: string): ChatDelta | null {
  if (!jsonChunk) return null;
  let parsed: {
    choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
  };
  try {
    parsed = JSON.parse(jsonChunk);
  } catch {
    return null;
  }
  const delta = parsed.choices?.[0]?.delta;
  if (!delta) return null;
  const out: ChatDelta = {};
  if (typeof delta.content === 'string' && delta.content) out.content = delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === 'string' && reasoning) out.reasoning = reasoning;
  return out.content === undefined && out.reasoning === undefined ? null : out;
}

/**
 * Back-compat helper: the answer-text fragment only (ignores reasoning).
 */
export function parseChatDelta(jsonChunk: string): string | null {
  return parseChatChunk(jsonChunk)?.content ?? null;
}
