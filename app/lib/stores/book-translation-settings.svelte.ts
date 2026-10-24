/** Persistent credentials for the Book Translation plugin.
 *
 * The Google Cloud API key stays in localStorage only. Translation project
 * metadata and chapter files never include this value.
 */

const KEY = 'novelist:book-translation:settings:v1';

export type BookTranslationSettings = {
  googleApiKey: string;
};

const DEFAULTS: BookTranslationSettings = { googleApiKey: '' };

function load(): BookTranslationSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BookTranslationSettings>;
    return {
      googleApiKey: typeof parsed.googleApiKey === 'string' ? parsed.googleApiKey : DEFAULTS.googleApiKey,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(value: BookTranslationSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Storage may be disabled or full; the in-memory setting remains usable.
  }
}

class BookTranslationSettingsStore {
  value = $state<BookTranslationSettings>(load());

  update(patch: Partial<BookTranslationSettings>): void {
    this.value = { ...this.value, ...patch };
    persist(this.value);
  }

  reset(): void {
    this.value = { ...DEFAULTS };
    persist(this.value);
  }
}

export const bookTranslationSettings = new BookTranslationSettingsStore();
export { KEY as BOOK_TRANSLATION_SETTINGS_KEY };
