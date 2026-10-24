import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { EditorSelection, Range, Text } from '@codemirror/state';

const selectedLineDeco = Decoration.line({ class: 'cm-novelist-selected-line' });

/**
 * Paints backgrounds for non-empty selections.
 *
 * Hybrid strategy:
 * - **Fully-covered lines** (middle of a multi-line selection, empty lines
 *   inside the range, or a line whose entire text span is selected) →
 *   `Decoration.line` paints a uniform full-line background
 *   (`.cm-novelist-selected-line`).
 * - **Partially-covered lines** (the first / last line of a multi-line
 *   selection when the caret stops mid-line, or a single-line selection
 *   that doesn't span the whole line) → we emit NO decoration and let the
 *   browser's native `::selection` paint the text run. Native selection is
 *   rendered by the text engine, so for a partial selection that wraps,
 *   each continuation visual row correctly fills to the container's right
 *   edge, while an inline-span background (what `Decoration.mark` would
 *   produce) would end at each wrapped row's last glyph — creating a
 *   ragged per-word highlight on wrapped lines.
 *
 * To prevent `::selection` from stacking on top of `.cm-novelist-selected-line`
 * (which would double the tint on fully-covered lines that contain text),
 * the theme suppresses `::selection` inside that class.
 *
 * Why not use CM6's native `drawSelection` rects: those are painted in two
 * different coordinate frames (first-line vs middle-line), causing a
 * stair-step on heading lines — see `selection-geometry.spec.ts`. Line
 * decorations sit on `.cm-line` and share its left padding, so full-line
 * backgrounds align uniformly regardless of heading level.
 */
/**
 * Pure builder — exported for unit testing. Takes the document and a
 * selection directly instead of an `EditorView`, so tests can assert the
 * decoration set without booting CM6. Only lines inside `visibleRanges` are
 * decorated, so the cost follows the viewport, not the selection size
 * (Cmd+A on a huge file).
 */
export function buildSelectionDecorations(
  doc: Text,
  selection: EditorSelection,
  visibleRanges: readonly { from: number; to: number }[] = [{ from: 0, to: doc.length }],
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const seenLines = new Set<number>();

  for (const sel of selection.ranges) {
    if (sel.empty) continue;
    for (const visible of visibleRanges) {
      const from = Math.max(sel.from, visible.from);
      const to = Math.min(sel.to, visible.to);
      if (from > to) continue;
      const lastLine = doc.lineAt(to).number;
      for (let n = doc.lineAt(from).number; n <= lastLine; n++) {
        const line = doc.line(n);
        const coversFromLeft = sel.from <= line.from;
        const coversToRight = sel.to >= line.to;

        if (coversFromLeft && coversToRight) {
          if (seenLines.has(n)) continue;
          seenLines.add(n);
          ranges.push(selectedLineDeco.range(line.from));
        }
        // Partial coverage: deliberately no decoration — native `::selection`
        // handles wrap-aware painting of the selected text run.
      }
    }
  }

  return Decoration.set(ranges, true);
}

export const unifiedLineSelectionPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildSelectionDecorations(view.state.doc, view.state.selection, view.visibleRanges);
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged || update.viewportChanged) {
        const { state, visibleRanges } = update.view;
        this.decorations = buildSelectionDecorations(state.doc, state.selection, visibleRanges);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
