import { describe, it, expect } from 'vitest';
import { parseNumber, formatNumber } from '$lib/utils/numbering';

describe('parseNumber — Arabic', () => {
  it('parses bare digits', () => {
    expect(parseNumber('1')).toEqual({ value: 1, style: { kind: 'arabic', width: 1 } });
    expect(parseNumber('42')).toEqual({ value: 42, style: { kind: 'arabic', width: 2 } });
  });
  it('preserves zero-padding width', () => {
    expect(parseNumber('01')).toEqual({ value: 1, style: { kind: 'arabic', width: 2 } });
    expect(parseNumber('001')).toEqual({ value: 1, style: { kind: 'arabic', width: 3 } });
  });
  it('returns null for non-numbers', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('-1')).toBeNull();
  });
});

describe('formatNumber — Arabic', () => {
  it('renders bare', () => {
    expect(formatNumber(7, { kind: 'arabic', width: 1 })).toBe('7');
  });
  it('zero-pads to width', () => {
    expect(formatNumber(7, { kind: 'arabic', width: 2 })).toBe('07');
    expect(formatNumber(7, { kind: 'arabic', width: 3 })).toBe('007');
    expect(formatNumber(42, { kind: 'arabic', width: 2 })).toBe('42');
  });
  it('exceeds width without truncating', () => {
    expect(formatNumber(123, { kind: 'arabic', width: 2 })).toBe('123');
  });
});

describe('parseNumber — Chinese lower', () => {
  it('parses 一 to 十', () => {
    expect(parseNumber('一')?.value).toBe(1);
    expect(parseNumber('五')?.value).toBe(5);
    expect(parseNumber('十')?.value).toBe(10);
  });
  it('parses 11–19 as 十N', () => {
    expect(parseNumber('十一')?.value).toBe(11);
    expect(parseNumber('十九')?.value).toBe(19);
  });
  it('parses N十 (20, 30, 90)', () => {
    expect(parseNumber('二十')?.value).toBe(20);
    expect(parseNumber('九十')?.value).toBe(90);
  });
  it('parses N十M (21–99)', () => {
    expect(parseNumber('二十一')?.value).toBe(21);
    expect(parseNumber('九十九')?.value).toBe(99);
  });
  it('parses 一百 to 九百九十九', () => {
    expect(parseNumber('一百')?.value).toBe(100);
    expect(parseNumber('一百零一')?.value).toBe(101);
    expect(parseNumber('一百二十三')?.value).toBe(123);
    expect(parseNumber('九百九十九')?.value).toBe(999);
  });
  it('returns chinese-lower style', () => {
    expect(parseNumber('五')?.style).toEqual({ kind: 'chinese-lower' });
  });
});

describe('formatNumber — Chinese lower', () => {
  it('formats 1–10', () => {
    expect(formatNumber(1, { kind: 'chinese-lower' })).toBe('一');
    expect(formatNumber(10, { kind: 'chinese-lower' })).toBe('十');
  });
  it('formats 11–19', () => {
    expect(formatNumber(11, { kind: 'chinese-lower' })).toBe('十一');
    expect(formatNumber(19, { kind: 'chinese-lower' })).toBe('十九');
  });
  it('formats N0 (20, 90)', () => {
    expect(formatNumber(20, { kind: 'chinese-lower' })).toBe('二十');
    expect(formatNumber(90, { kind: 'chinese-lower' })).toBe('九十');
  });
  it('formats N1–N9 (21–99)', () => {
    expect(formatNumber(21, { kind: 'chinese-lower' })).toBe('二十一');
    expect(formatNumber(99, { kind: 'chinese-lower' })).toBe('九十九');
  });
  it('formats 100–999', () => {
    expect(formatNumber(100, { kind: 'chinese-lower' })).toBe('一百');
    expect(formatNumber(101, { kind: 'chinese-lower' })).toBe('一百零一');
    expect(formatNumber(110, { kind: 'chinese-lower' })).toBe('一百一十');
    expect(formatNumber(123, { kind: 'chinese-lower' })).toBe('一百二十三');
    expect(formatNumber(999, { kind: 'chinese-lower' })).toBe('九百九十九');
  });
});

