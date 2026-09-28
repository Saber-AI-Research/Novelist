import { describe, expect, it } from 'vitest';
import { buildWordDiff } from '$lib/components/ai-shared/diff';

describe('[precision] AI inline edit diff', () => {
  it('keeps unchanged text and marks additions/removals', () => {
    expect(buildWordDiff('The old line', 'The new line')).toEqual([
      { kind: 'same', text: 'The ' },
      { kind: 'removed', text: 'old' },
      { kind: 'added', text: 'new' },
      { kind: 'same', text: ' line' },
    ]);
  });

  it('handles CJK text as non-whitespace tokens', () => {
    expect(buildWordDiff('第一章 风起', '第一章 雨落')).toEqual([
      { kind: 'same', text: '第一章 ' },
      { kind: 'removed', text: '风起' },
      { kind: 'added', text: '雨落' },
    ]);
  });

  it('diffs unspaced CJK prose per character instead of whole-paragraph', () => {
    expect(buildWordDiff('他低着头在角落找了个位置坐下。', '他低着头在角落里找了个空位坐下。')).toEqual([
      { kind: 'same', text: '他低着头在角落' },
      { kind: 'added', text: '里' },
      { kind: 'same', text: '找了个' },
      { kind: 'removed', text: '位置' },
      { kind: 'added', text: '空位' },
      { kind: 'same', text: '坐下。' },
    ]);
  });

  it('folds single-character unchanged islands inside a rewritten span', () => {
    const parts = buildWordDiff('风起云涌的夜', '雨落花开的晨');
    expect(parts).toEqual([
      { kind: 'removed', text: '风起云涌的夜' },
      { kind: 'added', text: '雨落花开的晨' },
    ]);
  });
});
