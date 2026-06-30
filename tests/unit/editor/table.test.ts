import { describe, it, expect } from 'vitest';
import {
  parseCells,
  parseMarkdownTable,
  renderInlineMarkdown,
  cellDomToMarkdown,
  serializeTable,
  insertRow,
  deleteRow,
  insertColumn,
  deleteColumn,
  setAlignment,
  type ParsedTable,
} from '../../../app/lib/editor/table';

/**
 * Table feature tests.
 *
 * Covers the pure logic in table.ts:
 * - GFM table parsing (headers, alignment, rows, `\|` escapes)
 * - Inline markdown → HTML rendering in cells
 * - DOM → markdown serialization of edited cells
 * - Compact source serialization + structural model mutations
 *
 * The interactive CodeMirror widget (contenteditable cells, toolbars,
 * commit-on-blur) is browser-only and covered by E2E tests
 * (tests/e2e/specs/table-edit.spec.ts).
 */

// ── Table parsing ──

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
    expect(result!.alignments).toEqual(['left', 'center', 'right']);
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
    expect(result!.headers).toEqual(['A', 'B']);
    expect(result!.rows).toHaveLength(0);
  });

  it('handles CJK content in cells', () => {
    const md = `| 姓名 | 年龄 | 城市 |
| --- | --- | --- |
| 小明 | 25 | 北京 |`;
    const result = parseMarkdownTable(md);
    expect(result!.headers).toEqual(['姓名', '年龄', '城市']);
    expect(result!.rows[0]).toEqual(['小明', '25', '北京']);
  });

  it('keeps escaped pipes (\\|) inside a single cell', () => {
    const md = `| A | B |
| --- | --- |
| a \\| b | c |`;
    const result = parseMarkdownTable(md);
    expect(result!.rows[0]).toEqual(['a \\| b', 'c']);
  });
});

// ── parseCells ──

describe('parseCells', () => {
  it('splits pipe-delimited cells and trims', () => {
    expect(parseCells('|  A  |  B  | C |')).toEqual(['A', 'B', 'C']);
  });

  it('does not split on an escaped pipe', () => {
    expect(parseCells('| a \\| b | c |')).toEqual(['a \\| b', 'c']);
  });
});

// ── Inline markdown rendering ──

describe('renderInlineMarkdown', () => {
  it('renders bold/italic/strike/code', () => {
    expect(renderInlineMarkdown('**b** *i* ~~s~~ `c`')).toBe(
      '<strong>b</strong> <em>i</em> <s>s</s> <code class="cm-novelist-table-code">c</code>'
    );
  });

  it('escapes HTML entities', () => {
    expect(renderInlineMarkdown('<script>')).toBe('&lt;script&gt;');
  });

  it('unescapes \\| to a literal pipe for display', () => {
    expect(renderInlineMarkdown('a \\| b')).toBe('a | b');
  });

  it('handles CJK text', () => {
    expect(renderInlineMarkdown('**粗体**')).toBe('<strong>粗体</strong>');
  });
});

// ── DOM → markdown serialization ──

function cell(html: string): HTMLElement {
  const el = document.createElement('td');
  el.innerHTML = html;
  return el;
}

describe('cellDomToMarkdown', () => {
  it('serializes plain text', () => {
    expect(cellDomToMarkdown(cell('hello world'))).toBe('hello world');
  });

  it('serializes bold/italic/strike/code back to markdown', () => {
    expect(cellDomToMarkdown(cell('<strong>b</strong>'))).toBe('**b**');
    expect(cellDomToMarkdown(cell('<em>i</em>'))).toBe('*i*');
    expect(cellDomToMarkdown(cell('<s>s</s>'))).toBe('~~s~~');
    expect(cellDomToMarkdown(cell('<code>c</code>'))).toBe('`c`');
  });

  it('handles <b>/<i>/<del> aliases', () => {
    expect(cellDomToMarkdown(cell('<b>x</b> <i>y</i> <del>z</del>'))).toBe('**x** *y* ~~z~~');
  });

  it('escapes literal pipe characters', () => {
    expect(cellDomToMarkdown(cell('a | b'))).toBe('a \\| b');
  });

  it('collapses <br> and newlines into spaces', () => {
    expect(cellDomToMarkdown(cell('a<br>b'))).toBe('a b');
  });

  it('drops unknown wrapper tags but keeps their text', () => {
    expect(cellDomToMarkdown(cell('<span style="color:red">kept</span>'))).toBe('kept');
  });

  it('round-trips CJK with formatting', () => {
    expect(cellDomToMarkdown(cell('<strong>粗体</strong>文本'))).toBe('**粗体**文本');
  });
});

// ── Compact serialization ──

describe('serializeTable', () => {
  const base: ParsedTable = {
    headers: ['A', 'B'],
    alignments: ['default', 'default'],
    rows: [['1', '2'], ['3', '4']],
  };

  it('emits compact single-space-padded GFM', () => {
    expect(serializeTable(base)).toBe(
      `| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |`
    );
  });

  it('emits alignment tokens in the separator row', () => {
    const t: ParsedTable = { ...base, alignments: ['left', 'center'] };
    expect(serializeTable(t)).toContain('| :--- | :---: |');
  });

  it('pads short rows to the header column count', () => {
    const t: ParsedTable = { ...base, rows: [['1']] };
    expect(serializeTable(t)).toBe(`| A | B |\n| --- | --- |\n| 1 |  |`);
  });

  it('round-trips parse → serialize for a default table', () => {
    const src = `| A | B |\n| --- | --- |\n| 1 | 2 |`;
    expect(serializeTable(parseMarkdownTable(src)!)).toBe(src);
  });
});

// ── Structural model mutations ──

const grid: ParsedTable = {
  headers: ['A', 'B'],
  alignments: ['default', 'default'],
  rows: [['1', '2'], ['3', '4']],
};

describe('insertRow / deleteRow', () => {
  it('inserts an empty row at an index', () => {
    const t = insertRow(grid, 1);
    expect(t.rows).toEqual([['1', '2'], ['', ''], ['3', '4']]);
  });

  it('appends when index is at the end', () => {
    const t = insertRow(grid, grid.rows.length);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[2]).toEqual(['', '']);
  });

  it('deletes a row', () => {
    const t = deleteRow(grid, 0);
    expect(t.rows).toEqual([['3', '4']]);
  });

  it('ignores out-of-range deletes', () => {
    expect(deleteRow(grid, 9).rows).toEqual(grid.rows);
  });
});

describe('insertColumn / deleteColumn', () => {
  it('inserts an empty column with default alignment', () => {
    const t = insertColumn(grid, 1);
    expect(t.headers).toEqual(['A', '', 'B']);
    expect(t.alignments).toEqual(['default', 'default', 'default']);
    expect(t.rows[0]).toEqual(['1', '', '2']);
  });

  it('deletes a column across header/alignments/rows', () => {
    const t = deleteColumn(grid, 0);
    expect(t.headers).toEqual(['B']);
    expect(t.rows).toEqual([['2'], ['4']]);
  });

  it('refuses to delete the last remaining column', () => {
    const one: ParsedTable = { headers: ['A'], alignments: ['default'], rows: [['1']] };
    expect(deleteColumn(one, 0)).toEqual(one);
  });
});

describe('setAlignment', () => {
  it('sets a column alignment', () => {
    expect(setAlignment(grid, 1, 'right').alignments).toEqual(['default', 'right']);
  });

  it('ignores out-of-range columns', () => {
    expect(setAlignment(grid, 5, 'center').alignments).toEqual(grid.alignments);
  });
});
