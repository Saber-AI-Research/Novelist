import { describe, it, expect } from 'vitest';
import { getCaretCoordinates } from '$lib/components/ai-shared/caret-coordinates';

/**
 * jsdom has no layout engine, so pixel values are 0 here — these tests pin the
 * contract (numeric fields, no throw, no leaked mirror node) rather than exact
 * geometry, which is exercised manually in the real webview.
 */
describe('getCaretCoordinates', () => {
  function makeTextarea(value: string): HTMLTextAreaElement {
    const el = document.createElement('textarea');
    el.value = value;
    document.body.appendChild(el);
    return el;
  }

  it('returns numeric top/left/height without throwing', () => {
    const el = makeTextarea('hello /');
    const coords = getCaretCoordinates(el, el.value.length);
    expect(typeof coords.top).toBe('number');
    expect(typeof coords.left).toBe('number');
    expect(typeof coords.height).toBe('number');
    expect(Number.isNaN(coords.top)).toBe(false);
    expect(Number.isNaN(coords.left)).toBe(false);
    el.remove();
  });

  it('measures at an arbitrary caret position', () => {
    const el = makeTextarea('one @two three');
    expect(() => getCaretCoordinates(el, 8)).not.toThrow();
    el.remove();
  });

  it('handles a caret at the very end (empty trailing text)', () => {
    const el = makeTextarea('/');
    expect(() => getCaretCoordinates(el, 1)).not.toThrow();
    el.remove();
  });

  it('removes the mirror div it creates (no DOM leak)', () => {
    const el = makeTextarea('measure me @x');
    const before = document.body.childElementCount;
    getCaretCoordinates(el, 5);
    expect(document.body.childElementCount).toBe(before);
    el.remove();
  });
});
