import { describe, expect, it } from 'vitest';
import supportedHtmlRaw from '../../../fixtures/styled-copy/supported.input.html?raw';
import supportedAstRaw from '../../../fixtures/styled-copy/supported.ast.json?raw';
import maliciousHtmlRaw from '../../../fixtures/styled-copy/malicious.input.html?raw';
import maliciousAstRaw from '../../../fixtures/styled-copy/malicious.ast.json?raw';
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

describe('[contract] normalizePandocHtml untrusted markup', () => {
  it('unwraps unsafe links, drops dangerous subtrees, and deduplicates warnings', () => {
    const expected = JSON.parse(normalizeLineEndings(maliciousAstRaw));

    const result = normalizePandocHtml(normalizeLineEndings(maliciousHtmlRaw));

    expect(result).toEqual({
      kind: 'ok',
      value: expected,
      warnings: [
        { code: 'unsafe_link_removed', payload: 'javascript:alert(1)' },
        { code: 'relative_link_removed', payload: './chapter-2' },
        { code: 'relative_link_removed', payload: '#section' },
        { code: 'unsafe_link_removed', payload: 'file:///tmp/private' },
        { code: 'unsafe_link_removed', payload: 'data:text/html,bad' },
        { code: 'unsafe_link_removed', payload: 'blob:https://example.com/id' },
        { code: 'relative_link_removed', payload: '//protocol.example/path' },
        { code: 'malformed_link' },
        { code: 'malformed_footnote', payload: '#missing-note' },
        { code: 'duplicate_footnote', payload: 'fn-duplicate' },
      ],
    });
  });

  it('never exposes source metadata or executable element content', () => {
    const result = normalizePandocHtml(normalizeLineEndings(maliciousHtmlRaw));
    const serialized = JSON.stringify(result);

    for (const sourceKey of ['class', 'style', 'data-secret', 'onclick', 'onerror', 'srcset', 'name']) {
      expect(serialized).not.toContain(`\"${sourceKey}\"`);
    }
    for (const droppedText of [
      'DROP_SCRIPT_TEXT',
      'DROP_STYLE_TEXT',
      'DROP_TEMPLATE_TEXT',
      'DROP_FRAME_TEXT',
      'DROP_FORM_TEXT',
      'DROP_INPUT_VALUE',
      'DROP_OBJECT_TEXT',
      'DROP_SVG_SCRIPT',
      'DROP_SVG_TEXT',
    ]) {
      expect(serialized).not.toContain(droppedText);
    }
  });
});
