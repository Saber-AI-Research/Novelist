import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { countDocWords, countWordDelta } from '$lib/utils/doc-wordcount';
import { countWords } from '$lib/utils/wordcount';

/**
 * [regression] Long documents (> 5000 lines) used to show `length / 4`,
 * about 4x too low for Chinese. The editor now keeps an exact count by
 * recounting only the lines each edit touched; it must always equal a full
 * `countWords` pass.
 */

function doc(text: string): Text {
  return Text.of(text.split('\n'));
}

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PIECES = ['第一章', ' ', 'hello', 'world', '\n', '，', '。', '\n\n', 'naïve', '𠀀', '　', 'a', '中文字', '\t', 'x1'];

function randomText(next: () => number, maxPieces: number): string {
  let out = '';
  const n = Math.floor(next() * maxPieces);
  for (let i = 0; i < n; i++) out += PIECES[Math.floor(next() * PIECES.length)];
  return out;
}

describe('[regression] countDocWords', () => {
  it('matches countWords on the whole text for CJK, Latin and blank lines', () => {
    const text = '# 第一章\n\n他说：“你好。” hello world\n\n\nnaïve café 𠀀字\n  indented line';
    expect(countDocWords(doc(text))).toBe(countWords(text));
  });

  it('counts a long Chinese document exactly instead of estimating', () => {
    const text = Array.from({ length: 6000 }, (_, i) => `第${i}行的中文内容`).join('\n');
    expect(countDocWords(doc(text))).toBe(countWords(text));
  });
});

describe('[regression] countWordDelta', () => {
  it('keeps the running count equal to a full recount across random multi-range edits', () => {
    const next = rng(42);
    let current = doc(randomText(next, 200));
    let count = countDocWords(current);
    for (let step = 0; step < 500; step++) {
      // 1-3 non-overlapping changes, sorted, as one transaction.
      const spec = [];
      let pos = 0;
      const ranges = 1 + Math.floor(next() * 3);
      for (let r = 0; r < ranges && pos <= current.length; r++) {
        const from = pos + Math.floor(next() * Math.max(1, (current.length - pos) / 2));
        if (from > current.length) break;
        const to = Math.min(current.length, from + Math.floor(next() * 12));
        spec.push({ from, to, insert: randomText(next, 6) });
        pos = to + 1;
      }
      const changes = ChangeSet.of(spec, current.length);
      const updated = changes.apply(current);
      count += countWordDelta(current, updated, changes);
      expect(count).toBe(countWords(updated.toString()));
      current = updated;
    }
  });

  it('handles a newline deleted between two words (joins them into one)', () => {
    const before = doc('hello\nworld');
    const changes = ChangeSet.of([{ from: 5, to: 6 }], before.length);
    const after = changes.apply(before);
    expect(countDocWords(before) + countWordDelta(before, after, changes)).toBe(1);
  });
});
