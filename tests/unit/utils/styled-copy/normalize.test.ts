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

function nestedBlockquotes(depth: number): string {
  return `${'<blockquote>'.repeat(depth)}${'</blockquote>'.repeat(depth)}`;
}

function tableWith(rows: number, columns: number): string {
  const row = `<tr>${'<td>x</td>'.repeat(columns)}</tr>`;
  return `<table><tbody>${row.repeat(rows)}</tbody></table>`;
}

describe('[contract] normalizePandocHtml structural preflight', () => {
  it('accepts exactly 50,000 produced nodes and blocks node 50,001', () => {
    const atLimit = normalizePandocHtml('<br>'.repeat(50_000));
    const overLimit = normalizePandocHtml('<br>'.repeat(50_001));

    expect(atLimit.kind).toBe('ok');
    expect(overLimit).toEqual({
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'nodes',
        maximum: 50_000,
        actual: 50_001,
      },
    });
  });

  it('counts the first semantic node at depth 1 and blocks depth 129', () => {
    expect(normalizePandocHtml(nestedBlockquotes(128)).kind).toBe('ok');
    expect(normalizePandocHtml(nestedBlockquotes(129))).toEqual({
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'depth',
        maximum: 128,
        actual: 129,
      },
    });
  });

  it('does not count transparent or dropped source elements as semantic nodes', () => {
    const transparent = `<div>${'<span></span>'.repeat(50_001)}<p>可见</p></div>`;

    expect(normalizePandocHtml(transparent)).toEqual({
      kind: 'ok',
      value: {
        type: 'document',
        children: [{
          type: 'paragraph',
          children: [{ type: 'text', value: '可见' }],
        }],
      },
      warnings: [],
    });
  });

  it('enforces table row and column limits independently', () => {
    expect(normalizePandocHtml(tableWith(500, 1)).kind).toBe('ok');
    expect(normalizePandocHtml(tableWith(1, 100)).kind).toBe('ok');
    expect(normalizePandocHtml(tableWith(501, 1))).toEqual({
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'table_rows',
        maximum: 500,
        actual: 501,
        tableIndex: 0,
      },
    });
    expect(normalizePandocHtml(tableWith(1, 101))).toEqual({
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'table_columns',
        maximum: 100,
        actual: 101,
        tableIndex: 0,
      },
    });
  });

  it('blocks a structurally empty table row without returning a partial AST', () => {
    expect(normalizePandocHtml('<p>before</p><table><tbody><tr></tr></tbody></table><p>after</p>')).toEqual({
      kind: 'error',
      error: { code: 'malformed_table', tableIndex: 0, reason: 'empty_row' },
    });
  });
});
