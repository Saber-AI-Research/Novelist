import type { ChangeSet, Text } from '@codemirror/state';
import { countWords } from '$lib/utils/wordcount';

// A newline always ends a word, so lines can be counted independently: the
// per-line sum equals `countWords(doc.toString())` without building that string.

/** CJK-aware word count of a whole CodeMirror document. */
export function countDocWords(doc: Text): number {
  let total = 0;
  for (const lines = doc.iterLines(); !lines.next().done;) total += countWords(lines.value);
  return total;
}

/**
 * Change in word count caused by `changes` (`startDoc` → `doc`), recounting
 * only the lines the change touched. Keeps large documents' counts exact
 * without rescanning them on every edit.
 */
export function countWordDelta(startDoc: Text, doc: Text, changes: ChangeSet): number {
  let delta = 0;
  // Current group of touched lines, in the old and the new document.
  let oldFrom = 0, oldTo = -1, newFrom = 0, newTo = -1;
  const flush = () => {
    if (oldTo < 0) return;
    delta += countWords(doc.sliceString(doc.line(newFrom).from, doc.line(newTo).to))
      - countWords(startDoc.sliceString(startDoc.line(oldFrom).from, startDoc.line(oldTo).to));
  };
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const a0 = startDoc.lineAt(fromA).number;
    const a1 = startDoc.lineAt(toA).number;
    const b0 = doc.lineAt(fromB).number;
    const b1 = doc.lineAt(toB).number;
    // Two changes sharing a line must be recounted together.
    if (oldTo >= 0 && (a0 <= oldTo || b0 <= newTo)) {
      oldTo = Math.max(oldTo, a1);
      newTo = Math.max(newTo, b1);
      return;
    }
    flush();
    oldFrom = a0; oldTo = a1; newFrom = b0; newTo = b1;
  });
  flush();
  return delta;
}
