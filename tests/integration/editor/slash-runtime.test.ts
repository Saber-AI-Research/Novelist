import { describe, it, expect, beforeEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { slashCommandExtension } from '$lib/editor/slash-commands';
import { createEditorExtensions } from '$lib/editor/setup';

/**
 * Runtime integration tests for the slash command extension.
 *
 * We construct a real `EditorView` with the slash extension wired up,
 * invoke CM6's `inputHandler` facet the way CM6 does internally, then
 * assert on the resulting DOM / document state.
 *
 * Covers:
 *   - trigger conditions (line start / mid-line / full-width "／")
 *   - fallback trigger path used when IME composition bypasses inputHandler
 *   - widget lifecycle: hidden until positioned, not destroyed when
 *     `coordsAtPos` returns null on first measure, cleaned up on close
 *   - keyboard navigation and item selection (insert + cursor placement)
 */

function simulateTyping(view: EditorView, text: string) {
  // CM6 inputHandler facet signature: (view, from, to, text, insert) => boolean
  const handlers = view.state.facet(EditorView.inputHandler);
  const head = view.state.selection.main.head;
  for (const handler of handlers) {
    const handled = handler(view, head, head, text, () => {
      const change = view.state.update({ changes: { from: head, to: head, insert: text } });
      return change;
    });
    if (handled) return true;
  }
  // Fall through: just insert normally
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: { anchor: head + text.length },
  });
  return false;
}

async function flushTimers() {
  await Promise.resolve();
  await new Promise(r => setTimeout(r, 10));
}

describe('[contract] slash runtime integration', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('typing "/" at empty doc triggers menu DOM element', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: [slashCommandExtension],
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');

    // After dispatch, wait for microtasks
    await Promise.resolve();

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });

  it('typing "/" after text on same line does NOT trigger menu', async () => {
    const state = EditorState.create({
      doc: 'hello',
      selection: { anchor: 5 },
      extensions: [slashCommandExtension],
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await Promise.resolve();

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).toBeNull();

    view.destroy();
  });

  it('typing "/" with full editor extensions triggers menu', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });

  it('typing "/" on an empty new line after text triggers menu', async () => {
    const state = EditorState.create({
      doc: '# Title\n',
      selection: { anchor: 8 },
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });

  it('typing "/" after text on same line inserts slash but no menu', async () => {
    const state = EditorState.create({
      doc: 'hello world',
      selection: { anchor: 11 },
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).toBeNull();
    expect(view.state.doc.toString()).toBe('hello world/');

    view.destroy();
  });

  it('typing full-width "／" at empty line triggers menu', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '\uFF0F');
    await Promise.resolve();
    await new Promise(r => setTimeout(r, 10));

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });

  it('fallback: external dispatch of "/" at empty line creates menu via plugin update', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    // Simulate dispatch bypassing inputHandler (e.g. IME-composed input)
    view.dispatch({
      changes: { from: 0, to: 0, insert: '/' },
      selection: { anchor: 1 },
    });
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });
});

