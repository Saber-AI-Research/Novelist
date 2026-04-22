import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { typewriterPlugin, paragraphFocusPlugin } from '$lib/editor/zen';

/**
 * [precision] zen — typewriterPlugin and paragraphFocusPlugin are CM6
 * ViewPlugins. Their effects (scroll / dim decorations) depend on layout,
 * which is not testable under happy-dom. What IS testable and worth
 * guarding: they install cleanly (no constructor/update throws) and the
 * paragraph-focus plugin publishes a DecorationSet via its own
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

describe('[precision] paragraphFocusPlugin', () => {
  it('is a CM6 ViewPlugin', () => {
    expect(paragraphFocusPlugin).toBeInstanceOf(ViewPlugin);
  });

  it('builds an initial decoration set during construction', () => {
    const view = mountWith('para a\n\npara b\n\npara c', paragraphFocusPlugin);
    try {
      const field = view.plugin(paragraphFocusPlugin);
      expect(field).toBeTruthy();
      expect(field!.decorations).toBeTruthy();
      // DecorationSet exposes an iterator — just check it's callable.
      expect(typeof field!.decorations.iter).toBe('function');
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('survives a selection-change update (different paragraph path)', () => {
    const view = mountWith('para a\n\npara b', paragraphFocusPlugin);
    try {
      // Move cursor from para a to para b — should trigger rebuild.
      view.dispatch({ selection: { anchor: 10 } });
      const field = view.plugin(paragraphFocusPlugin);
      expect(field).toBeTruthy();
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('survives a doc-change update (viewport path)', () => {
    const view = mountWith('hello', paragraphFocusPlugin);
    try {
      view.dispatch({ changes: { from: 5, insert: ' world' } });
      const field = view.plugin(paragraphFocusPlugin);
      expect(field).toBeTruthy();
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
