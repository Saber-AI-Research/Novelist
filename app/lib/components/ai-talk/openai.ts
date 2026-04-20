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

/**
 * Parse a single SSE `data:` payload from a chat completions stream and
 * return the text fragment (if any) carried in `choices[0].delta.content`.
 */
export function parseChatDelta(jsonChunk: string): string | null {
  if (!jsonChunk) return null;
  let parsed: { choices?: Array<{ delta?: { content?: string } }> };
  try {
    parsed = JSON.parse(jsonChunk);
  } catch {
    return null;
  }
  const delta = parsed.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : null;
}
