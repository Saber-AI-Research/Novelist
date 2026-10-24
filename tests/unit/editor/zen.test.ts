import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { typewriterPlugin, lineFocusPlugin } from '$lib/editor/zen';

/**
 * [precision] zen — typewriterPlugin and lineFocusPlugin are CM6
 * ViewPlugins. Their effects (scroll / dim decorations) depend on layout,
 * which is not testable under happy-dom. What IS testable and worth
 * guarding: they install cleanly (no constructor/update throws) and the
 * line-focus plugin publishes a DecorationSet via its own
 * `decorations` field.
 */

function mountWith(doc: string, ...plugins: any[]): EditorView {
  const state = EditorState.create({ doc, extensions: plugins });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

describe('[precision] typewriterPlugin', () => {
  it('is a CM6 ViewPlugin (not a bare Extension)', () => {
    expect(typewriterPlugin).toBeInstanceOf(ViewPlugin);
  });

  it('installs on an EditorView without throwing', () => {
    const view = mountWith('line one\nline two', typewriterPlugin);
    try {
      // Triggering a selection change exercises the update path — even if
      // coordsAtPos returns null in happy-dom, update must not throw.
      view.dispatch({ selection: { anchor: 3 } });
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});

describe('[precision] lineFocusPlugin', () => {
  it('is a CM6 ViewPlugin', () => {
    expect(lineFocusPlugin).toBeInstanceOf(ViewPlugin);
  });

  it('builds an initial decoration set during construction', () => {
    const view = mountWith('para a\n\npara b\n\npara c', lineFocusPlugin);
    try {
      const field = view.plugin(lineFocusPlugin);
      expect(field).toBeTruthy();
      expect(field!.decorations).toBeTruthy();
      // DecorationSet exposes an iterator — just check it's callable.
      expect(typeof field!.decorations.iter).toBe('function');
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('survives a selection-change update (different line path)', () => {
    const view = mountWith('para a\n\npara b', lineFocusPlugin);
    try {
      // Move cursor from para a to para b — should trigger rebuild.
      view.dispatch({ selection: { anchor: 10 } });
      const field = view.plugin(lineFocusPlugin);
      expect(field).toBeTruthy();
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('survives a doc-change update (viewport path)', () => {
    const view = mountWith('hello', lineFocusPlugin);
    try {
      view.dispatch({ changes: { from: 5, insert: ' world' } });
      const field = view.plugin(lineFocusPlugin);
      expect(field).toBeTruthy();
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('[regression] re-dims synchronously when the caret moves to another line', () => {
    const view = mountWith('one\ntwo\nthree', lineFocusPlugin);
    const dimmedLines = () => {
      const starts: number[] = [];
      const iter = view.plugin(lineFocusPlugin)!.decorations.iter();
      for (; iter.value; iter.next()) starts.push(view.state.doc.lineAt(iter.from).number);
      return starts;
    };
    try {
      expect(dimmedLines()).toEqual([2, 3]);
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } }); // ArrowDown
      expect(dimmedLines()).toEqual([1, 3]);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
