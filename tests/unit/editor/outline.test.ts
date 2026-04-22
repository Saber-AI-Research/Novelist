import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { extractHeadings } from '$lib/editor/outline';

/**
 * [precision] outline.extractHeadings — walks the CM6 syntax tree and
 * pulls `ATXHeading{n}` nodes into `HeadingItem[]`. Needs a real
 * EditorState with the markdown language so the tree is populated.
 */

function stateFrom(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown()] });
}

describe('[precision] extractHeadings', () => {
  it('returns an empty array for a doc with no headings', () => {
    expect(extractHeadings(stateFrom('just prose here'))).toEqual([]);
  });

  it('extracts a single H1 with trimmed text', () => {
    const result = extractHeadings(stateFrom('# Title'));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ level: 1, text: 'Title', from: 0 });
  });

  it('captures level 1..6 with correct text', () => {
    const doc = '# A\n## B\n### C\n#### D\n##### E\n###### F';
    const result = extractHeadings(stateFrom(doc));
    expect(result.map(h => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.map(h => h.text)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('records position (from) at the start of the heading line', () => {
    const doc = 'para\n\n## Heading';
    const result = extractHeadings(stateFrom(doc));
    expect(result).toHaveLength(1);
    // "para\n\n" = 6 chars before "## Heading"
    expect(result[0].from).toBe(6);
  });

  it('skips heading markers with no text (empty-text filter)', () => {
    // "##" alone is a valid ATXHeading2 but has no text — must be dropped.
    const result = extractHeadings(stateFrom('##'));
    expect(result).toEqual([]);
  });

  it('handles CJK heading text', () => {
    const result = extractHeadings(stateFrom('# 第一章 开始'));
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('第一章 开始');
  });

  it('preserves inline formatting characters in heading text', () => {
    const result = extractHeadings(stateFrom('# Hello **World**'));
    expect(result[0].text).toBe('Hello **World**');
  });

  it('returns headings in document order', () => {
    const doc = '# A\n\nbody\n\n## B\n\n### C\n\n# D';
    const froms = extractHeadings(stateFrom(doc)).map(h => h.from);
    const sorted = [...froms].sort((a, b) => a - b);
    expect(froms).toEqual(sorted);
  });
});
