import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { applyBlockTransform } from '$lib/editor/block-transform';
import { imeGuardPlugin } from '$lib/editor/ime-guard';

async function waitForImeGuardSettle() {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('[contract] block transform runtime integration', () => {
  it('normalizes a mixed CJK paragraph, quote, and task to one quote level with exact one-step undo', () => {
    let docChangedTransactions = 0;
    const initialDoc = '第一段\n> 第二段\n- [x] 第三段';
    const initialSelection = EditorSelection.single(1, initialDoc.length - 1);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          history(),
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      expect(applyBlockTransform(view, 'quote')).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('> 第一段\n> 第二段\n> 第三段');
      expect(view.state.doc.toString().split('\n').every(line => /^> (?!>)/.test(line))).toBe(true);
      expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(1);
      expect(view.state.doc.lineAt(view.state.selection.main.to).number).toBe(3);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('expands a partial selection across a blank line and round-trips unordered list to paragraph', () => {
    const initialDoc = 'alpha\n\nbravo';
    const initialSelection = EditorSelection.single(2, initialDoc.length - 1);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
      }),
    });

    try {
      expect(applyBlockTransform(view, 'unordered-list')).toBe(true);
      expect(view.state.doc.toString()).toBe('- alpha\n\n- bravo');
      expect(view.state.doc.toString().split('\n').filter(line => line === '')).toHaveLength(1);

      expect(applyBlockTransform(view, 'paragraph')).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.doc.toString().split('\n').filter(line => line === '')).toHaveLength(1);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('dispatches one undoable transaction and restores source plus selection', () => {
    let docChangedTransactions = 0;
    const initialDoc = 'alpha\nbravo\ncharlie';
    const initialSelection = EditorSelection.single(2, 9);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          history(),
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      expect(applyBlockTransform(view, 'unordered-list')).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('- alpha\n- bravo\ncharlie');
      expect(view.state.selection.main.from).toBe(4);
      expect(view.state.selection.main.to).toBe(13);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('preserves mixed task markers, check state, indentation, and partial CJK selection through one undo', () => {
    let docChangedTransactions = 0;
    const initialDoc = '前言\n  * [x] 完成章节\n- [ ] 待办章节\n* 普通条目\n结尾';
    const selectionFrom = initialDoc.indexOf('成章');
    const selectionTo = initialDoc.indexOf('通条') + '通条'.length;
    const initialSelection = EditorSelection.single(selectionFrom, selectionTo);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          history(),
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      expect(applyBlockTransform(view, 'task-list')).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('前言\n  * [x] 完成章节\n- [ ] 待办章节\n* [ ] 普通条目\n结尾');
      expect(view.state.selection.main.from).toBe(selectionFrom);
      expect(view.state.selection.main.to).toBe(selectionTo + 4);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('unwraps code fences with one undo restoring all ranges and mainIndex', () => {
    let docChangedTransactions = 0;
    const initialDoc = '```ts\nalpha\nbravo\n```\nplain';
    const initialSelection = EditorSelection.create([
      EditorSelection.range(initialDoc.indexOf('lpha'), initialDoc.indexOf('lpha') + 2),
      EditorSelection.range(initialDoc.indexOf('avo') + 2, initialDoc.indexOf('avo')),
    ], 1);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          history(),
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      expect(applyBlockTransform(view, 'code-fence')).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('alpha\nbravo\nplain');
      expect(view.state.selection.mainIndex).toBe(1);
      expect(view.state.selection.ranges.map(range => [range.anchor, range.head])).toEqual([
        [1, 3],
        [10, 8],
      ]);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });

  it('refuses to dispatch while IME composition is active, then runs after composition ends', async () => {
    let docChangedTransactions = 0;
    const initialDoc = 'alpha';
    const initialSelection = EditorSelection.single(1, 4);
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initialDoc,
        selection: initialSelection,
        extensions: [
          imeGuardPlugin,
          EditorView.updateListener.of(update => {
            if (update.docChanged) docChangedTransactions += 1;
          }),
        ],
      }),
    });

    try {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

      expect(applyBlockTransform(view, 'quote')).toBe(false);
      expect(docChangedTransactions).toBe(0);
      expect(view.state.doc.toString()).toBe(initialDoc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);

      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await waitForImeGuardSettle();

      expect(applyBlockTransform(view, 'quote')).toBe(true);
      expect(docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('> alpha');
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
