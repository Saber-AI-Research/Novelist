import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [precision] chinese.ts — Simplified/Traditional conversion + pinyin.
 * Uses module mocks for opencc-js and pinyin-pro to avoid pulling in the
 * full dictionaries (which are huge). Verifies lazy-loading contract +
 * memoization of the OpenCC converters.
 */

const openccConverterFactory = vi.fn(({ from, to }: { from: string; to: string }) =>
  (text: string) => `${from}->${to}:${text}`,
);

vi.mock('opencc-js', () => ({
  Converter: openccConverterFactory,
}));

vi.mock('pinyin-pro', () => ({
  pinyin: (text: string, opts: { toneType: string; type: string }) =>
    `${text}|${opts.toneType}|${opts.type}`,
}));

beforeEach(() => {
  openccConverterFactory.mockClear();
  vi.resetModules();
});

describe('[precision] chinese — simplifiedToTraditional', () => {
  it('delegates to the opencc cn->tw converter', async () => {
    const { simplifiedToTraditional } = await import('$lib/utils/chinese');
    const result = await simplifiedToTraditional('简体');
    expect(result).toBe('cn->tw:简体');
  });

  it('constructs both converters exactly once across repeated calls', async () => {
    const { simplifiedToTraditional, traditionalToSimplified } = await import(
      '$lib/utils/chinese'
    );
    await simplifiedToTraditional('a');
    await simplifiedToTraditional('b');
    await traditionalToSimplified('c');
    // One S2T + one T2S factory call, regardless of how many conversions run.
    expect(openccConverterFactory).toHaveBeenCalledTimes(2);
    expect(openccConverterFactory).toHaveBeenCalledWith({ from: 'cn', to: 'tw' });
    expect(openccConverterFactory).toHaveBeenCalledWith({ from: 'tw', to: 'cn' });
  });
});

describe('[precision] chinese — traditionalToSimplified', () => {
  it('delegates to the opencc tw->cn converter', async () => {
    const { traditionalToSimplified } = await import('$lib/utils/chinese');
    expect(await traditionalToSimplified('繁體')).toBe('tw->cn:繁體');
  });
});

describe('[precision] chinese — toPinyin', () => {
  it('uses symbol tone marks and string return type', async () => {
    const { toPinyin } = await import('$lib/utils/chinese');
    expect(await toPinyin('你好')).toBe('你好|symbol|string');
  });
});
