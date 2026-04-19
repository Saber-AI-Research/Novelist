import { describe, it, expect } from 'vitest';
import { parseTemplate } from '$lib/utils/placeholder';

describe('parseTemplate', () => {
  it('parses Untitled {N}', () => {
    const t = parseTemplate('Untitled {N}');
    expect(t).toEqual({
      raw: 'Untitled {N}',
      prefix: 'Untitled ',
      suffix: '',
      hasTitleSlot: false,
      titleSlotPosition: null,
    });
  });
  it('parses 第{N}章', () => {
    const t = parseTemplate('第{N}章');
    expect(t?.prefix).toBe('第');
    expect(t?.suffix).toBe('章');
    expect(t?.hasTitleSlot).toBe(false);
  });
  it('parses Chapter {N}', () => {
    const t = parseTemplate('Chapter {N}');
    expect(t?.prefix).toBe('Chapter ');
    expect(t?.suffix).toBe('');
  });
  it('parses {N}-{title}', () => {
    const t = parseTemplate('{N}-{title}');
    expect(t?.prefix).toBe('');
    expect(t?.suffix).toBe('-{title}');
    expect(t?.hasTitleSlot).toBe(true);
    expect(t?.titleSlotPosition).toBe('after');
  });
  it('rejects template missing {N}', () => {
    expect(parseTemplate('no number')).toBeNull();
  });
  it('rejects template with multiple {N}', () => {
    expect(parseTemplate('{N}-{N}')).toBeNull();
  });
  it('rejects empty', () => {
    expect(parseTemplate('')).toBeNull();
  });
});
