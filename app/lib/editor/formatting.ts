import type { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

/** Wrap the current selection with `before` and `after`. */
export function wrapSelection(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selectedText = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selectedText + after },
    selection: { anchor: from + before.length, head: to + before.length },
  });
}

/**
 * Markdown inline markers → the lezer node type they produce, and the mark-node
 * type of the delimiter children. Used by `toggleWrap` to detect "cursor inside
 * a bold/italic/… run" and strip the outer markers.
 */
const MARKER_TO_NODE: Record<string, { node: string; mark: string }> = {
  '**': { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  '*':  { node: 'Emphasis',       mark: 'EmphasisMark' },
  '__': { node: 'StrongEmphasis', mark: 'EmphasisMark' },
  '_':  { node: 'Emphasis',       mark: 'EmphasisMark' },
  '~~': { node: 'Strikethrough',  mark: 'StrikethroughMark' },
  '`':  { node: 'InlineCode',     mark: 'CodeMark' },
  '==': { node: 'Highlight',      mark: 'HighlightMark' },
};

/**
 * Toggle-wrap: if the selection (or cursor position) is already wrapped by
 * `marker`, strip the markers. Otherwise wrap like `wrapSelection`.
 *
 * Detection order:
 *  1. Selection literally includes the markers at its boundaries.
 *  2. Markers immediately surround the selection in the document.
 *  3. The cursor sits anywhere inside an inline node produced by `marker`
 *     (e.g. caret inside `**姓名**`). We walk the syntax tree up from the
 *     cursor, find the matching node, and strip its delimiter children.
 *     This is what makes Cmd-B inside a bolded word toggle it off.
 *
 * For italic (`*`), refuses to strip via raw-string matching when the
 * adjacent characters would make the match part of a `**bold**` run.
 */
export function toggleWrap(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const len = marker.length;
  const isSingleStar = marker === '*';

  // Case 1: selection itself includes the markers — strip them.
  const selectedText = view.state.sliceDoc(from, to);
  if (
    selectedText.length >= len * 2 &&
    selectedText.startsWith(marker) &&
    selectedText.endsWith(marker) &&
    (!isSingleStar || (!selectedText.startsWith('**') && !selectedText.endsWith('**')))
  ) {
    const inner = selectedText.slice(len, selectedText.length - len);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    return;
  }

  // Case 2: markers immediately surround the selection in the document.
  const outerStart = from - len;
  const outerEnd = to + len;
  if (
    outerStart >= 0 &&
    outerEnd <= doc.length &&
    doc.sliceString(outerStart, from) === marker &&
    doc.sliceString(to, outerEnd) === marker &&
    (!isSingleStar ||
      (doc.sliceString(Math.max(0, outerStart - 1), outerStart) !== '*' &&
       doc.sliceString(outerEnd, Math.min(doc.length, outerEnd + 1)) !== '*'))
  ) {
    view.dispatch({
      changes: [
        { from: outerStart, to: from, insert: '' },
        { from: to, to: outerEnd, insert: '' },
      ],
      selection: { anchor: outerStart, head: outerStart + (to - from) },
    });
    return;
  }

  // Case 3: cursor / selection lies inside an inline node of this marker type.
  // Walk up the syntax tree from the cursor until we find a matching node,
  // then strip its delimiter children and keep the caret on the same text.
  const meta = MARKER_TO_NODE[marker];
  if (meta) {
    const tree = syntaxTree(view.state);
    let node = tree.resolveInner(from, -1);
    // resolveInner with side=-1 finds the node ending at `from`; try both sides
    // so a caret touching either end of the run still matches.
    if (node.name !== meta.node) {
      const alt = tree.resolveInner(from, 1);
      if (alt.name === meta.node) node = alt;
    }
    while (node.parent && node.name !== meta.node) node = node.parent;

    if (node.name === meta.node && node.from < node.to && to <= node.to) {
      const markerRanges: { from: number; to: number }[] = [];
      const cursor = node.cursor();
      if (cursor.firstChild()) {
        do {
          if (cursor.name === meta.mark && cursor.from < cursor.to) {
            markerRanges.push({ from: cursor.from, to: cursor.to });
          }
        } while (cursor.nextSibling());
      }
      if (markerRanges.length >= 2) {
        const first = markerRanges[0];
        const last = markerRanges[markerRanges.length - 1];
        const removedBefore = first.to - first.from;
        const newFrom = Math.max(first.to, from) - removedBefore;
        const newTo = Math.max(first.to, to) - removedBefore;
        view.dispatch({
          changes: [
            { from: first.from, to: first.to, insert: '' },
            { from: last.from, to: last.to, insert: '' },
          ],
          selection: { anchor: newFrom, head: newTo },
        });
        return;
      }
    }
  }

  // Default: wrap.
  view.dispatch({
    changes: { from, to, insert: marker + selectedText + marker },
    selection: { anchor: from + len, head: to + len },
  });
}

/**
 * Add or remove a line prefix (e.g. `#` for heading, `>` for blockquote).
 * When adding, strips any existing `#…` heading prefix first.
 */
export function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;
  if (text.startsWith(prefix + ' ')) {
    view.dispatch({
      changes: { from: line.from, to: line.from + prefix.length + 1, insert: '' },
      selection: { anchor: from - (prefix.length + 1), head: Math.max(line.from, to - (prefix.length + 1)) },
    });
  } else {
    const existingMatch = text.match(/^(#{1,6})\s*/);
    const removeLen = existingMatch ? existingMatch[0].length : 0;
    view.dispatch({
      changes: { from: line.from, to: line.from + removeLen, insert: prefix + ' ' },
      selection: { anchor: from + (prefix.length + 1 - removeLen), head: Math.max(line.from, to + (prefix.length + 1 - removeLen)) },
    });
  }
}
