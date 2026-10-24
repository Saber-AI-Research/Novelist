import { beforeEach, describe, expect, it, vi } from 'vitest';

const { aiFetchStreamStart, aiFetchStreamCancel, aiStream, aiTalkSettingsState } = vi.hoisted(() => ({
  aiFetchStreamStart: vi.fn(),
  aiFetchStreamCancel: vi.fn(),
  aiStream: vi.fn(),
  aiTalkSettingsState: {
    value: {
      activeProfileId: 'openai',
      profiles: [
        {
          id: 'openai',
          label: 'OpenAI',
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'llm-key',
          model: 'model-a',
          temperature: 0.2,
        },
      ],
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'llm-key',
      model: 'model-a',
      temperature: 0.2,
    },
  },
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: { aiFetchStreamStart, aiFetchStreamCancel },
}));
vi.mock('$lib/components/ai-talk/host', () => ({ aiStream }));
vi.mock('$lib/components/ai-talk/settings.svelte', () => ({ aiTalkSettings: aiTalkSettingsState }));

import { bookTranslationSettings } from '$lib/stores/book-translation-settings.svelte';
import { requestTranslationReference } from '$lib/services/translation-reference';

function streamChunks(...events: Array<{ kind: 'chunk'; data: string } | { kind: 'done' } | { kind: 'error'; message: string; status?: number }>) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

beforeEach(() => {
  aiFetchStreamStart.mockReset();
  aiFetchStreamCancel.mockReset();
  aiStream.mockReset();
  aiTalkSettingsState.value = {
    activeProfileId: 'openai',
    profiles: [
      {
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'llm-key',
        model: 'model-a',
        temperature: 0.2,
      },
    ],
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'llm-key',
    model: 'model-a',
    temperature: 0.2,
  };
  bookTranslationSettings.reset();
  aiFetchStreamStart.mockResolvedValue({ status: 'ok', data: 'stream-1' });
  aiFetchStreamCancel.mockResolvedValue({ status: 'ok', data: null });
});

describe('requestTranslationReference — Google Cloud Translation', () => {
  it('sends the Basic v2 payload with the key in a header, never the URL', async () => {
    bookTranslationSettings.update({ googleApiKey: 'key/with spaces' });
    aiStream.mockReturnValue(streamChunks(
      {
        kind: 'chunk',
        data: JSON.stringify({ data: { translations: [{ translatedText: '你好' }] } }),
      },
      { kind: 'done' },
    ));

    await expect(requestTranslationReference({
      provider: 'google',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    })).resolves.toBe('你好');

    expect(aiFetchStreamStart).toHaveBeenCalledWith({
      url: 'https://translation.googleapis.com/language/translate/v2',
      headers: [['Content-Type', 'application/json'], ['X-goog-api-key', 'key/with spaces']],
      body: JSON.stringify({ q: 'Hello', target: 'zh-CN', format: 'text', source: 'en' }),
      sse: false,
    });
    // Bridge network errors quote the URL verbatim, so it must not carry the key.
    expect(aiFetchStreamStart.mock.calls[0][0].url).not.toContain('key');
  });

  it('reports the API error message from a non-2xx response body', async () => {
    bookTranslationSettings.update({ googleApiKey: 'secret-key' });
    aiStream.mockReturnValue(streamChunks({
      kind: 'error',
      status: 400,
      message: JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }),
    }));

    const failure = requestTranslationReference({
      provider: 'google',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
    await expect(failure).rejects.toThrow(
      'Google Translation failed: HTTP 400: API key not valid. Please pass a valid API key.',
    );
    await expect(failure).rejects.not.toThrow('{"error"');
  });

  it('omits source when source language is automatic detection', async () => {
    bookTranslationSettings.update({ googleApiKey: 'key' });
    aiStream.mockReturnValue(streamChunks(
      { kind: 'chunk', data: JSON.stringify({ data: { translations: [{ translatedText: '世界' }] } }) },
      { kind: 'done' },
    ));

    await requestTranslationReference({
      provider: 'google',
      source: 'world',
      sourceLanguage: null,
      targetLanguage: 'zh-CN',
    });

    expect(JSON.parse(aiFetchStreamStart.mock.calls[0][0].body)).toEqual({
      q: 'world',
      target: 'zh-CN',
      format: 'text',
    });
  });

  it('rejects missing credentials and incomplete responses', async () => {
    await expect(requestTranslationReference({
      provider: 'google',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    })).rejects.toThrow('Basic v2 API key');
    expect(aiFetchStreamStart).not.toHaveBeenCalled();

    bookTranslationSettings.update({ googleApiKey: 'key' });
    aiStream.mockReturnValue(streamChunks(
      { kind: 'chunk', data: JSON.stringify({ data: { translations: [] } }) },
      { kind: 'done' },
    ));
    await expect(requestTranslationReference({
      provider: 'google',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    })).rejects.toThrow('translated text');
  });
});

