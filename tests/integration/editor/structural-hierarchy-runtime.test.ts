import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension, type SelectionRange } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, indentWithTab, undo } from '@codemirror/commands';
import {
  applyStructuralHierarchy,
  selectedQuoteInputHandler,
  structuralHierarchyKeymap,
} from '$lib/editor/structural-hierarchy';
import { imeGuardPlugin } from '$lib/editor/ime-guard';
import { slashCommandExtension } from '$lib/editor/slash-commands';
import { createEditorExtensions, reconfigureEditorState } from '$lib/editor/setup';

function makeView(doc: string, selection: EditorSelection | SelectionRange, extras: Extension[] = []) {
  let docChangedTransactions = 0;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        EditorState.allowMultipleSelections.of(true),
        history(),
        selectedQuoteInputHandler,
        keymap.of([
          ...structuralHierarchyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged) docChangedTransactions += 1;
        }),
        ...extras,
      ],
    }),
  });
  return {
    view,
    get docChangedTransactions() { return docChangedTransactions; },
    destroy() {
      view.destroy();
      document.body.innerHTML = '';
    },
  };
}

function runInputHandlers(view: EditorView, from: number, to: number, text: string): boolean {
  return view.state.facet(EditorView.inputHandler).some(handler =>
    handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })),
  );
}

function typeThroughInputHandlers(view: EditorView, from: number, to: number, text: string): boolean {
  const insert = () => view.state.update({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
  });
  const handled = view.state.facet(EditorView.inputHandler).some(handler =>
    handler(view, from, to, text, insert),
  );
  if (!handled) view.dispatch(insert());
  return handled;
}

function keydown(view: EditorView, key: 'Tab', shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  return view.contentDOM.dispatchEvent(event);
}

