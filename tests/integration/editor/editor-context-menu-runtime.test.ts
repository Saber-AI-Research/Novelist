import { describe, expect, it, vi } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { createEditorContextMenu } from '$lib/composables/editor-context-menu.svelte';

describe('[regression] editor context-menu Cut runtime', () => {
  it('keeps Cut separate from an immediately preceding adjacent history event', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '序章\n草稿\n尾声',
        extensions: [history()],
      }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const focus = vi.spyOn(view, 'focus').mockImplementation(() => {});

    try {
      const beforeCut = '序章\n你好，world\n尾声';
      const capturedSelection = EditorSelection.single(3, 11);
      view.dispatch({
        changes: { from: 3, to: 5, insert: '你好，world' },
        selection: capturedSelection,
      });
      expect(undoDepth(view.state)).toBe(1);

      const menu = createEditorContextMenu(() => view);
      menu.state = { x: 0, y: 0, hasSelection: true, from: 3, to: 11 };
      await menu.cut();

      expect(writeText).toHaveBeenCalledWith('你好，world');
      expect(focus).toHaveBeenCalledOnce();
      expect(view.state.doc.toString()).toBe('序章\n\n尾声');
      expect(undoDepth(view.state)).toBe(2);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(beforeCut);
      expect(view.state.selection.eq(capturedSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
