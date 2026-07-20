import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * [contract] i18n — locale resolution, fallback to English, parameter
 * interpolation, plural selection, init() from localStorage / browser.
 */

import { i18n } from '$lib/i18n';
import { en } from '$lib/i18n/locales/en';
import { zhCN } from '$lib/i18n/locales/zh-CN';

const LOCALE_KEY = 'novelist-locale';

beforeEach(() => {
  localStorage.clear();
  i18n.locale = 'en';
});

describe('[contract] i18n basic translation', () => {
  it('keeps English and Simplified Chinese locale keys in exact parity', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  it('returns the key itself when no translation exists (safe fallback)', () => {
    const missing = '__definitely_not_a_key__';
    expect(i18n.t(missing)).toBe(missing);
  });

  it('returns the English string for a real key', () => {
    const k = Object.keys(en)[0];
    expect(typeof i18n.t(k)).toBe('string');
  });

  it('interpolates {name}-style placeholders', () => {
    // Install a key we can trust into the messages via the known locale map.
    // We rely on `t` treating unknown keys as the key itself, then applying
    // the replace loop. So any params replace {tokens} even on unknown keys.
    const out = i18n.t('Hello {name}, you have {count}', { name: 'Chivier', count: 3 });
    expect(out).toBe('Hello Chivier, you have 3');
  });

  it('replaces a placeholder globally (multiple occurrences)', () => {
    const out = i18n.t('{x} and {x}', { x: 'HI' });
    expect(out).toBe('HI and HI');
  });

  it('renders platform-provided shortcut labels in visible hints', () => {
    expect(i18n.t('sidebar.newFile', { shortcut: 'Ctrl+N' })).toBe('New File (Ctrl+N)');
    expect(i18n.t('sidebar.switchProject', { shortcut: 'Ctrl+1~9' })).toBe('Switch Project (Ctrl+1~9)');
    expect(i18n.t('sidebar.revealInExplorer')).toBe('Show in Explorer');
    expect(i18n.t('sidebar.revealInFileManager')).toBe('Show in File Manager');
    expect(i18n.t('welcome.moreProjectsHint', { count: 2, shortcut: 'Ctrl+Shift+P' })).toContain('Ctrl+Shift+P');
    expect(i18n.t('settings.editor.newFile.defaultDirHint', { shortcut: 'Ctrl+N' })).toContain('Ctrl+N');
  });

  it('provides complete English and Chinese block command and submenu labels', () => {
    const labels = {
      'editor.menu.blockType': ['Block Type', '块类型'],
      'command.blockParagraph': ['Convert to Paragraph', '转换为正文'],
      'command.blockHeading1': ['Convert to Heading 1', '转换为一级标题'],
      'command.blockHeading2': ['Convert to Heading 2', '转换为二级标题'],
      'command.blockHeading3': ['Convert to Heading 3', '转换为三级标题'],
      'command.blockHeading4': ['Convert to Heading 4', '转换为四级标题'],
      'command.blockHeading5': ['Convert to Heading 5', '转换为五级标题'],
      'command.blockHeading6': ['Convert to Heading 6', '转换为六级标题'],
      'command.blockQuote': ['Convert to Quote', '转换为引用'],
      'command.blockUnorderedList': ['Convert to Unordered List', '转换为无序列表'],
      'command.blockOrderedList': ['Convert to Ordered List', '转换为有序列表'],
      'command.blockTaskList': ['Convert to Task List', '转换为任务列表'],
      'command.blockCodeFence': ['Convert to Code Block', '转换为代码块'],
    } as const;

    for (const [key, [english, chinese]] of Object.entries(labels)) {
      expect(en[key]).toBe(english);
      expect(zhCN[key]).toBe(chinese);
    }
  });
});

describe('[contract] i18n locale switching', () => {
  it('setLocale updates the live locale and persists it', () => {
    i18n.setLocale('zh-CN');
    expect(i18n.locale).toBe('zh-CN');
    expect(localStorage.getItem(LOCALE_KEY)).toBe('zh-CN');
  });

  it('falls back to English messages when the key is missing in the active locale', () => {
    i18n.setLocale('zh-CN');
    // Invented key: zh-CN map shouldn't have it, en doesn't either → returns key.
    expect(i18n.t('__missing__')).toBe('__missing__');
  });

  it('renders platform-provided shortcut labels in Chinese hints', async () => {
    await i18n.setLocale('zh-CN');
    expect(i18n.t('sidebar.newFile', { shortcut: 'Ctrl+N' })).toBe('新建文件 (Ctrl+N)');
    expect(i18n.t('sidebar.switchProject', { shortcut: 'Ctrl+1~9' })).toBe('切换项目 (Ctrl+1~9)');
    expect(i18n.t('sidebar.revealInExplorer')).toBe('在资源管理器中显示');
    expect(i18n.t('sidebar.revealInFileManager')).toBe('在文件管理器中显示');
    expect(i18n.t('welcome.moreProjectsHint', { count: 2, shortcut: 'Ctrl+Shift+P' })).toContain('Ctrl+Shift+P');
    expect(i18n.t('settings.editor.newFile.defaultDirHint', { shortcut: 'Ctrl+N' })).toContain('Ctrl+N');
  });
});

describe('[contract] i18n availableLocales', () => {
  it('exposes exactly the two supported locales with native names', () => {
    const list = i18n.availableLocales;
    expect(list).toHaveLength(2);
    expect(list.find((l) => l.code === 'en')?.nativeName).toBe('English');
    expect(list.find((l) => l.code === 'zh-CN')?.nativeName).toBe('简体中文');
  });
});

describe('[contract] i18n.init()', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  it('restores the locale saved in localStorage', () => {
    localStorage.setItem(LOCALE_KEY, 'zh-CN');
    i18n.locale = 'en';
    i18n.init();
    expect(i18n.locale).toBe('zh-CN');
  });

  it('ignores an unknown saved locale and uses browser detection', () => {
    localStorage.setItem(LOCALE_KEY, 'fr-FR');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'zh-TW' },
    });
    i18n.locale = 'en';
    i18n.init();
    expect(i18n.locale).toBe('zh-CN');
  });

  it('stays on English when the browser language is not Chinese', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { language: 'de-DE' },
    });
    i18n.locale = 'en';
    i18n.init();
    expect(i18n.locale).toBe('en');
  });
});

describe('[contract] i18n plural forms', () => {
  it('picks the right plural variant based on params.count', async () => {
    // Seed a plural form on the fly via the internal messages map.
    const store = i18n as any;
    const original = store.locale;
    const zhCNMessages = (await import('$lib/i18n/locales/zh-CN')).zhCN;
    // Temporarily inject a plural key.
    (zhCNMessages as any).__plural_test__ = { zero: 'no items', one: '1 item', other: '{count} items' };
    // Await setLocale so the lazy-loaded zh-CN translation map is registered
    // in the store before we read it back via `t()`.
    await i18n.setLocale('zh-CN');
    try {
      expect(i18n.t('__plural_test__', { count: 0 })).toBe('no items');
      expect(i18n.t('__plural_test__', { count: 1 })).toBe('1 item');
      expect(i18n.t('__plural_test__', { count: 5 })).toBe('5 items');
    } finally {
      delete (zhCNMessages as any).__plural_test__;
      i18n.locale = original;
    }
  });
});
