import { describe, it, expect } from 'vitest';
import { buildChatRequest, parseChatDelta } from '$lib/components/ai-talk/openai';

describe('ai-talk OpenAI helpers', () => {
  it('builds a chat completions request with bearer auth + stream:true', () => {
    const req = buildChatRequest({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.sse).toBe(true);
    expect(req.headers).toContainEqual(['Authorization', 'Bearer sk-test']);
    expect(req.headers).toContainEqual(['Content-Type', 'application/json']);
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  it('strips trailing slashes from the base URL', () => {
    const req = buildChatRequest({
      baseUrl: 'https://api.openai.com/v1//',
      apiKey: 'k',
      model: 'm',
      temperature: 0,
      messages: [],
    });
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('extracts a delta text fragment from a chat completions chunk', () => {
    const chunk = JSON.stringify({
      choices: [{ delta: { content: 'hello ' } }],
    });
    expect(parseChatDelta(chunk)).toBe('hello ');
  });

  it('returns null for chunks without a text delta', () => {
    expect(parseChatDelta('')).toBeNull();
    expect(parseChatDelta('not json')).toBeNull();
    expect(parseChatDelta(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] }))).toBeNull();
    expect(parseChatDelta(JSON.stringify({ choices: [] }))).toBeNull();
  });
});
