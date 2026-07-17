import { describe, expect, it } from 'vitest';
import supportedHtmlRaw from '../../../fixtures/styled-copy/supported.input.html?raw';
import supportedAstRaw from '../../../fixtures/styled-copy/supported.ast.json?raw';
import { normalizePandocHtml } from '$lib/utils/styled-copy/normalize';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function containsDomNode(value: unknown): boolean {
  if (value instanceof Node) return true;
  if (Array.isArray(value)) return value.some(containsDomNode);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(containsDomNode);
  }
  return false;
}

describe('[contract] normalizePandocHtml supported semantics', () => {
  it('constructs the complete CJK semantic AST from an inert Pandoc fragment', () => {
    const expected = JSON.parse(normalizeLineEndings(supportedAstRaw));

    const result = normalizePandocHtml(normalizeLineEndings(supportedHtmlRaw));

    expect(result).toEqual({ kind: 'ok', value: expected, warnings: [] });
  });

  it('returns only typed plain values and no source DOM node', () => {
    const result = normalizePandocHtml(normalizeLineEndings(supportedHtmlRaw));

    expect(result.kind).toBe('ok');
    expect(containsDomNode(result)).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
