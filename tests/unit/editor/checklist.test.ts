import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';

/**
 * Checklist (task list) feature tests.
 *
 * Tests checkbox toggle logic and document state transitions:
 * - Toggling [ ] ↔ [x] via dispatch
 * - Cursor position after toggle
 * - Multiple checklists in a document
 * - Edge cases (nested lists, adjacent tasks)
 *
 * The actual CheckboxWidget rendering is browser-only (requires DOM).
 * These tests verify the state transitions that the widget triggers.
 */

function createState(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: cursor !== undefined ? { anchor: cursor } : undefined,
  });
}

/** Simulate what CheckboxWidget.mousedown does: replace 3 chars at `pos`. */
function toggleCheckbox(state: EditorState, pos: number): EditorState {
  const text = state.doc.sliceString(pos, pos + 3);
  const isChecked = text === '[x]';
  const newText = isChecked ? '[ ]' : '[x]';
  return state.update({
    changes: { from: pos, to: pos + 3, insert: newText },
  }).state;
}

/** Find all task marker positions in a document. */
function findTaskMarkers(doc: string): { pos: number; checked: boolean }[] {
  const markers: { pos: number; checked: boolean }[] = [];
  const pattern = /\[[ x]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(doc)) !== null) {
    // Only count markers that appear after "- " at line start
    const lineStart = doc.lastIndexOf('\n', match.index) + 1;
    const prefix = doc.slice(lineStart, match.index);
    if (/^\s*- $/.test(prefix)) {
      markers.push({ pos: match.index, checked: match[0] === '[x]' });
    }
  }
  return markers;
}

// ── Toggle logic tests ──

describe('checkbox toggle', () => {
  it('toggles unchecked to checked', () => {
    const state = createState('- [ ] Task one');
    const markers = findTaskMarkers(state.doc.toString());
    expect(markers).toHaveLength(1);
    expect(markers[0].checked).toBe(false);

    const newState = toggleCheckbox(state, markers[0].pos);
    expect(newState.doc.toString()).toBe('- [x] Task one');
  });

  it('toggles checked to unchecked', () => {
    const state = createState('- [x] Done task');
    const markers = findTaskMarkers(state.doc.toString());
    expect(markers[0].checked).toBe(true);

    const newState = toggleCheckbox(state, markers[0].pos);
    expect(newState.doc.toString()).toBe('- [ ] Done task');
  });

  it('preserves document length after toggle', () => {
    const doc = '- [ ] Task';
    const state = createState(doc);
    const newState = toggleCheckbox(state, 2);
    expect(newState.doc.length).toBe(doc.length);
  });

  it('toggles only the target checkbox in multi-task doc', () => {
    const doc = '- [ ] First\n- [x] Second\n- [ ] Third';
    const state = createState(doc);
    const markers = findTaskMarkers(doc);
    expect(markers).toHaveLength(3);

    // Toggle the second (checked → unchecked)
    const newState = toggleCheckbox(state, markers[1].pos);
    const result = newState.doc.toString();
    expect(result).toBe('- [ ] First\n- [ ] Second\n- [ ] Third');
  });

  it('toggles first checkbox without affecting others', () => {
    const doc = '- [ ] First\n- [ ] Second';
    const state = createState(doc);
    const markers = findTaskMarkers(doc);

    const newState = toggleCheckbox(state, markers[0].pos);
    expect(newState.doc.toString()).toBe('- [x] First\n- [ ] Second');
  });

  it('double toggle returns to original state', () => {
    const doc = '- [ ] Task';
    const state = createState(doc);
    const markers = findTaskMarkers(doc);
    const toggled = toggleCheckbox(state, markers[0].pos);
    const doubleToggled = toggleCheckbox(toggled, markers[0].pos);
    expect(doubleToggled.doc.toString()).toBe(doc);
  });
});

// ── Task marker detection tests ──

describe('findTaskMarkers', () => {
  it('finds unchecked marker', () => {
    const markers = findTaskMarkers('- [ ] Task');
    expect(markers).toEqual([{ pos: 2, checked: false }]);
  });

  it('finds checked marker', () => {
    const markers = findTaskMarkers('- [x] Task');
    expect(markers).toEqual([{ pos: 2, checked: true }]);
  });

  it('finds multiple markers', () => {
    const markers = findTaskMarkers('- [ ] A\n- [x] B\n- [ ] C');
    expect(markers).toHaveLength(3);
    expect(markers[0].checked).toBe(false);
    expect(markers[1].checked).toBe(true);
    expect(markers[2].checked).toBe(false);
  });

  it('ignores non-task-list brackets', () => {
    const markers = findTaskMarkers('Some [x] text in a paragraph');
    expect(markers).toHaveLength(0);
  });

  it('ignores brackets in code blocks', () => {
    // These are not preceded by "- "
    const markers = findTaskMarkers('```\n[x] not a task\n```');
    expect(markers).toHaveLength(0);
  });

  it('handles indented tasks', () => {
    const markers = findTaskMarkers('  - [ ] Indented task');
    expect(markers).toHaveLength(1);
  });

  it('handles empty document', () => {
    expect(findTaskMarkers('')).toHaveLength(0);
  });

  it('handles document with no tasks', () => {
    expect(findTaskMarkers('# Hello\n\nSome text')).toHaveLength(0);
  });
});

// ── Cursor position tests ──

describe('cursor position after toggle', () => {
  it('cursor before checkbox stays at same position', () => {
    // Cursor at start of line (pos 0), checkbox at pos 2
    const state = createState('- [ ] Task', 0);
    const newState = toggleCheckbox(state, 2);
    // Cursor should remain at 0 (before the change range)
    expect(newState.selection.main.head).toBe(0);
  });

  it('cursor after checkbox adjusts correctly', () => {
    // Cursor at end of "Task" (pos 10), checkbox toggle at pos 2
    const state = createState('- [ ] Task', 10);
    const newState = toggleCheckbox(state, 2);
    // "[x]" is same length as "[ ]", cursor stays at 10
    expect(newState.selection.main.head).toBe(10);
  });

  it('cursor inside checkbox range maps correctly', () => {
    // Cursor at pos 3 (inside "[ ]"), toggle at pos 2
    // CM6 maps cursor inside a replaced range to the start of the replacement
    const state = createState('- [ ] Task', 3);
    const newState = toggleCheckbox(state, 2);
    expect(newState.selection.main.head).toBe(2);
  });
});

// ── Integration with surrounding content ──

describe('checklist with surrounding content', () => {
  it('preserves heading above task list', () => {
    const doc = '# TODO\n\n- [ ] Item 1\n- [ ] Item 2';
    const state = createState(doc);
    const markers = findTaskMarkers(doc);
    const newState = toggleCheckbox(state, markers[0].pos);
    expect(newState.doc.toString()).toBe('# TODO\n\n- [x] Item 1\n- [ ] Item 2');
  });

  it('preserves paragraph below task list', () => {
    const doc = '- [x] Done\n\nSome text after.';
    const state = createState(doc);
    const markers = findTaskMarkers(doc);
    const newState = toggleCheckbox(state, markers[0].pos);
    expect(newState.doc.toString()).toBe('- [ ] Done\n\nSome text after.');
  });

  it('handles task with CJK content', () => {
    const doc = '- [ ] 完成第一章';
    const state = createState(doc);
    const newState = toggleCheckbox(state, 2);
    expect(newState.doc.toString()).toBe('- [x] 完成第一章');
  });
});
