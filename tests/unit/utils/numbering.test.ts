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
