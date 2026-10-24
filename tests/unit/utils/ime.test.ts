import { describe, it, expect } from 'vitest';
import { isImeComposing } from '$lib/utils/ime';

function key(init: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
  return { key: 'Enter', isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 } as KeyboardEvent;
}

describe('isImeComposing', () => {
  it('is true while the event reports an active composition', () => {
    expect(isImeComposing(key({ isComposing: true }))).toBe(true);
  });

  it('is true for the WebKit commit Enter that reports keyCode 229 without isComposing', () => {
    expect(isImeComposing(key({ isComposing: false, keyCode: 229 }))).toBe(true);
  });

  it('is false for a plain Enter outside composition', () => {
    expect(isImeComposing(key({ isComposing: false, keyCode: 13 }))).toBe(false);
  });
});
