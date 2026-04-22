import { describe, it, expect, vi } from 'vitest';
import { EditorState, Text } from '@codemirror/state';
import { moveSection } from '$lib/editor/section-move';
import type { HeadingItem } from '$lib/editor/outline';

/**
 * [precision] moveSection — dispatches a CM6 transaction that relocates a
 * heading section. We drive it with a fake EditorView that exposes only
 * `state.doc` + a spy `dispatch`, which keeps the test focused on the
 * change-set shape produced by moveSection.
 *
 * Conventions validated:
 * - "Section" = from source heading up to the next same-or-higher heading.
 * - Moving *up* emits [insert at target, delete original] (sorted by pos).
 * - Moving *down* emits [delete original, insert at target] (sorted by pos).
 * - Section text always ends with a newline (appended if missing).
 * - Identical source/target is a no-op (no dispatch).
 * - Unknown sourceFrom is a no-op.
 */

function fakeView(doc: string) {
  const text = Text.of(doc.split('\n'));
  const state = { doc: text } as unknown as EditorState;
  const dispatch = vi.fn();
  return { state, dispatch } as any;
}

// Build headings by scanning for ^#{1,6} lines.
function headingsFor(doc: string): HeadingItem[] {
  const text = Text.of(doc.split('\n'));
  const out: HeadingItem[] = [];
  for (let i = 1; i <= text.lines; i++) {
    const line = text.line(i);
    const m = line.text.match(/^(#{1,6})\s+(.*)$/);
    if (m) out.push({ level: m[1].length, text: m[2], from: line.from });
  }
  return out;
}

describe('[precision] moveSection', () => {
  it('is a no-op when sourceFrom === targetFrom', () => {
    const view = fakeView('# A\n# B\n');
    const hs = headingsFor('# A\n# B\n');
    moveSection(view, hs, hs[0].from, hs[0].from);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('is a no-op when sourceFrom is not in headings', () => {
    const view = fakeView('# A\n# B\n');
    const hs = headingsFor('# A\n# B\n');
    moveSection(view, hs, 9999, hs[0].from);
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it('moves a section UP by inserting at target before deleting original', () => {
    const doc = '# A\nbody-a\n# B\nbody-b\n';
    const view = fakeView(doc);
    const hs = headingsFor(doc);
    // hs = [A@0, B@11]. Move B before A.
    moveSection(view, hs, hs[1].from, hs[0].from);

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes).toHaveLength(2);
    // Order: insert at target (pos 0) first, then delete original (pos 11..end).
    expect(changes[0]).toEqual({ from: 0, insert: '# B\nbody-b\n' });
    expect(changes[1]).toEqual({ from: 11, to: 22 });
  });

  it('moves a section DOWN by deleting original before inserting at target', () => {
    const doc = '# A\nbody-a\n# B\nbody-b\n';
    const view = fakeView(doc);
    const hs = headingsFor(doc);
    // Move A below B — pick a target past B's range: pos 22 (end).
    moveSection(view, hs, hs[0].from, 22);

    expect(view.dispatch).toHaveBeenCalledTimes(1);
    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes).toHaveLength(2);
    // Order: delete original (pos 0..11) first, then insert at target (pos 22).
    expect(changes[0]).toEqual({ from: 0, to: 11 });
    expect(changes[1]).toEqual({ from: 22, insert: '# A\nbody-a\n' });
  });

  it('appends a trailing newline when the section text lacks one', () => {
    const doc = '# A\nbody-a\n# Last';   // no trailing \n after last section
    const view = fakeView(doc);
    const hs = headingsFor(doc);
    // Move Last to before A.
    moveSection(view, hs, hs[1].from, hs[0].from);

    const { changes } = view.dispatch.mock.calls[0][0];
    expect(changes[0].insert).toBe('# Last\n');
  });

  it('extends the section through deeper children until next same-or-higher heading', () => {
    // A (1) -> B (2) -> C (2) — moving A should include both H2 subsections.
    const doc = '# A\n## B\nb-body\n## C\nc-body\n# D\n';
    const view = fakeView(doc);
    const hs = headingsFor(doc);
    // Move A below D (beyond end).
    moveSection(view, hs, hs[0].from, doc.length);
    const { changes } = view.dispatch.mock.calls[0][0];
    // Section = everything from A (0) until D's start.
    const dStart = hs[hs.length - 1].from;
    expect(changes[0]).toEqual({ from: 0, to: dStart });
    expect(changes[1].insert).toBe(doc.slice(0, dStart));
  });
});
