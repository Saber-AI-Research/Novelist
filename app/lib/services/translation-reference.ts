import { commands } from '$lib/ipc/commands';
import { aiTalkSettings } from '$lib/components/ai-talk/settings.svelte';
import { aiStream } from '$lib/components/ai-talk/host';
import { buildChatRequest, parseChatChunk, type ChatMessage } from '$lib/components/ai-talk/openai';
import { bookTranslationSettings } from '$lib/stores/book-translation-settings.svelte';
import { t } from '$lib/i18n';

export type TranslationReferenceProvider = 'google' | 'llm';

export type TranslationReferenceRequest = {
  provider: TranslationReferenceProvider;
  source: string;
  sourceLanguage: string | null;
  targetLanguage: string;
};

const MAX_SOURCE_CODE_POINTS = 30_000;
const MAX_LANGUAGE_CODE_LENGTH = 32;
const LANGUAGE_CODE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u;

function validateRequest(request: TranslationReferenceRequest): void {
  if (!request.source.trim()) throw new Error('Translation source cannot be empty.');
  if (Array.from(request.source).length > MAX_SOURCE_CODE_POINTS) {
    throw new Error('Translation source is too long (maximum 30,000 characters).');
  }
  if (request.sourceLanguage !== null && !isValidLanguageCode(request.sourceLanguage)) {
    throw new Error('Source language code is invalid.');
  }
  if (!isValidLanguageCode(request.targetLanguage)) {
    throw new Error('Target language code is invalid.');
  }
}

function isValidLanguageCode(value: string): boolean {
  return value.length > 0 && value.length <= MAX_LANGUAGE_CODE_LENGTH && LANGUAGE_CODE.test(value);
}

/** Rejection used when the caller aborted the request (e.g. its iframe unmounted). */
export function isTranslationReferenceAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortError(): DOMException {
  return new DOMException('Translation reference request was cancelled.', 'AbortError');
}

async function startStream(
  request: {
    url: string;
    headers: [string, string][];
    body: string;
    sse: boolean;
  },
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) throw abortError();
  const result = await commands.aiFetchStreamStart(request);
  if (result.status === 'error') throw new Error(result.error);
  if (signal?.aborted) {
    await commands.aiFetchStreamCancel(result.data).catch(() => undefined);
    throw abortError();
  }
  return result.data;
}

const MAX_ERROR_DETAIL_LENGTH = 300;

/**
 * Non-2xx responses arrive as the raw response body. Google and
 * OpenAI-compatible APIs both report `{"error":{"message":…}}`; show that
 * message instead of the JSON envelope.
 */
function describeStreamError(event: { message: string; status?: number }): string {
  let detail = event.message.trim();
  try {
    const parsed: unknown = JSON.parse(detail);
    const error = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : null;
    const message = typeof error === 'string'
      ? error
      : (error && typeof error === 'object' && 'message' in error ? error.message : null);
    if (typeof message === 'string' && message.trim()) detail = message.trim();
  } catch {
    // Not JSON: keep the body text.
  }
  if (detail.length > MAX_ERROR_DETAIL_LENGTH) detail = `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`;
  if (event.status) return detail ? `HTTP ${event.status}: ${detail}` : `HTTP ${event.status}`;
  return detail || 'Request failed.';
}

async function collectStream(
  streamId: string,
  parse: (chunk: string) => string | null,
  errorPrefix: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const events = aiStream(streamId);
  const cancel = () => {
    void commands.aiFetchStreamCancel(streamId).catch(() => undefined);
  };
  // Executor form (not Promise.withResolvers) keeps older Linux WebKitGTK working.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      cancel();
      reject(abortError());
    };
  });
  // Never surfaces as an unhandled rejection when the stream wins the race.
  aborted.catch(() => undefined);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let output = '';
  try {
    for (;;) {
      const step = await Promise.race([events.next(), aborted]);
      if (step.done) break;
      const event = step.value;
      if (event.kind === 'error') throw new Error(`${errorPrefix}: ${describeStreamError(event)}`);
      if (event.kind === 'done') break;
      const value = parse(event.data);
      if (value) output += value;
    }
  } catch (error) {
    // The Rust bridge normally closes an errored stream itself. Best-effort
    // cancellation also covers failures raised while decoding its payload.
    if (!isTranslationReferenceAbort(error)) cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Release the event listener once the bridge ends the stream.
    void events.return(undefined);
  }
  return output;
}

