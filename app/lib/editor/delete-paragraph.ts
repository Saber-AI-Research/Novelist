import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isImeComposing } from './ime-guard';

interface DeleteRange {
  from: number;
  to: number;
}

/**
 * Build one transaction that removes every Markdown paragraph touched by the
 * current selection. A cursor removes its enclosing Paragraph syntax node;
 * syntax-free modes and non-paragraph blocks fall back to the current logical
 * line. One adjacent separator is absorbed so the surrounding document keeps
 * its existing paragraph spacing without leaving an orphan blank line.
 */
export function deleteParagraphSpec(state: EditorState): TransactionSpec | null {
  if (state.readOnly || state.doc.length === 0) return null;

  const ranges = state.selection.ranges.map(range => {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const lastPos = range.empty ? from : Math.max(from, to - 1);
    const firstBlock = paragraphOrLineRange(state, from);
    const lastBlock = paragraphOrLineRange(state, lastPos);
    return absorbSeparator(state, {
      from: Math.min(firstBlock.from, lastBlock.from),
      to: Math.max(firstBlock.to, lastBlock.to),
    });
  });
  const changes = mergeRanges(ranges);
  if (changes.length === 0) return null;

  const changeDesc = state.changes(changes.map(range => ({ ...range, insert: '' })));
  const cursor = changeDesc.mapPos(changes[0].from, -1);
  return {
    changes: changes.map(range => ({ ...range, insert: '' })),
    selection: EditorSelection.cursor(cursor),
    userEvent: 'delete',
  };
}

export function deleteCurrentParagraph(view: EditorView): boolean {
  if (isImeComposing(view)) return false;
  const spec = deleteParagraphSpec(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  view.focus();
  return true;
}

function paragraphOrLineRange(state: EditorState, pos: number): DeleteRange {
  const line = state.doc.lineAt(pos);
  if (line.text.trim() === '') return { from: line.from, to: line.to };

  const bias = pos === line.from ? 1 : -1;
  let node = syntaxTree(state).resolveInner(pos, bias);
  while (node.parent && node.name !== 'Paragraph') node = node.parent;
  if (node.name === 'Paragraph') {
    return {
      from: state.doc.lineAt(node.from).from,
      to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to,
    };
  }
  return { from: line.from, to: line.to };
}

function absorbSeparator(state: EditorState, range: DeleteRange): DeleteRange {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);

  if (last.number < state.doc.lines) {
    let nextNumber = last.number + 1;
    while (nextNumber <= state.doc.lines && state.doc.line(nextNumber).text.trim() === '') {
      nextNumber += 1;
    }
    return {
      from: range.from,
      to: nextNumber <= state.doc.lines ? state.doc.line(nextNumber).from : state.doc.length,
    };
  }

  if (first.number > 1) {
    let previousNumber = first.number - 1;
    while (previousNumber > 1 && state.doc.line(previousNumber).text.trim() === '') {
      previousNumber -= 1;
    }
    return { from: state.doc.line(previousNumber).to, to: range.to };
  }
  return range;
}

function mergeRanges(ranges: DeleteRange[]): DeleteRange[] {
  const sorted = ranges
    .filter(range => range.to > range.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: DeleteRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}
