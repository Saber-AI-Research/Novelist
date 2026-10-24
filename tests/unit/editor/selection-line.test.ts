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

function summarize(doc: Text, selection: EditorSelection, visible?: { from: number; to: number }[]): DecoSummary[] {
  const set = buildSelectionDecorations(doc, selection, visible);
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

  it('treats a selection starting at line.from but ending mid-line as partial (no deco)', () => {
    //  line1: "abcdef" (0..6)
    const doc = docFrom('abcdef');
    const sel = EditorSelection.single(0, 3); // from line start to mid-line
    // Partial on the ONLY line — coversFromLeft=true, coversToRight=false.
    expect(summarize(doc, sel)).toEqual([]);
  });

  it('treats a selection starting mid-line but ending at line.to as partial (no deco)', () => {
    const doc = docFrom('abcdef');
    const sel = EditorSelection.single(3, 6); // mid-line to line end
    expect(summarize(doc, sel)).toEqual([]);
  });

  it('emits a line deco when a newline-only line is fully covered between two partial lines', () => {
    //  line1: "abc"   (0..3)   \n at 3
    //  line2: ""      (4..4)   \n at 4
    //  line3: ""      (5..5)   \n at 5
    //  line4: "def"   (6..9)
    const doc = docFrom('abc\n\n\ndef');
    const sel = EditorSelection.single(1, 7); // mid-line1 → mid-line4
    const decos = summarize(doc, sel);
    // line1 partial → no deco; line2 full empty → line deco at 4;
    // line3 full empty → line deco at 5; line4 partial → no deco.
    expect(decos).toHaveLength(2);
    expect(decos.map(d => d.from)).toEqual([4, 5]);
    expect(decos.every(d => d.klass === 'cm-novelist-selected-line')).toBe(true);
  });

  it('never emits a Decoration.mark (partial ranges go through native ::selection)', () => {
    // A range of inputs that would have produced mark decorations under
    // the previous implementation — assert none of them produce any deco
    // other than `cm-novelist-selected-line`.
    const doc = docFrom('hello world\nsecond line here\nthird line here too\n');
    const cases = [
      EditorSelection.single(2, 8),                        // mid-mid single line
      EditorSelection.single(0, 5),                        // line-start → mid single line
      EditorSelection.single(6, doc.line(1).to),           // mid → line-end single line
      EditorSelection.single(2, 20),                       // multi-line partial→partial
      EditorSelection.single(doc.line(1).from, 20),        // full line → partial
    ];
    for (const sel of cases) {
      const decos = summarize(doc, sel);
      for (const d of decos) {
        expect(d.klass).toBe('cm-novelist-selected-line');
      }
    }
  });

  it('combines line decos and partials correctly across multiple disjoint ranges', () => {
    //  line1: "aaaa"   (0..4)   \n at 4
    //  line2: "bbbb"   (5..9)   \n at 9
    //  line3: "cccc"   (10..14)
    const doc = docFrom('aaaa\nbbbb\ncccc');
    const sel = EditorSelection.create([
      EditorSelection.range(0, 4),    // whole line1 → line deco at 0
      EditorSelection.range(6, 8),    // mid-line2 partial → no deco
      EditorSelection.range(10, 14),  // whole line3 → line deco at 10
    ], 0);
    const decos = summarize(doc, sel);
    expect(decos).toHaveLength(2);
    expect(decos.map(d => d.from).sort((a, b) => a - b)).toEqual([0, 10]);
  });

  it('does not emit a line deco for a selection that is empty after collapsing', () => {
    // Two caret ranges — both `sel.empty === true`.
    const doc = docFrom('abc\ndef');
    const sel = EditorSelection.create(
      [EditorSelection.cursor(1), EditorSelection.cursor(5)],
      0,
    );
    expect(summarize(doc, sel)).toEqual([]);
  });

  it('covers a single-line document with one line deco when fully selected', () => {
    // Single line with no trailing newline — verify line.to boundary logic.
    const doc = docFrom('only line');
    const sel = EditorSelection.single(0, doc.length);
    const decos = summarize(doc, sel);
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ from: 0, klass: 'cm-novelist-selected-line' });
  });

  it('[regression] decorates only lines inside the visible ranges (Cmd+A on a huge file)', () => {
    const doc = docFrom(Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join('\n'));
    const visibleFrom = doc.line(5000).from;
    const visibleTo = doc.line(5009).to;
    const decos = summarize(doc, EditorSelection.single(0, doc.length), [{ from: visibleFrom, to: visibleTo }]);
    expect(decos.map((d) => d.from)).toEqual(
      Array.from({ length: 10 }, (_, i) => doc.line(5000 + i).from),
    );
  });

  it('still judges coverage against the whole selection when it starts off screen', () => {
    const doc = docFrom('aaa\nbbb\nccc\nddd');
    // Selection from mid-line 1 to mid-line 4; only lines 2-3 are visible.
    const decos = summarize(doc, EditorSelection.single(1, doc.line(4).from + 1), [
      { from: doc.line(2).from, to: doc.line(3).to },
    ]);
    expect(decos.map((d) => d.from)).toEqual([doc.line(2).from, doc.line(3).from]);
  });
});