async function requestGoogleTranslation(
  request: TranslationReferenceRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  const googleApiKey = bookTranslationSettings.value.googleApiKey.trim();
  if (!googleApiKey) throw new Error(t('settings.bookTranslation.missingGoogleCredentials'));
  const body: { q: string; target: string; format: 'text'; source?: string } = {
    q: request.source,
    target: request.targetLanguage,
    format: 'text',
  };
  if (request.sourceLanguage !== null) body.source = request.sourceLanguage;

  // The key travels in a header, never the URL: network errors from the
  // bridge quote the request URL and are shown to the plugin.
  const streamId = await startStream({
    url: 'https://translation.googleapis.com/language/translate/v2',
    headers: [
      ['Content-Type', 'application/json'],
      ['X-goog-api-key', googleApiKey],
    ],
    body: JSON.stringify(body),
    sse: false,
  }, signal);
  const responseBody = await collectStream(streamId, (chunk) => chunk, 'Google Translation failed', signal);

  let parsed: {
    data?: { translations?: Array<{ translatedText?: unknown }> };
    error?: { message?: unknown };
  };
  try {
    parsed = JSON.parse(responseBody) as typeof parsed;
  } catch {
    throw new Error('Google Translation returned an invalid response.');
  }
  if (parsed.error?.message) {
    throw new Error(`Google Translation failed: ${String(parsed.error.message)}`);
  }
  const translatedText = parsed.data?.translations?.[0]?.translatedText;
  if (typeof translatedText !== 'string' || !translatedText.trim()) {
    throw new Error('Google Translation response did not include a translated text.');
  }
  return translatedText;
}

async function requestLlmTranslation(
  request: TranslationReferenceRequest,
  signal: AbortSignal | undefined,
): Promise<string> {
  const settings = aiTalkSettings.value;
  const profile = settings.profiles.find((candidate) => candidate.id === settings.activeProfileId);
  if (!profile) throw new Error('AI Talk has no active provider profile.');
  if (!profile.baseUrl.trim() || !profile.apiKey.trim() || !profile.model.trim()) {
    throw new Error('AI Talk active profile is missing a base URL, API key, or model.');
  }

  const systemPrompt =
    'Translate the source into targetLanguage, preserving literary tone, proper nouns, and paragraph structure. Return only the translation.';
  const userMessage = [
    `source language: ${request.sourceLanguage ?? 'auto'}`,
    `target language: ${request.targetLanguage}`,
    '',
    request.source,
  ].join('\n');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const chatRequest = buildChatRequest({
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    temperature: profile.temperature,
    messages,
  });
  const streamId = await startStream(chatRequest, signal);
  const response = await collectStream(
    streamId,
    (chunk) => parseChatChunk(chunk)?.content ?? null,
    'AI Talk request failed',
    signal,
  );
  if (!response.trim()) throw new Error('AI Talk returned an empty translation.');
  return response;
}

/**
 * Fetch a reference translation for the book-translation plugin.
 *
 * Deliberate exception to "no HTTP in the kernel" (see
 * docs/design-docs/plugin-system.md): the request needs the user's Google key
 * and AI Talk credentials, which must never be handed to a plugin iframe. The
 * host only relays plain text; `signal` cancels the in-flight stream when the
 * requesting iframe goes away.
 */
export async function requestTranslationReference(
  request: TranslationReferenceRequest,
  signal?: AbortSignal,
): Promise<string> {
  validateRequest(request);
  if (request.provider === 'google') return requestGoogleTranslation(request, signal);
  if (request.provider === 'llm') return requestLlmTranslation(request, signal);
  throw new Error('Translation provider is invalid.');
}

export { isValidLanguageCode };