describe('requestTranslationReference — cancellation', () => {
  it('cancels the bridge stream and rejects with AbortError when aborted mid-request', async () => {
    bookTranslationSettings.update({ googleApiKey: 'key' });
    let releaseStream: (() => void) | null = null;
    aiStream.mockReturnValue((async function* () {
      await new Promise<void>((resolve) => { releaseStream = resolve; });
      yield { kind: 'error' as const, message: 'cancelled' };
    })());
    aiFetchStreamCancel.mockImplementation(async () => {
      releaseStream?.();
      return { status: 'ok', data: null };
    });
    const controller = new AbortController();

    const pending = requestTranslationReference({
      provider: 'google',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    }, controller.signal);
    await vi.waitFor(() => expect(aiStream).toHaveBeenCalledWith('stream-1'));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(aiFetchStreamCancel).toHaveBeenCalledWith('stream-1');
  });

  it('never starts a request whose signal is already aborted', async () => {
    bookTranslationSettings.update({ googleApiKey: 'key' });
    const controller = new AbortController();
    controller.abort();

    await expect(requestTranslationReference({
      provider: 'llm',
      source: 'Hello',
      sourceLanguage: null,
      targetLanguage: 'zh-CN',
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(aiFetchStreamStart).not.toHaveBeenCalled();
  });
});

describe('requestTranslationReference — AI Talk', () => {
  it('uses the active profile and joins streamed content while ignoring reasoning', async () => {
    aiStream.mockReturnValue(streamChunks(
      { kind: 'chunk', data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] }) },
      { kind: 'chunk', data: JSON.stringify({ choices: [{ delta: { content: '你' } }] }) },
      { kind: 'chunk', data: JSON.stringify({ choices: [{ delta: { content: '好' } }] }) },
      { kind: 'done' },
    ));

    await expect(requestTranslationReference({
      provider: 'llm',
      source: 'Hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    })).resolves.toBe('你好');

    const request = aiFetchStreamStart.mock.calls[0][0];
    expect(request.url).toBe('https://api.example.test/v1/chat/completions');
    expect(request.sse).toBe(true);
    expect(JSON.parse(request.body)).toEqual({
      model: 'model-a',
      temperature: 0.2,
      stream: true,
      messages: [
        {
          role: 'system',
          content: 'Translate the source into targetLanguage, preserving literary tone, proper nouns, and paragraph structure. Return only the translation.',
        },
        {
          role: 'user',
          content: 'source language: en\ntarget language: zh-CN\n\nHello',
        },
      ],
    });
  });

  it('rejects invalid language codes, empty source, and oversized Unicode input', async () => {
    await expect(requestTranslationReference({
      provider: 'llm', source: ' ', sourceLanguage: 'en', targetLanguage: 'zh-CN',
    })).rejects.toThrow('source cannot be empty');
    await expect(requestTranslationReference({
      provider: 'llm', source: 'Hello', sourceLanguage: 'en_US', targetLanguage: 'zh-CN',
    })).rejects.toThrow('Source language code is invalid');
    await expect(requestTranslationReference({
      provider: 'llm', source: 'Hello', sourceLanguage: 'en', targetLanguage: 'zh_CN',
    })).rejects.toThrow('Target language code is invalid');
    await expect(requestTranslationReference({
      provider: 'llm', source: '😀'.repeat(30_001), sourceLanguage: 'en', targetLanguage: 'zh-CN',
    })).rejects.toThrow('30,000');
    expect(aiFetchStreamStart).not.toHaveBeenCalled();
  });
});
