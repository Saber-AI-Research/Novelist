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
