import { describe, expect, it } from 'vitest';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { deleteCurrentParagraph } from '$lib/editor/delete-paragraph';
import { imeGuardPlugin } from '$lib/editor/ime-guard';

describe('[contract] delete paragraph runtime integration', () => {
  it('dispatches one focused, undoable transaction for a CJK paragraph', () => {
    const initialDoc = '第一段\n\n第二段\n\n第三段';
    const initialSelection = EditorSelection.single(initialDoc.indexOf('第二段') + 1);
    let docChangedTransactions = 0;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          markdown(),
          history(),
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      expect(deleteCurrentParagraph(view)).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('第一段\n\n第三段');
      expect(view.hasFocus).toBe(true);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('refuses deletion during IME composition and runs after composition settles', async () => {
    const initialDoc = '输入中的段落\n\n下一段';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: EditorSelection.single(2),
        extensions: [markdown(), imeGuardPlugin],
      }),
    });

    try {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(deleteCurrentParagraph(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(initialDoc);

      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(deleteCurrentParagraph(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('下一段');
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
