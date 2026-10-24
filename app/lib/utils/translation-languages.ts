export type TranslationLanguageOption = {
  code: string;
  label: string;
};

/** Common source/target languages offered by the book translation importer. */
export const TRANSLATION_LANGUAGE_OPTIONS: readonly TranslationLanguageOption[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ru', label: 'Русский' },
];

export const TRANSLATION_LANGUAGE_CODES = TRANSLATION_LANGUAGE_OPTIONS.map(({ code }) => code);
export const TRANSLATION_LANGUAGE_CODE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function isValidTranslationLanguageCode(value: string, allowEmpty = false): boolean {
  const code = value;
  return (allowEmpty && code.length === 0)
    || (code.length <= 32 && TRANSLATION_LANGUAGE_CODE_PATTERN.test(code));
}

export function isKnownTranslationLanguageCode(code: string): boolean {
  return TRANSLATION_LANGUAGE_CODES.includes(code);
}
