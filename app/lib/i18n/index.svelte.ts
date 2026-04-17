import type { Locale, TranslationMap, TranslationValue } from './types';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';

const LOCALE_KEY = 'novelist-locale';

const translations: Record<Locale, TranslationMap> = {
  'en': en,
  'zh-CN': zhCN,
};

class I18nStore {
  locale = $state<Locale>('en');

  private get messages(): TranslationMap {
    return translations[this.locale] ?? translations['en'];
  }

  t(key: string, params?: Record<string, string | number>): string {
    let value = this.messages[key] ?? translations['en'][key] ?? key;

    if (typeof value === 'object') {
      const count = typeof params?.count === 'number' ? params.count : 0;
      if (count === 0 && value.zero) {
        value = value.zero;
      } else if (count === 1 && value.one) {
        value = value.one;
      } else {
        value = value.other;
      }
    }

    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = (value as string).replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
      }
    }

    return value as string;
  }

  get availableLocales(): { code: Locale; name: string; nativeName: string }[] {
    return [
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
    ];
  }

  setLocale(locale: Locale) {
    this.locale = locale;
    localStorage.setItem(LOCALE_KEY, locale);
  }

  init() {
    const saved = localStorage.getItem(LOCALE_KEY) as Locale | null;
    if (saved && saved in translations) {
      this.locale = saved;
      return;
    }

    const browserLocale = navigator.language;
    if (browserLocale.startsWith('zh')) {
      this.locale = 'zh-CN';
    }
  }
}

export const i18n = new I18nStore();
export const t = i18n.t.bind(i18n);
export type { Locale };
