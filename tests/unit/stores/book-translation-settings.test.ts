import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bookTranslationSettings, BOOK_TRANSLATION_SETTINGS_KEY } from '$lib/stores/book-translation-settings.svelte';

describe('bookTranslationSettings store', () => {
  beforeEach(() => {
    bookTranslationSettings.reset();
  });

  it('starts with an empty Google API key and persists updates', () => {
    expect(bookTranslationSettings.value).toEqual({ googleApiKey: '' });

    bookTranslationSettings.update({ googleApiKey: 'key-123' });

    expect(bookTranslationSettings.value.googleApiKey).toBe('key-123');
    expect(JSON.parse(localStorage.getItem(BOOK_TRANSLATION_SETTINGS_KEY) ?? '{}')).toEqual({ googleApiKey: 'key-123' });
  });

  it('reset clears the key and persists the default', () => {
    bookTranslationSettings.update({ googleApiKey: 'key-123' });
    bookTranslationSettings.reset();

    expect(bookTranslationSettings.value.googleApiKey).toBe('');
    expect(localStorage.getItem(BOOK_TRANSLATION_SETTINGS_KEY)).toBe(JSON.stringify({ googleApiKey: '' }));
  });

  it('does not throw when localStorage writes fail', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    expect(() => bookTranslationSettings.update({ googleApiKey: 'key' })).not.toThrow();
    expect(bookTranslationSettings.value.googleApiKey).toBe('key');

    spy.mockRestore();
  });
});

describe('bookTranslationSettings loading', () => {
  /** A fresh module instance reads whatever is in storage at import time. */
  async function loadWith(stored: string | null) {
    localStorage.clear();
    if (stored !== null) localStorage.setItem(BOOK_TRANSLATION_SETTINGS_KEY, stored);
    vi.resetModules();
    const { bookTranslationSettings: fresh } = await import('$lib/stores/book-translation-settings.svelte');
    return fresh.value;
  }

  it('restores a persisted Google API key', async () => {
    await expect(loadWith(JSON.stringify({ googleApiKey: 'saved-key' })))
      .resolves.toEqual({ googleApiKey: 'saved-key' });
  });

  it('falls back to defaults for missing, corrupt, or mistyped values', async () => {
    await expect(loadWith(null)).resolves.toEqual({ googleApiKey: '' });
    await expect(loadWith('{not json')).resolves.toEqual({ googleApiKey: '' });
    await expect(loadWith(JSON.stringify({ googleApiKey: 42 }))).resolves.toEqual({ googleApiKey: '' });
    await expect(loadWith('null')).resolves.toEqual({ googleApiKey: '' });
  });
});
