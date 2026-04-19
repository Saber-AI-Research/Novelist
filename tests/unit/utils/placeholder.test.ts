import { describe, it, expect } from 'vitest';
import { parseTemplate, renderTemplate, isPlaceholder } from '$lib/utils/placeholder';

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

describe('renderTemplate', () => {
  it('renders Untitled 1.md', () => {
    const t = parseTemplate('Untitled {N}')!;
    expect(renderTemplate(t, 1, { kind: 'arabic', width: 1 }, null)).toBe('Untitled 1.md');
  });
  it('renders 第一章.md (chinese-lower)', () => {
    const t = parseTemplate('第{N}章')!;
    expect(renderTemplate(t, 1, { kind: 'chinese-lower' }, null)).toBe('第一章.md');
  });
  it('renders 03-Untitled.md when title slot present', () => {
    const t = parseTemplate('{N}-{title}')!;
    expect(renderTemplate(t, 3, { kind: 'arabic', width: 2 }, null)).toBe('03-Untitled.md');
  });
  it('substitutes title slot when title given', () => {
    const t = parseTemplate('{N}-{title}')!;
    expect(renderTemplate(t, 3, { kind: 'arabic', width: 2 }, '开篇')).toBe('03-开篇.md');
  });
  it('appends title with space when no slot (chapter prefix)', () => {
    const t = parseTemplate('第{N}章')!;
    expect(renderTemplate(t, 3, { kind: 'chinese-lower' }, '开篇')).toBe('第三章 开篇.md');
  });
  it('appends title without space when stem ends in closing bracket', () => {
    const t = parseTemplate('【第{N}章】')!;
    expect(renderTemplate(t, 3, { kind: 'chinese-lower' }, '开篇')).toBe('【第三章】开篇.md');
  });
  it('Untitled {N} replaces full name when title given', () => {
    const t = parseTemplate('Untitled {N}')!;
    expect(renderTemplate(t, 1, { kind: 'arabic', width: 1 }, '开篇')).toBe('开篇.md');
  });
});

describe('isPlaceholder', () => {
  it('detects Untitled N', () => {
    expect(isPlaceholder('Untitled 1.md')).toBe(true);
    expect(isPlaceholder('Untitled 42.md')).toBe(true);
  });
  it('detects 第N章 (chinese-lower or arabic)', () => {
    expect(isPlaceholder('第三章.md')).toBe(true);
    expect(isPlaceholder('第3章.md')).toBe(true);
  });
  it('detects Chapter N', () => {
    expect(isPlaceholder('Chapter 3.md')).toBe(true);
  });
  it('detects {N}-Untitled', () => {
    expect(isPlaceholder('03-Untitled.md')).toBe(true);
    expect(isPlaceholder('03_Untitled.md')).toBe(true);
    expect(isPlaceholder('3.Untitled.md')).toBe(true);
  });
  it('detects legacy novelist_scratch_<ts>', () => {
    expect(isPlaceholder('novelist_scratch_1234567890.md')).toBe(true);
  });
  it('rejects user-named files', () => {
    expect(isPlaceholder('开篇.md')).toBe(false);
    expect(isPlaceholder('Hello World.md')).toBe(false);
    expect(isPlaceholder('第三章 开篇.md')).toBe(false);
    expect(isPlaceholder('03-开篇.md')).toBe(false);
  });
});
