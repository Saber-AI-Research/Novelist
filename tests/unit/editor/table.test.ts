import { describe, it, expect } from 'vitest';

/**
 * Table feature tests.
 *
 * Tests the pure logic extracted from table.ts:
 * - GFM table parsing (headers, alignment, rows)
 * - Inline markdown → HTML rendering in cells
 * - Edge cases (empty cells, malformed tables, alignment variants)
 *
 * The actual CodeMirror ViewPlugin / widget rendering is browser-only
 * and covered by E2E tests (scripts/test-*.sh).
 */

// ── Re-implement pure functions from table.ts for testing ──

function parseCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(c => c.trim());
}

interface ParsedTable {
  headers: string[];
  alignments: ('left' | 'center' | 'right' | 'default')[];
  rows: string[][];
}

function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return null;

  const headers = parseCells(lines[0]);

  const sepCells = parseCells(lines[1]);
  const isSep = sepCells.every(c => /^:?\s*-+\s*:?$/.test(c.trim()));
  if (!isSep) return null;

  const alignments: ParsedTable['alignments'] = sepCells.map(cell => {
    const c = cell.trim();
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    if (c.startsWith(':')) return 'left';
    return 'default';
  });

  const rows = lines.slice(2).map(parseCells);

  return { headers, alignments, rows };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
  html = html.replace(/`(.+?)`/g, '<code class="cm-novelist-table-code">$1</code>');
  return html;
}

// ── Table parsing tests ──

describe('parseMarkdownTable', () => {
  it('parses a basic 3-column table', () => {
    const md = `| Name | Age | City |
| --- | --- | --- |
| Alice | 30 | NYC |
| Bob | 25 | LA |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['Name', 'Age', 'City']);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]).toEqual(['Alice', '30', 'NYC']);
    expect(result!.rows[1]).toEqual(['Bob', '25', 'LA']);
    expect(result!.alignments).toEqual(['default', 'default', 'default']);
  });

  it('parses alignment: left, center, right', () => {
    const md = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.alignments).toEqual(['left', 'center', 'right']);
  });

  it('handles mixed alignment with default', () => {
    const md = `| A | B | C | D |
| --- | :--- | :---: | ---: |
| 1 | 2 | 3 | 4 |`;
    const result = parseMarkdownTable(md);
    expect(result!.alignments).toEqual(['default', 'left', 'center', 'right']);
  });

  it('returns null for single-line input', () => {
    expect(parseMarkdownTable('| A | B |')).toBeNull();
  });

  it('returns null for invalid separator row', () => {
    const md = `| A | B |
| not a separator | here |
| 1 | 2 |`;
    expect(parseMarkdownTable(md)).toBeNull();
  });

  it('handles header-only table (no data rows)', () => {
    const md = `| A | B |
| --- | --- |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['A', 'B']);
    expect(result!.rows).toHaveLength(0);
  });

  it('handles tables without leading/trailing pipes', () => {
    const md = `A | B
--- | ---
1 | 2`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['A', 'B']);
    expect(result!.rows[0]).toEqual(['1', '2']);
  });

  it('handles empty cells', () => {
    const md = `| A | B | C |
| --- | --- | --- |
| 1 |  | 3 |
|  | 2 |  |`;
    const result = parseMarkdownTable(md);
    expect(result!.rows[0]).toEqual(['1', '', '3']);
    expect(result!.rows[1]).toEqual(['', '2', '']);
  });

  it('handles CJK content in cells', () => {
    const md = `| 姓名 | 年龄 | 城市 |
| --- | --- | --- |
| 小明 | 25 | 北京 |`;
    const result = parseMarkdownTable(md);
    expect(result!.headers).toEqual(['姓名', '年龄', '城市']);
    expect(result!.rows[0]).toEqual(['小明', '25', '北京']);
  });

  it('handles rows with fewer columns than header', () => {
    const md = `| A | B | C |
| --- | --- | --- |
| 1 |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.rows[0]).toEqual(['1']);
  });

  it('handles rows with more columns than header', () => {
    const md = `| A | B |
| --- | --- |
| 1 | 2 | 3 | 4 |`;
    const result = parseMarkdownTable(md);
    expect(result!.rows[0]).toEqual(['1', '2', '3', '4']);
  });

  it('ignores blank lines between rows', () => {
    const md = `| A | B |
| --- | --- |

| 1 | 2 |

| 3 | 4 |`;
    const result = parseMarkdownTable(md);
    expect(result!.rows).toHaveLength(2);
  });

  it('separator with long dashes is valid', () => {
    const md = `| A | B |
| ---------- | :----------: |
| 1 | 2 |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.alignments).toEqual(['default', 'center']);
  });

  it('separator with spaces around dashes is valid', () => {
    const md = `| A | B |
|  ---  |  ---  |
| 1 | 2 |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(['A', 'B']);
    expect(result!.rows[0]).toEqual(['1', '2']);
  });

  it('separator with spaces and colons is valid', () => {
    const md = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.alignments).toEqual(['left', 'center', 'right']);
  });

  it('separator with leading spaces before colon is valid', () => {
    const md = `| A | B |
|  :---  |  :---:  |
| 1 | 2 |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
    expect(result!.alignments).toEqual(['left', 'center']);
  });

  it('separator with minimal single dash is valid', () => {
    const md = `| A | B |
| - | - |
| 1 | 2 |`;
    const result = parseMarkdownTable(md);
    expect(result).not.toBeNull();
  });

  it('separator with only spaces (no dashes) is invalid', () => {
    const md = `| A | B |
|     |     |
| 1 | 2 |`;
    expect(parseMarkdownTable(md)).toBeNull();
  });
});

