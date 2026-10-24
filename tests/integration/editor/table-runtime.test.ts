import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createEditorExtensions } from '$lib/editor/setup';

/**
 * Runtime tests for the editable table widget (`table.ts`) in a real
 * EditorView: when cell edits are committed to the Markdown source, and which
 * keyboard events leave the cell's editing island.
 */

const HAND_ALIGNED = '| Name  | Age |\n| ----- | --- |\n| Alice | 30  |\n\nafter';

let view: EditorView | null = null;

function mount(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: createEditorExtensions({ wysiwyg: true }) }),
    parent,
  });
  return view;
}

function cell(row: number, col: number): HTMLElement {
  const selector = row < 0 ? `thead th[data-c="${col}"]` : `tbody tr[data-r="${row}"] td[data-c="${col}"]`;
  const el = view!.dom.querySelector<HTMLElement>(`table.cm-novelist-rendered-table ${selector}`);
  if (!el) throw new Error(`cell ${row},${col} not rendered`);
  return el;
}

function typeInto(target: HTMLElement, text: string) {
  target.textContent = text;
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

async function leaveTable(target: HTMLElement) {
  target.blur();
  view!.contentDOM.focus();
  await Promise.resolve();
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = '';
});

describe('[regression] table commits only after a cell edit', () => {
  it('clicking into a hand-aligned table and back out leaves the source untouched', async () => {
    mount(HAND_ALIGNED);
    const target = cell(0, 0);
    target.focus();
    await leaveTable(target);

    expect(view!.state.doc.toString()).toBe(HAND_ALIGNED);
  });

  it('commits the edited text when focus leaves after typing', async () => {
    mount(HAND_ALIGNED);
    const target = cell(0, 0);
    target.focus();
    typeInto(target, 'Bob');
    await leaveTable(target);

    expect(view!.state.doc.toString()).toBe('| Name | Age |\n| --- | --- |\n| Bob | 30 |\n\nafter');
  });

  it('Escape out of an untouched table keeps its formatting', () => {
    mount(HAND_ALIGNED);
    const target = cell(0, 1);
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(view!.state.doc.toString().startsWith('| Name  | Age |\n| ----- | --- |\n| Alice | 30  |')).toBe(true);
  });
});

describe('[regression] app shortcuts reach the window from a table cell', () => {
  it('Cmd+S propagates and the pending cell edit is already in the document', () => {
    mount(HAND_ALIGNED);
    const target = cell(0, 1);
    target.focus();
    typeInto(target, '31');

    let docAtSave: string | null = null;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 's') docAtSave = view!.state.doc.toString();
    };
    window.addEventListener('keydown', onKey);
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }));
    } finally {
      window.removeEventListener('keydown', onKey);
    }

    expect(docAtSave).toBe('| Name | Age |\n| --- | --- |\n| Alice | 31 |\n\nafter');
  });

  it('keeps plain typing and native clipboard shortcuts inside the cell', () => {
    mount(HAND_ALIGNED);
    const target = cell(0, 0);
    target.focus();
    const reached: string[] = [];
    const onKey = (e: KeyboardEvent) => reached.push(e.key);
    window.addEventListener('keydown', onKey);
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    } finally {
      window.removeEventListener('keydown', onKey);
    }

    expect(reached).toEqual([]);
  });
});