async function waitForImeGuardSettle() {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('[contract] structural hierarchy runtime integration', () => {
  it('converts exact selected > replacement to quotes without deleting selected CJK text', () => {
    const doc = '开头\n你好世界\n结尾';
    const initialSelection = EditorSelection.single(doc.indexOf('好'), doc.indexOf('结') - 1);
    const harness = makeView(doc, initialSelection);

    try {
      const { view } = harness;
      expect(runInputHandlers(view, initialSelection.main.from, initialSelection.main.to, '>')).toBe(true);
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('开头\n> 你好世界\n结尾');
      expect(view.state.selection.main.from).toBe(initialSelection.main.from + 2);
      expect(view.state.selection.main.to).toBe(initialSelection.main.to + 2);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(initialSelection)).toBe(true);
    } finally {
      harness.destroy();
    }
  });

  it('uses the nonempty input replacement range instead of an unrelated current selection', () => {
    const doc = 'alpha\n你好世界\nomega';
    const currentSelection = EditorSelection.single(1, 4);
    const harness = makeView(doc, currentSelection);

    try {
      const { view } = harness;
      const from = doc.indexOf('好');
      const to = doc.indexOf('界');

      expect(runInputHandlers(view, from, to, '>')).toBe(true);
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('alpha\n> 你好世界\nomega');
      expect(view.state.selection.eq(currentSelection)).toBe(true);
    } finally {
      harness.destroy();
    }
  });

  it('does not intercept a collapsed input range because another selection is nonempty', () => {
    const doc = 'alpha\n你好世界';
    const currentSelection = EditorSelection.single(1, 4);
    const harness = makeView(doc, currentSelection);

    try {
      const cursor = doc.indexOf('好');
      expect(runInputHandlers(harness.view, cursor, cursor, '>')).toBe(false);
      expect(harness.docChangedTransactions).toBe(0);
      expect(harness.view.state.doc.toString()).toBe(doc);
      expect(harness.view.state.selection.eq(currentSelection)).toBe(true);
    } finally {
      harness.destroy();
    }
  });

  it('transforms only the provided range while mapping every current selection range', () => {
    const doc = 'first\nsecond\nthird';
    const third = doc.indexOf('third');
    const selection = EditorSelection.create([
      EditorSelection.range(1, 3),
      EditorSelection.range(third + 4, third + 1),
    ], 1);
    const harness = makeView(doc, selection);

    try {
      const { view } = harness;
      expect(runInputHandlers(view, selection.main.from, selection.main.to, '>')).toBe(true);
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('first\nsecond\n> third');
      expect(view.state.selection.mainIndex).toBe(1);
      expect(view.state.selection.ranges.map(range => [range.anchor, range.head])).toEqual([
        [1, 3],
        [third + 6, third + 3],
      ]);

      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(selection)).toBe(true);
    } finally {
      harness.destroy();
    }
  });

  for (const [direction, currentSelection] of [
    ['forward', EditorSelection.single(1, 6)],
    ['reversed', EditorSelection.single(6, 1)],
  ] as const) {
    it(`keeps an unrelated ${direction} selection outside an inserted quote at its endpoint`, () => {
      const doc = 'alpha\nbeta';
      const harness = makeView(doc, currentSelection);

      try {
        const { view } = harness;
        const from = doc.indexOf('beta') + 1;
        const to = from + 2;

        expect(runInputHandlers(view, from, to, '>')).toBe(true);
        expect(harness.docChangedTransactions).toBe(1);
        expect(view.state.doc.toString()).toBe('alpha\n> beta');
        expect(view.state.selection.eq(currentSelection)).toBe(true);

        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
        expect(view.state.selection.eq(currentSelection)).toBe(true);
      } finally {
        harness.destroy();
      }
    });
  }

  it('ignores ordinary replacement text and empty-selection > typing', () => {
    const replacement = makeView('alpha', EditorSelection.single(1, 4));
    const empty = makeView('alpha', EditorSelection.cursor(2));

    try {
      expect(runInputHandlers(replacement.view, 1, 4, '>>')).toBe(false);
      expect(replacement.view.state.doc.toString()).toBe('alpha');
      expect(runInputHandlers(empty.view, 2, 2, '>')).toBe(false);
      expect(empty.view.state.doc.toString()).toBe('alpha');
    } finally {
      replacement.destroy();
      empty.destroy();
    }
  });

  it('lets CodeMirror apply ordinary replacement and collapsed > input', () => {
    const replacement = makeView('alpha', EditorSelection.single(1, 4));
    const collapsed = makeView('alpha', EditorSelection.cursor(2));

    try {
      expect(typeThroughInputHandlers(replacement.view, 1, 4, 'Z')).toBe(false);
      expect(replacement.view.state.doc.toString()).toBe('aZa');
      expect(replacement.view.state.selection.main.head).toBe(2);

      expect(typeThroughInputHandlers(collapsed.view, 2, 2, '>')).toBe(false);
      expect(collapsed.view.state.doc.toString()).toBe('al>pha');
      expect(collapsed.view.state.selection.main.head).toBe(3);
    } finally {
      replacement.destroy();
      collapsed.destroy();
    }
  });

  it('bypasses selected > conversion while the slash menu is open', () => {
    const harness = makeView('', EditorSelection.cursor(0), [slashCommandExtension]);

    try {
      const { view } = harness;
      expect(typeThroughInputHandlers(view, 0, 0, '/')).toBe(true);
      view.dispatch({ selection: EditorSelection.single(0, 1) });

      expect(runInputHandlers(view, 0, 1, '>')).toBe(false);
      expect(view.state.doc.toString()).toBe('/');
      expect(harness.docChangedTransactions).toBe(1);
    } finally {
      harness.destroy();
    }
  });

  it('bypasses selected > conversion during IME composition', async () => {
    const doc = 'alpha\nbeta';
    const selection = EditorSelection.single(1, 8);
    const harness = makeView(doc, selection, [imeGuardPlugin]);

    try {
      const { view } = harness;
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(runInputHandlers(view, 1, 8, '>')).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);

      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await waitForImeGuardSettle();

      expect(runInputHandlers(view, 1, 8, '>')).toBe(true);
      expect(view.state.doc.toString()).toBe('> alpha\n> beta');
    } finally {
      harness.destroy();
    }
  });

  it('nests and unnests quote, unordered, and task lines while preserving markers and checkboxes', () => {
    const doc = '> quote\n* star\n- [x] done\n- [ ] todo';
    const selection = EditorSelection.single(0, doc.length);
    const harness = makeView(doc, selection);

    try {
      const { view } = harness;
      keydown(view, 'Tab');
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('> > quote\n  * star\n  - [x] done\n  - [ ] todo');

      keydown(view, 'Tab', true);
      expect(harness.docChangedTransactions).toBe(2);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      harness.destroy();
    }
  });

  it('nests selected structural lines as one undoable transaction', () => {
    const doc = '> quote\n* star\n- [x] done';
    const selection = EditorSelection.single(0, doc.length);
    const harness = makeView(doc, selection);

    try {
      const { view } = harness;
      keydown(view, 'Tab');
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('> > quote\n  * star\n  - [x] done');
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(selection)).toBe(true);
    } finally {
      harness.destroy();
    }
  });

  it('uses current-line behavior for cursor Tab and has a deterministic Shift+Tab floor', () => {
    const doc = '- alpha\nplain';
    const harness = makeView(doc, EditorSelection.cursor(3));

    try {
      const { view } = harness;
      keydown(view, 'Tab');
      expect(view.state.doc.toString()).toBe('  - alpha\nplain');

      keydown(view, 'Tab', true);
      expect(view.state.doc.toString()).toBe(doc);
      const transactionsAtFloor = harness.docChangedTransactions;
      keydown(view, 'Tab', true);
      expect(view.state.doc.toString()).toBe(doc);
      expect(harness.docChangedTransactions).toBe(transactionsAtFloor);
    } finally {
      harness.destroy();
    }
  });

  it('falls through for ordered lists, plus-marker lists, ordinary text, and mixed selections', () => {
    for (const doc of ['1. ordered', '+ plus', 'plain', '- bullet\nplain']) {
      const harness = makeView(doc, EditorSelection.single(0, doc.length));
      try {
        expect(applyStructuralHierarchy(harness.view, 'indent')).toBe(false);
        expect(harness.docChangedTransactions).toBe(0);
      } finally {
        harness.destroy();
      }
    }
  });

  it('bypasses structural Tab while slash menu is open', () => {
    const harness = makeView('/', EditorSelection.cursor(1), [slashCommandExtension]);

    try {
      expect(applyStructuralHierarchy(harness.view, 'indent')).toBe(false);
      expect(harness.docChangedTransactions).toBe(0);
      expect(harness.view.state.doc.toString()).toBe('/');
    } finally {
      harness.destroy();
    }
  });

  it('bypasses structural Tab during IME composition and resumes after composition ends', async () => {
    const doc = '* star\n- [x] done';
    const selection = EditorSelection.single(0, doc.length);
    const harness = makeView(doc, selection, [imeGuardPlugin]);

    try {
      const { view } = harness;
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      expect(applyStructuralHierarchy(view, 'indent')).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
      expect(harness.docChangedTransactions).toBe(0);

      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      await waitForImeGuardSettle();

      expect(applyStructuralHierarchy(view, 'indent')).toBe(true);
      expect(view.state.doc.toString()).toBe('  * star\n  - [x] done');
      expect(harness.docChangedTransactions).toBe(1);
    } finally {
      harness.destroy();
    }
  });

  it('maps multi-range selections through one structural transaction', () => {
    const doc = '> alpha\n- bravo\n- [ ] charlie';
    const selection = EditorSelection.create([
      EditorSelection.range(2, 5),
      EditorSelection.range(doc.indexOf('bravo'), doc.indexOf('bravo') + 2),
      EditorSelection.range(doc.indexOf('charlie') + 4, doc.indexOf('charlie') + 1),
    ], 2);
    const harness = makeView(doc, selection);

    try {
      const { view } = harness;
      keydown(view, 'Tab');
      expect(harness.docChangedTransactions).toBe(1);
      expect(view.state.doc.toString()).toBe('> > alpha\n  - bravo\n  - [ ] charlie');
      expect(view.state.selection.mainIndex).toBe(2);
      expect(view.state.selection.ranges.map(range => [range.anchor, range.head])).toEqual([
        [4, 7],
        [14, 16],
        [32, 29],
      ]);
    } finally {
      harness.destroy();
    }
  });

  for (const [direction, boundaryRange] of [
    ['forward', EditorSelection.range(0, 6)],
    ['reversed', EditorSelection.range(6, 0)],
  ] as const) {
    it(`keeps a ${direction} hierarchy range outside the next line's inserted indent`, () => {
      const doc = '- one\n- two';
      const selection = EditorSelection.create([
        boundaryRange,
        EditorSelection.range(8, 10),
      ], 1);
      const harness = makeView(doc, selection);

      try {
        const { view } = harness;
        keydown(view, 'Tab');
        expect(harness.docChangedTransactions).toBe(1);
        expect(view.state.doc.toString()).toBe('  - one\n  - two');
        expect(view.state.selection.ranges.map(range => [range.anchor, range.head])).toEqual([
          direction === 'forward' ? [2, 8] : [8, 2],
          [12, 14],
        ]);
        expect(view.state.selection.mainIndex).toBe(1);

        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(doc);
        expect(view.state.selection.eq(selection)).toBe(true);
      } finally {
        harness.destroy();
      }
    });
  }

  for (const [mode, options] of [
    ['normal', {}],
    ['tall', { tallDoc: true }],
    ['large', { largeFile: true }],
  ] as const) {
    it(`wires selected > conversion in ${mode} editor setup`, () => {
      const doc = '开头\n你好世界\n结尾';
      const selection = EditorSelection.single(doc.indexOf('好'), doc.indexOf('结') - 1);
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const view = new EditorView({
        parent,
        state: EditorState.create({ doc, selection, extensions: createEditorExtensions(options) }),
      });

      try {
        expect(runInputHandlers(view, selection.main.from, selection.main.to, '>')).toBe(true);
        expect(view.state.doc.toString()).toBe('开头\n> 你好世界\n结尾');
      } finally {
        view.destroy();
        document.body.innerHTML = '';
      }
    });

    it(`keeps structural hierarchy ahead of generic Tab in ${mode} editor setup`, () => {
      const doc = '- item\n> quote';
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc,
          selection: EditorSelection.single(0, doc.length),
          extensions: createEditorExtensions(options),
        }),
      });

      try {
        keydown(view, 'Tab');
        expect(view.state.doc.toString()).toBe('  - item\n> > quote');
      } finally {
        view.destroy();
        document.body.innerHTML = '';
      }
    });

    it(`routes ordered, plus, and plain Tab through generic indent in ${mode} editor setup`, () => {
      const indent = mode === 'large' ? '  ' : '    ';
      for (const doc of ['1. ordered', '+ plus', 'plain']) {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length),
            extensions: createEditorExtensions(options),
          }),
        });

        try {
          keydown(view, 'Tab');
          expect(view.state.doc.toString()).toBe(`${indent}${doc}`);
          keydown(view, 'Tab', true);
          expect(view.state.doc.toString()).toBe(doc);
        } finally {
          view.destroy();
          document.body.innerHTML = '';
        }
      }
    });
  }

  it('reconfigures saved state across editable and read-only structural mode boundaries', () => {
    const normal = EditorState.create({
      doc: '- item',
      extensions: createEditorExtensions(),
    });
    const edited = normal.update({ changes: { from: normal.doc.length, insert: '!' } }).state;
    const large = reconfigureEditorState(edited, createEditorExtensions({ largeFile: true }));
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const largeView = new EditorView({ parent, state: large });

    try {
      expect(largeView.state.facet(EditorView.inputHandler).length).toBeGreaterThan(0);
      expect(undo(largeView)).toBe(true);
      expect(largeView.state.doc.toString()).toBe('- item');

      const readOnly = reconfigureEditorState(
        largeView.state,
        createEditorExtensions({ readOnly: true }),
      );
      expect(readOnly.facet(EditorState.readOnly)).toBe(true);
      expect(readOnly.facet(EditorView.editable)).toBe(false);
      expect(readOnly.facet(EditorView.inputHandler)).toHaveLength(0);
    } finally {
      largeView.destroy();
      document.body.innerHTML = '';
    }
  });

  it('keeps structural input and hierarchy disabled in huge read-only setup', () => {
    const doc = '- item\n> quote';
    const selection = EditorSelection.single(0, doc.length);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection,
        extensions: createEditorExtensions({ readOnly: true }),
      }),
    });

    try {
      expect(runInputHandlers(view, selection.main.from, selection.main.to, '>')).toBe(false);
      keydown(view, 'Tab');
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.state.selection.eq(selection)).toBe(true);
    } finally {
      view.destroy();
      document.body.innerHTML = '';
    }
  });
});