describe('[contract] slash menu widget lifecycle', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('widget is appended hidden, so a pre-measure (0,0) flash cannot occur', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: slashCommandExtension,
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    // Inspect synchronously — the fix must guarantee the widget is never
    // visible at an unpositioned state, even before requestMeasure fires.
    const menu = document.querySelector('.cm-slash-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.visibility).toBe('hidden');

    view.destroy();
  });

  it('widget survives when coordsAtPos is not measurable (happy-dom layout)', async () => {
    // happy-dom returns rects without a real layout, so coordsAtPos may
    // resolve to null/zero. The widget must still remain in the DOM — the
    // pre-fix bug was that the widget destroyed itself on null coords.
    const state = EditorState.create({
      doc: '',
      extensions: slashCommandExtension,
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();

    view.destroy();
  });

  it('Escape key closes the menu and removes DOM', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    simulateTyping(view, '/');
    await flushTimers();
    expect(document.querySelector('.cm-slash-menu')).not.toBeNull();

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushTimers();

    expect(document.querySelector('.cm-slash-menu')).toBeNull();

    view.destroy();
  });

  it('Backspace past the "/" closes the menu', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    simulateTyping(view, '/');
    await flushTimers();
    expect(document.querySelector('.cm-slash-menu')).not.toBeNull();

    // Backspace — the key handler should invoke menu.close() because the
    // cursor is at pos+1 (just after the slash).
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    await flushTimers();

    expect(document.querySelector('.cm-slash-menu')).toBeNull();

    view.destroy();
  });

  it('destroying the view removes the widget from document.body', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: slashCommandExtension,
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await flushTimers();
    expect(document.querySelector('.cm-slash-menu')).not.toBeNull();

    view.destroy();
    // Plugin.destroy() must clean up the widget's DOM node.
    expect(document.querySelector('.cm-slash-menu')).toBeNull();
  });

  it('ArrowDown moves selection in menu without moving editor cursor', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu');
    expect(menu).not.toBeNull();
    const initiallySelected = menu!.querySelector('.cm-slash-menu-item-selected');
    const initialLabel = initiallySelected?.textContent ?? '';
    const cursorBefore = view.state.selection.main.head;

    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(ev);
    await flushTimers();

    const nowSelected = menu!.querySelector('.cm-slash-menu-item-selected');
    expect(nowSelected).not.toBeNull();
    expect(nowSelected?.textContent).not.toBe(initialLabel);
    // Precedence fix: keymap's cursorLineDown must NOT run while menu is open.
    expect(view.state.selection.main.head).toBe(cursorBefore);

    view.destroy();
  });

  it('ArrowUp wraps selection from first item to last', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu') as HTMLElement;
    const items = menu.querySelectorAll('.cm-slash-menu-item');
    const lastItemLabel = items[items.length - 1].textContent;

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await flushTimers();

    const nowSelected = menu.querySelector('.cm-slash-menu-item-selected');
    expect(nowSelected?.textContent).toBe(lastItemLabel);

    view.destroy();
  });

  it('Enter selects the highlighted item and inserts its markdown', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    simulateTyping(view, '/');
    await flushTimers();

    // First item is Heading 1 → pressing Enter should insert "# " and place
    // the cursor after the space.
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushTimers();

    expect(view.state.doc.toString()).toBe('# ');
    expect(view.state.selection.main.head).toBe(2);
    expect(document.querySelector('.cm-slash-menu')).toBeNull();

    view.destroy();
  });

  it('flips above the cursor when positioned in the lower half of the viewport', async () => {
    // Simulate an EditorView where coordsAtPos returns a rect near the
    // bottom of the viewport. We install a spy on the real view to return
    // a controlled rect, then trigger the measure write path by calling
    // the widget's position() via the plugin.
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    // Stub coordsAtPos to report a cursor near the viewport bottom.
    const fakeBottom = window.innerHeight - 40;
    const originalCoords = view.coordsAtPos.bind(view);
    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = () => ({
      left: 100,
      right: 101,
      top: fakeBottom - 18,
      bottom: fakeBottom,
    });

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    // In happy-dom, the menu's measured height may be 0 and we fall back to
    // the 320px cap. With cursor at ~bottom - 40, spaceBelow (~40) is less
    // than 320 + gap → flip above.
    const topPx = parseFloat(menu.style.top);
    // Flipped position must be strictly above the cursor's top.
    expect(topPx).toBeLessThan(fakeBottom - 18);

    // Restore
    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = originalCoords;
    view.destroy();
  });

  it('stays below the cursor when placed near the top of the viewport', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    const originalCoords = view.coordsAtPos.bind(view);
    // Cursor at y≈50 — plenty of room below.
    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = () => ({
      left: 100,
      right: 101,
      top: 32,
      bottom: 50,
    });

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    const topPx = parseFloat(menu.style.top);
    // Below the cursor bottom (plus the 6px gap).
    expect(topPx).toBeGreaterThanOrEqual(50);

    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = originalCoords;
    view.destroy();
  });

  it('clamps horizontally when the cursor is near the right edge', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });
    view.focus();

    const originalCoords = view.coordsAtPos.bind(view);
    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = () => ({
      left: window.innerWidth - 20,
      right: window.innerWidth - 18,
      top: 100,
      bottom: 118,
    });

    simulateTyping(view, '/');
    await flushTimers();

    const menu = document.querySelector('.cm-slash-menu') as HTMLElement;
    const leftPx = parseFloat(menu.style.left);
    // Must not render past the right edge — assuming the fallback 280px
    // width, left should be clamped to (innerWidth - 280 - margin).
    expect(leftPx + 280).toBeLessThanOrEqual(window.innerWidth);

    (view as unknown as { coordsAtPos: typeof view.coordsAtPos }).coordsAtPos = originalCoords;
    view.destroy();
  });

  it('icons render as inline SVG markup', async () => {
    const state = EditorState.create({
      doc: '',
      extensions: createEditorExtensions({ wysiwyg: true }),
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    await flushTimers();

    const iconCells = document.querySelectorAll('.cm-slash-menu-icon');
    expect(iconCells.length).toBeGreaterThan(0);
    for (const cell of iconCells) {
      expect(cell.querySelector('svg')).not.toBeNull();
    }

    view.destroy();
  });

  it('slashMenuField tracks active state across transactions', async () => {
    // Indirect check: after typing, the plugin must think the menu is
    // active (otherwise no widget would be created).
    const state = EditorState.create({
      doc: '',
      extensions: slashCommandExtension,
    });
    const view = new EditorView({ state, parent: container });

    simulateTyping(view, '/');
    expect(document.querySelector('.cm-slash-menu')).not.toBeNull();

    // Type a filter letter — widget should still be present.
    simulateTyping(view, 'h');
    await flushTimers();
    expect(document.querySelector('.cm-slash-menu')).not.toBeNull();
    expect(view.state.doc.toString()).toBe('/h');

    view.destroy();
  });
});
