import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { toggleWrap, toggleLinePrefix } from '$lib/editor/formatting';

/**
 * Unit tests for `toggleWrap`.
 *
 * The interesting case is Case 3 (cursor inside an inline node with no
 * selection): Cmd-B inside `**姓名**` must strip the `**` delimiters instead
 * of wrapping into `****姓名****`. This requires the syntax-tree walk to run
 * against a real CM6 state, so we boot an `EditorView` attached to the
 * happy-dom document.
 */
function makeView(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown()],
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

describe('toggleWrap', () => {
  let view: EditorView | null = null;

  beforeEach(() => { view = null; });
  afterEach(() => {
    if (view) { view.destroy(); view = null; }
    document.body.innerHTML = '';
  });

  it('wraps a plain selection with **', () => {
    view = makeView('hello world');
    view.dispatch({ selection: { anchor: 6, head: 11 } }); // "world"
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('hello **world**');
  });

  it('strips ** when the selection already wraps the markers', () => {
    view = makeView('hello **world**');
    view.dispatch({ selection: { anchor: 6, head: 15 } }); // "**world**"
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('strips ** when markers immediately surround the selection', () => {
    view = makeView('hello **world**');
    view.dispatch({ selection: { anchor: 8, head: 13 } }); // "world"
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('strips ** when caret sits inside a bold run with no selection (CJK)', () => {
    // Layout: "**姓名**:" — cursor placed between the two CJK chars.
    const doc = '**姓名**:';
    view = makeView(doc);
    // Position between 姓 and 名 is char-index 3 (after "**姓").
    view.dispatch({ selection: { anchor: 3 } });
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('姓名:');
  });

  it('strips ** when caret is at the trailing edge of a bold run', () => {
    // Caret right before the closing ** — CM6 sometimes resolves this to the
    // marker node itself, so both resolution directions must be considered.
    const doc = '**hi**';
    view = makeView(doc);
    view.dispatch({ selection: { anchor: 4 } }); // just after "hi"
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('hi');
  });

  it('strips a bold run even with surrounding text on the same line', () => {
    const doc = 'alpha **bold** beta';
    view = makeView(doc);
    // Cursor inside "bold" (between 'b' and 'o')
    view.dispatch({ selection: { anchor: 8 } });
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('alpha bold beta');
  });

  it('strips italic (*) when caret is inside an Emphasis node', () => {
    const doc = 'hello *world*';
    view = makeView(doc);
    view.dispatch({ selection: { anchor: 9 } }); // inside "world"
    toggleWrap(view, '*');
    expect(view.state.doc.toString()).toBe('hello world');
  });

  it('strips inline code when caret is inside `...`', () => {
    const doc = 'run `npm test` here';
    view = makeView(doc);
    view.dispatch({ selection: { anchor: 7 } }); // inside "npm test"
    toggleWrap(view, '`');
    expect(view.state.doc.toString()).toBe('run npm test here');
  });

  it('[regression] Cmd+B with the caret right after **x** keeps the caret after the text', () => {
    view = makeView('a **bold**\nnext');
    view.dispatch({ selection: { anchor: 10 } }); // right after the closing **
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('a bold\nnext');
    expect(view.state.selection.main.head).toBe(6); // end of "bold", same line
  });

  it('[regression] Cmd+B with the caret after **x** at the end of the document does not throw', () => {
    view = makeView('**x**');
    view.dispatch({ selection: { anchor: 5 } });
    expect(() => toggleWrap(view!, '**')).not.toThrow();
    expect(view.state.doc.toString()).toBe('x');
    expect(view.state.selection.main.head).toBe(1);
  });

  it('keeps a selection on the same text when stripping via the syntax tree', () => {
    view = makeView('a **bold** b');
    view.dispatch({ selection: { anchor: 5, head: 8 } }); // "old"
    toggleWrap(view, '**');
    expect(view.state.doc.toString()).toBe('a bold b');
    const { from, to } = view.state.selection.main;
    expect(view.state.sliceDoc(from, to)).toBe('old');
  });
});

describe('toggleLinePrefix', () => {
  let view: EditorView | null = null;

  afterEach(() => {
    if (view) { view.destroy(); view = null; }
    document.body.innerHTML = '';
  });

  it('[regression] turning a heading off with the caret at column 0 of the document', () => {
    view = makeView('# Title\nbody');
    view.dispatch({ selection: { anchor: 0 } });
    expect(() => toggleLinePrefix(view!, '#')).not.toThrow();
    expect(view.state.doc.toString()).toBe('Title\nbody');
    expect(view.state.selection.main.head).toBe(0);
  });

  it('[regression] turning a heading off at column 0 does not select the previous line break', () => {
    view = makeView('intro\n# Title');
    view.dispatch({ selection: { anchor: 6 } });
    toggleLinePrefix(view, '#');
    expect(view.state.doc.toString()).toBe('intro\nTitle');
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(6);
  });

  it('turning a heading on keeps the caret on the same text', () => {
    view = makeView('Title');
    view.dispatch({ selection: { anchor: 2 } });
    toggleLinePrefix(view, '##');
    expect(view.state.doc.toString()).toBe('## Title');
    expect(view.state.selection.main.head).toBe(5);
  });

  it('changing heading level replaces the existing marker', () => {
    view = makeView('### Title');
    view.dispatch({ selection: { anchor: 0 } });
    toggleLinePrefix(view, '#');
    expect(view.state.doc.toString()).toBe('# Title');
    expect(view.state.selection.main.head).toBe(2);
  });

  it('[regression] keeps a leading #hashtag when adding a heading', () => {
    view = makeView('#话题 text');
    view.dispatch({ selection: { anchor: 0 } });
    toggleLinePrefix(view, '#');
    expect(view.state.doc.toString()).toBe('# #话题 text');
  });
});
