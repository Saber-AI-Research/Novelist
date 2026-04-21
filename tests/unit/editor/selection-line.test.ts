import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection, Text } from '@codemirror/state';
import { buildSelectionDecorations } from '$lib/editor/selection-line';

/**
 * Regression tests for the selection-background builder.
 *
 * The builder emits `Decoration.line` ONLY for fully-covered lines. Partial
 * ranges (first/last line of a multi-line selection, or a single-line
 * partial selection) intentionally emit no decoration — native browser
 * `::selection` paints those, which correctly fills continuation rows to
 * the container's right edge when the selected text wraps across visual
 * rows. An inline-span background (what `Decoration.mark` would produce)
 * would end at each wrapped row's last glyph and look ragged.
 */

interface DecoSummary {
  from: number;
  to: number;
  klass: string;
}

function docFrom(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

function summarize(doc: Text, selection: EditorSelection): DecoSummary[] {
  const set = buildSelectionDecorations(doc, selection);
  const out: DecoSummary[] = [];
  const cursor = set.iter();
  while (cursor.value) {
    const spec: any = (cursor.value as any).spec;
    const klass = spec?.class ?? '';
    out.push({ from: cursor.from, to: cursor.to, klass });
    cursor.next();
  }
  return out;
}

describe('[precision][regression] buildSelectionDecorations', () => {
  it('emits nothing for an empty (caret) selection', () => {
    const doc = docFrom('hello world');
    const sel = EditorSelection.single(3);
    expect(summarize(doc, sel)).toEqual([]);
  });

  it('emits nothing for a single-line partial selection (native ::selection paints it)', () => {
    //                            0123456789...
    const doc = docFrom('hello world');
    // Select "lo wo" (pos 3..8)
    const sel = EditorSelection.single(3, 8);
    expect(summarize(doc, sel)).toEqual([]);
  });

  it('uses a line decoration when the whole line text is selected', () => {
    const doc = docFrom('hello\nworld');
    const firstLine = doc.line(1); // from=0, to=5
    const sel = EditorSelection.single(firstLine.from, firstLine.to);
    const decos = summarize(doc, sel);
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 0, klass: 'cm-novelist-selected-line' });
  });

  it('emits a line decoration only for fully-covered middle lines in a multi-line partial selection', () => {
    //  line1: "abcdef" (0..6)   \n at 6
    //  line2: "ghijkl" (7..13)  \n at 13
    //  line3: "mnopqr" (14..20)
    const doc = docFrom('abcdef\nghijkl\nmnopqr');
    // Select from mid of line1 (pos 3 = 'd') to mid of line3 (pos 17 = end of 'mno')
    const sel = EditorSelection.single(3, 17);
    const decos = summarize(doc, sel);
    // line1 partial → no deco; line2 fully covered → line deco at 7; line3 partial → no deco
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 7, klass: 'cm-novelist-selected-line' });
  });

  it('paints empty middle lines with a line decoration', () => {
    //  line1: "abc"   (0..3)   \n at 3
    //  line2: ""      (4..4)   \n at 4
    //  line3: "def"   (5..8)
    const doc = docFrom('abc\n\ndef');
    const sel = EditorSelection.single(1, 6);
    const decos = summarize(doc, sel);
    // line1 partial → no deco; line2 empty full-line → line deco at 4; line3 partial → no deco
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 4, klass: 'cm-novelist-selected-line' });
  });

  it('uses line decorations when the entire document is selected', () => {
    const doc = docFrom('a\nb\nc');
    const sel = EditorSelection.single(0, doc.length);
    const decos = summarize(doc, sel);
    expect(decos).toHaveLength(3);
    expect(decos.every(d => d.klass === 'cm-novelist-selected-line')).toBe(true);
    expect(decos.map(d => d.from)).toEqual([0, 2, 4]);
  });

  it('deduplicates line decorations when multiple selection ranges hit the same line', () => {
    const doc = docFrom('hello world');
    const line = doc.line(1);
    // Two ranges both covering the whole line
    const sel = EditorSelection.create([
      EditorSelection.range(line.from, line.to),
      EditorSelection.range(line.from, line.to),
    ], 0);
    const decos = summarize(doc, sel);
    expect(decos).toHaveLength(1);
    expect(decos[0].klass).toBe('cm-novelist-selected-line');
  });

  it('handles a selection that ends at the very end of the document', () => {
    const doc = docFrom('abc\ndef');
    const sel = EditorSelection.single(2, doc.length); // from mid-line1 to end of line2
    const decos = summarize(doc, sel);
    // line1 partial → no deco; line2 fully covered (sel.to === line.to at doc end) → line deco at 4
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 4, klass: 'cm-novelist-selected-line' });
  });
});