// ── Inline markdown rendering tests ──

describe('renderInlineMarkdown', () => {
  it('renders bold text', () => {
    expect(renderInlineMarkdown('**bold**')).toBe('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    expect(renderInlineMarkdown('*italic*')).toBe('<em>italic</em>');
  });

  it('renders strikethrough text', () => {
    expect(renderInlineMarkdown('~~struck~~')).toBe('<s>struck</s>');
  });

  it('renders inline code', () => {
    expect(renderInlineMarkdown('`code`')).toBe('<code class="cm-novelist-table-code">code</code>');
  });

  it('renders bold before italic to avoid conflict', () => {
    const result = renderInlineMarkdown('**bold** and *italic*');
    expect(result).toBe('<strong>bold</strong> and <em>italic</em>');
  });

  it('renders mixed formatting', () => {
    const result = renderInlineMarkdown('**bold** *italic* ~~struck~~ `code`');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<em>italic</em>');
    expect(result).toContain('<s>struck</s>');
    expect(result).toContain('<code class="cm-novelist-table-code">code</code>');
  });

  it('escapes HTML entities', () => {
    expect(renderInlineMarkdown('<script>')).toBe('&lt;script&gt;');
    expect(renderInlineMarkdown('a & b')).toBe('a &amp; b');
    expect(renderInlineMarkdown('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles plain text without formatting', () => {
    expect(renderInlineMarkdown('hello world')).toBe('hello world');
  });

  it('handles CJK text', () => {
    expect(renderInlineMarkdown('你好世界')).toBe('你好世界');
    expect(renderInlineMarkdown('**粗体**')).toBe('<strong>粗体</strong>');
  });

  it('handles empty string', () => {
    expect(renderInlineMarkdown('')).toBe('');
  });
});

// ── parseCells tests ──

describe('parseCells', () => {
  it('splits pipe-delimited cells', () => {
    expect(parseCells('| A | B | C |')).toEqual(['A', 'B', 'C']);
  });

  it('handles no leading pipe', () => {
    expect(parseCells('A | B | C |')).toEqual(['A', 'B', 'C']);
  });

  it('handles no trailing pipe', () => {
    expect(parseCells('| A | B | C')).toEqual(['A', 'B', 'C']);
  });

  it('handles no pipes on either end', () => {
    expect(parseCells('A | B | C')).toEqual(['A', 'B', 'C']);
  });

  it('trims whitespace', () => {
    expect(parseCells('|  A  |  B  |')).toEqual(['A', 'B']);
  });

  it('handles single cell', () => {
    expect(parseCells('| A |')).toEqual(['A']);
  });
});
