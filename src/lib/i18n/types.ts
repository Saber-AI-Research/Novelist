export type Locale = 'en' | 'zh-CN';

export type TranslationValue = string | {
  zero?: string;
  one?: string;
  other: string;
};

export type TranslationMap = Record<string, TranslationValue>;
