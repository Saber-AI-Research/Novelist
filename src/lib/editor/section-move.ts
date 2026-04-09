import type { EditorView } from '@codemirror/view';
import type { HeadingItem } from './outline';

/**
 * Move a section (from one heading to the next same-or-higher-level heading)
 * to before another heading position. Dispatches as a single CM6 transaction
 * so the entire operation is atomic and undoable with a single Ctrl+Z.
 */
export function moveSection(
  view: EditorView,
  headings: HeadingItem[],
  sourceFrom: number,
  targetFrom: number
): void {
  if (sourceFrom === targetFrom) return;

  const sourceIdx = headings.findIndex(h => h.from === sourceFrom);
  if (sourceIdx === -1) return;

  const sourceLevel = headings[sourceIdx].level;

  // Find end of source section: next heading at same or higher (lower number) level
  let sourceEndIdx = headings.length;
  for (let i = sourceIdx + 1; i < headings.length; i++) {
    if (headings[i].level <= sourceLevel) {
      sourceEndIdx = i;
      break;
    }
  }

  const doc = view.state.doc;
  const sectionStart = headings[sourceIdx].from;
  const sectionEnd = sourceEndIdx < headings.length
    ? headings[sourceEndIdx].from
    : doc.length;

  // Extract the section text, ensuring it ends with a newline
  let sectionText = doc.sliceString(sectionStart, sectionEnd);
  if (sectionText.length > 0 && !sectionText.endsWith('\n')) {
    sectionText += '\n';
  }

  // CM6 requires changes to be non-overlapping and sorted by position.
  // Both cases below satisfy this since source and target don't overlap.
  if (targetFrom < sectionStart) {
    // Moving up: insert at target pos, then delete original (which is further in the doc)
    view.dispatch({
      changes: [
        { from: targetFrom, insert: sectionText },
        { from: sectionStart, to: sectionEnd }
      ]
    });
  } else {
    // Moving down: delete original first (earlier pos), then insert at target
    view.dispatch({
      changes: [
        { from: sectionStart, to: sectionEnd },
        { from: targetFrom, insert: sectionText }
      ]
    });
  }
}
