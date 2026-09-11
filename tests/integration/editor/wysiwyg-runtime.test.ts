import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cursorCharLeft, cursorCharRight, selectCharRight } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { wysiwygPlugin } from '$lib/editor/wysiwyg';
import { createEditorExtensions } from '$lib/editor/setup';
import { imeComposingField, imeGuardPlugin, isImeComposing } from '$lib/editor/ime-guard';

// Real EditorViews exercise marker visibility, native text-node ownership, and
// CM6's prohibition on ViewPlugin replacements spanning line breaks.

function makeView(doc: string, extras: Extension[] = []): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdown(), wysiwygPlugin, ...extras],
  });
  // happy-dom provides a document object; attach the view to a parent.
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state, parent });
}

describe('[regression] WYSIWYG source visibility and IME lifecycle', () => {
  let view: EditorView | null = null;

  beforeEach(() => {
    view = null;
  });

  afterEach(() => {
    if (view) {
      view.destroy();
      view = null;
    }
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('reveals all inline source on entry and keeps it stable while editing the same line', () => {
    const first = 'before **加粗** after';
    view = makeView(`${first}\n\nelsewhere`);
    const line = () => view!.contentDOM.querySelector('.cm-line')!.textContent;
    expect(line()).toBe(first);

    view.dispatch({ selection: { anchor: first.indexOf('加粗') } });
    expect(line()).toBe(first);
    view.dispatch({ selection: { anchor: first.length } });
    expect(line()).toBe(first);
    view.dispatch({ changes: { from: first.length, insert: '尾' } });
    expect(line()).toBe(`${first}尾`);

    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(line()).toBe('before 加粗 after尾');
    view.dispatch({ selection: { anchor: 1 } });
    expect(line()).toBe(`${first}尾`);
  });

  it('reveals a multi-line bold construct when a selected line intersects it', () => {
    const doc = 'before **第一行\n第二行** after\n\nelsewhere';
    view = makeView(doc);
    view.dispatch({ selection: { anchor: doc.length } });
    const text = () => Array.from(view!.contentDOM.querySelectorAll('.cm-line'), line => line.textContent);
    expect(text().slice(0, 2)).toEqual(['before 第一行', '第二行 after']);

    view.dispatch({ selection: { anchor: doc.indexOf('after') + 1 } });
    expect(text().slice(0, 2)).toEqual(['before **第一行', '第二行** after']);
    view.dispatch({ selection: { anchor: 0, head: doc.length } });
    expect(text().slice(0, 2)).toEqual(['before **第一行', '第二行** after']);
    view.dispatch({ selection: { anchor: doc.length, head: 0 } });
    expect(text().slice(0, 2)).toEqual(['before **第一行', '第二行** after']);
  });

  it('reveals every selected line without revealing untouched inline constructs', () => {
    const doc = '**一**\n\n**二**\n\n**三**';
    view = makeView(doc, [EditorState.allowMultipleSelections.of(true)]);
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.length)], 1),
    });
    const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'), line => line.textContent);
    expect([lines[0], lines[2], lines[4]]).toEqual(['**一**', '二', '**三**']);
  });

  it('collapses only the required heading separator and preserves extra content whitespace', () => {
    view = makeView('##   标题 ##\n\n## \t中文\n\nbody');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'), line => line.textContent);
    expect([lines[0], lines[2]]).toEqual(['  标题 ', '\t中文']);

    view.dispatch({ selection: { anchor: 3 } });
    expect(view.contentDOM.querySelector('.cm-line')!.textContent).toBe('##   标题 ##');
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-novelist-marker-visible'), node => node.textContent))
      .toEqual(['##', '##']);
  });

  it('snaps hidden trailing markers but preserves pointers and arrows into visible source', () => {
    const doc = 'elsewhere\n\n前文**加粗**';
    const closing = doc.lastIndexOf('**');
    view = makeView(doc);
    view.dispatch({ selection: { anchor: closing }, userEvent: 'select.pointer' });
    expect(view.state.selection.main.head).toBe(doc.length);
    view.dispatch({ selection: { anchor: closing }, userEvent: 'select.pointer' });
    expect(view.state.selection.main.head).toBe(closing);
    cursorCharLeft(view);
    expect(view.state.selection.main.head).toBe(closing - 1);
    cursorCharRight(view);
    expect(view.state.selection.main.head).toBe(closing);
    view.dispatch({ selection: { anchor: 0, head: closing } });
    expect(view.state.selection.main.head).toBe(closing);
    expect(view.state.selection.main.anchor).toBe(0);
  });

  it('reveals inline math when the cursor moves to its boundary on the same line', () => {
    const doc = 'before $x + y$ after';
    const mathFrom = doc.indexOf('$');
    const state = EditorState.create({
      doc,
      selection: { anchor: mathFrom - 1 },
      extensions: createEditorExtensions(),
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(1);

    view.dispatch({ selection: { anchor: mathFrom } });

    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(0);
    expect(view.dom.querySelector('.cm-novelist-math-source')).not.toBeNull();
  });

  it('moves left and right through inline math source instead of skipping the widget', () => {
    const doc = 'A $x$ B';
    const mathFrom = doc.indexOf('$');
    const mathTo = doc.indexOf('$', mathFrom + 1) + 1;
    const state = EditorState.create({
      doc,
      selection: { anchor: mathFrom - 1 },
      extensions: createEditorExtensions(),
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(cursorCharRight(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathFrom);
    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(0);

    expect(cursorCharRight(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathFrom + 1);

    view.dispatch({ selection: { anchor: mathTo + 1 } });
    expect(cursorCharLeft(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathTo);
    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(0);

    expect(cursorCharLeft(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathTo - 1);
  });

  it('extends a keyboard selection into inline math one source character at a time', () => {
    const doc = 'A $xy$ B';
    const mathFrom = doc.indexOf('$');
    const state = EditorState.create({
      doc,
      selection: { anchor: mathFrom - 1 },
      extensions: createEditorExtensions(),
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(selectCharRight(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathFrom);
    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(0);

    expect(selectCharRight(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(mathFrom + 1);
  });

  it('reveals every inline formula touched by a selection on a math-heavy line', () => {
    const doc =
      '每根轴携带：**名字**、**类型** $\\tau\\in\\{\\mathrm{par},\\ \\mathrm{red}_M,\\ ' +
      '\\mathrm{batch},\\ \\mathrm{time},\\ \\mathrm{mem}\\}$（$\\mathrm{red}_M$ ' +
      '参数化于交换幺半群 $M$，§5.3）。空积 $\\mathbf{1}$ 是张量单位。';
    const mathRanges = Array.from(doc.matchAll(/\$[^$]+\$/g), match => ({
      from: match.index,
      to: match.index + match[0].length,
    }));
    expect(mathRanges).toHaveLength(4);
    const state = EditorState.create({
      doc,
      selection: { anchor: mathRanges[0].from + 1, head: mathRanges[2].to - 1 },
      extensions: createEditorExtensions(),
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(view.dom.querySelectorAll('.cm-novelist-math-inline')).toHaveLength(1);
  });

  it('rebuilds display-math source styling when the selection enters the block', () => {
    const doc = 'before\n\n$$\nx + y\n$$\n\nafter';
    const mathContent = doc.indexOf('x + y') + 1;
    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: createEditorExtensions(),
    });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(view.dom.querySelector('.cm-novelist-math-display')).not.toBeNull();

    view.dispatch({ selection: { anchor: mathContent } });

    expect(view.dom.querySelector('.cm-novelist-math-display')).toBeNull();
    expect(view.dom.querySelector('.cm-novelist-math-block-line')).not.toBeNull();
  });

  it('keeps the first heading composition in its original editable text node', () => {
    vi.useFakeTimers();
    view = makeView('## \n\nbody', [imeGuardPlugin]);
    view.dispatch({ selection: { anchor: 3 } });
    const textNode = view.domAtPos(3).node;
    expect(textNode.nodeType).toBe(Node.TEXT_NODE);
    expect(textNode.textContent).toBe(' ');

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch({ changes: { from: 3, insert: 'z' }, selection: { anchor: 4 }, userEvent: 'input.type.compose' });
    expect(view.domAtPos(4).node).toBe(textNode);
    view.dispatch({ changes: { from: 3, to: 4, insert: '中' }, selection: { anchor: 4 }, userEvent: 'input.type.compose' });
    expect(view.domAtPos(4).node).toBe(textNode);
    expect(textNode.textContent).toBe(' 中');
    expect(view.state.doc.toString()).toBe('## 中\n\nbody');
    expect(view.state.selection.main.head).toBe(4);

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    vi.advanceTimersByTime(20);
    expect(isImeComposing(view)).toBe(false);
    expect(view.contentDOM.querySelector('.cm-line')!.textContent).toBe('## 中');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.contentDOM.querySelector('.cm-line')!.textContent).toBe('中');
  });

  it('waits for composition to settle before rendering newly completed bold syntax', () => {
    vi.useFakeTimers();
    view = makeView('**中文', [imeGuardPlugin]);
    view.dispatch({ selection: { anchor: 4 } });
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch({
      changes: { from: 4, insert: '**' },
      selection: { anchor: 6 },
      userEvent: 'input.type.compose',
    });
    expect(view.contentDOM.querySelector('.cm-novelist-bold')).toBeNull();
    expect(view.contentDOM.querySelector('.cm-line')!.textContent).toBe('**中文**');
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(20);
    expect(view.contentDOM.querySelector('.cm-novelist-bold')!.textContent).toBe('**中文**');
    expect(view.state.selection.main.head).toBe(6);
  });

  it('keeps all lines editable when composition inserts a newline into a collapsed URL', () => {
    vi.useFakeTimers();
    const doc = 'before\n\n[link](https://example.com)\n\nafter';
    const insertAt = doc.indexOf('example.com');
    view = makeView(doc, [imeGuardPlugin]);
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch({
      changes: { from: insertAt, insert: '\n' },
      selection: { anchor: insertAt + 1 },
      userEvent: 'input.type.compose',
    });
    view.dispatch({
      changes: { from: insertAt + 1, insert: '中' },
      selection: { anchor: insertAt + 2 },
      userEvent: 'input.type.compose',
    });
    const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'), line => line.textContent);
    expect(lines[2]).toContain('https://');
    expect(lines[3]).toContain('中example.com');
    expect(lines).toHaveLength(6);
    expect(view.state.doc.toString()).toBe(doc.slice(0, insertAt) + '\n中' + doc.slice(insertAt));
    expect(view.state.selection.main.head).toBe(insertAt + 2);

    view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    vi.advanceTimersByTime(20);
    view.dispatch({ changes: { from: insertAt + 2, insert: '文' }, selection: { anchor: insertAt + 3 } });
    expect(view.state.doc.lineAt(insertAt + 3).text).toBe('中文example.com)');
    expect(view.contentDOM.querySelectorAll('.cm-line')[3].textContent).toContain('中文example.com');
  });

  it('does not snap a composition selection across a collapsed marker boundary', () => {
    const doc = 'before\n\n**加粗**';
    const closing = doc.lastIndexOf('**');
    view = makeView(doc, [imeGuardPlugin]);
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    view.dispatch({ selection: { anchor: closing }, userEvent: 'select.pointer' });
    expect(view.state.selection.main.head).toBe(closing);
  });

  it('does not let an earlier composition end release a newer session', () => {
    vi.useFakeTimers();
    view = makeView('正在输入', [imeGuardPlugin]);
    const settled = vi.fn();
    window.addEventListener('novelist-composition-end', settled);
    try {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      vi.advanceTimersByTime(15);
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      vi.advanceTimersByTime(10);
      expect(view.state.field(imeComposingField)).toBe(true);
      expect(isImeComposing(view)).toBe(true);
      expect(settled).not.toHaveBeenCalled();

      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      expect(isImeComposing(view)).toBe(true);
      vi.advanceTimersByTime(20);
      expect(isImeComposing(view)).toBe(false);
      expect(settled).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('novelist-composition-end', settled);
    }
  });

  it.each(['destroy', 'reconfigure'])('cancels pending IME notifications on editor %s', (lifecycle) => {
    vi.useFakeTimers();
    const guard = new Compartment();
    view = makeView('中文', [guard.of(imeGuardPlugin)]);
    const settled = vi.fn();
    window.addEventListener('novelist-composition-end', settled);
    try {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      if (lifecycle === 'destroy') {
        view.destroy();
        view = null;
      } else {
        view.dispatch({ effects: guard.reconfigure([]) });
      }
      vi.advanceTimersByTime(20);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('novelist-composition-end', settled);
    }
  });

  it('renders newly inserted block widgets during IME composition', () => {
    const state = EditorState.create({ doc: '', extensions: createEditorExtensions() });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });
    view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const doc = '| A | B |\n|-|-|\n| 中 | en |\n';
    view.dispatch({ changes: { from: 0, insert: doc }, selection: { anchor: doc.length } });
    expect(Array.from(view.dom.querySelectorAll('table.cm-novelist-rendered-table td'), cell => cell.textContent))
      .toEqual(['中', 'en']);
  });
});