describe('parseNumber — Chinese lower rejects non-canonical', () => {
  it('rejects 十零 (double 零 via 十)', () => {
    expect(parseNumber('十零')).toBeNull();
  });
  it('rejects 一百零零 (double 零)', () => {
    expect(parseNumber('一百零零')).toBeNull();
  });
  it('rejects bare 一百十 (canonical is 一百一十)', () => {
    expect(parseNumber('一百十')).toBeNull();
  });
  it('rejects bare 一百十一 (canonical is 一百一十一)', () => {
    expect(parseNumber('一百十一')).toBeNull();
  });
  it('rejects 一百一 (canonical is 一百零一)', () => {
    expect(parseNumber('一百一')).toBeNull();
  });
  it('still accepts canonical forms', () => {
    expect(parseNumber('一百一十')?.value).toBe(110);
    expect(parseNumber('一百一十一')?.value).toBe(111);
    expect(parseNumber('一百零一')?.value).toBe(101);
  });
});

describe('parseNumber — Chinese upper', () => {
  it('parses 壹 to 拾', () => {
    expect(parseNumber('壹')?.value).toBe(1);
    expect(parseNumber('玖')?.value).toBe(9);
    expect(parseNumber('拾')?.value).toBe(10);
  });
  it('returns chinese-upper style', () => {
    expect(parseNumber('壹')?.style).toEqual({ kind: 'chinese-upper' });
  });
});

describe('formatNumber — Chinese upper', () => {
  it('formats 1–10', () => {
    expect(formatNumber(1, { kind: 'chinese-upper' })).toBe('壹');
    expect(formatNumber(10, { kind: 'chinese-upper' })).toBe('拾');
  });
});

describe('parseNumber — Roman', () => {
  it('parses I, V, X, L, C, D, M', () => {
    expect(parseNumber('I')?.value).toBe(1);
    expect(parseNumber('V')?.value).toBe(5);
    expect(parseNumber('X')?.value).toBe(10);
  });
  it('parses additive (II, III, VIII)', () => {
    expect(parseNumber('II')?.value).toBe(2);
    expect(parseNumber('VIII')?.value).toBe(8);
  });
  it('parses subtractive (IV, IX, XL, XC, CD, CM)', () => {
    expect(parseNumber('IV')?.value).toBe(4);
    expect(parseNumber('IX')?.value).toBe(9);
    expect(parseNumber('XL')?.value).toBe(40);
    expect(parseNumber('XC')?.value).toBe(90);
    expect(parseNumber('CD')?.value).toBe(400);
    expect(parseNumber('CM')?.value).toBe(900);
  });
  it('parses compound (XLII = 42, MCMXCIV = 1994)', () => {
    expect(parseNumber('XLII')?.value).toBe(42);
    expect(parseNumber('MCMXCIV')?.value).toBe(1994);
  });
  it('returns roman-upper style', () => {
    expect(parseNumber('IV')?.style).toEqual({ kind: 'roman-upper' });
  });
  it('rejects mixed case or invalid', () => {
    expect(parseNumber('iv')).toBeNull();
    expect(parseNumber('IIII')).toBeNull();  // strict: non-canonical
  });
});

describe('formatNumber — Roman', () => {
  it('formats 1, 4, 9, 40, 90, 400, 900', () => {
    expect(formatNumber(1, { kind: 'roman-upper' })).toBe('I');
    expect(formatNumber(4, { kind: 'roman-upper' })).toBe('IV');
    expect(formatNumber(9, { kind: 'roman-upper' })).toBe('IX');
    expect(formatNumber(40, { kind: 'roman-upper' })).toBe('XL');
    expect(formatNumber(90, { kind: 'roman-upper' })).toBe('XC');
    expect(formatNumber(400, { kind: 'roman-upper' })).toBe('CD');
    expect(formatNumber(900, { kind: 'roman-upper' })).toBe('CM');
  });
  it('formats compound (1994 = MCMXCIV)', () => {
    expect(formatNumber(1994, { kind: 'roman-upper' })).toBe('MCMXCIV');
  });
});
