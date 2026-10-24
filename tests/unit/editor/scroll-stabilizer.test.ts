import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { scrollStabilizer } from '$lib/editor/setup';

/**
 * Behaviour tests for the production scroll stabilizer (`setup.ts`).
 *
 * happy-dom has no layout and never fires `scroll` on its own, so each test
 * sets `scrollTop` and dispatches the event the browser would fire, and
 * stubs `clientHeight` / `posAtCoords` on the real view.
 */

const VIEWPORT = 800;

function makeView(doc = 'line\n'.repeat(200)): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        scrollStabilizer,
        // CM6's built-in mouse selection needs layout (absent in happy-dom);
        // the stabilizer's own capture listener still sees the event.
        EditorView.domEventHandlers({ mousedown: () => true }),
      ],
    }),
    parent,
  });
  Object.defineProperty(view.scrollDOM, 'clientHeight', { configurable: true, value: VIEWPORT });
  return view;
}

function scrollTo(view: EditorView, top: number) {
  view.scrollDOM.scrollTop = top;
  view.scrollDOM.dispatchEvent(new Event('scroll'));
}

function click(view: EditorView, docPos: number, button = 0) {
  vi.spyOn(view, 'posAtCoords').mockReturnValue(docPos);
  view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true, clientX: 10, clientY: 10 }));
}

function frames(n: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const step = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
  return promise;
}

describe('scrollStabilizer', () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reverts a native jump caused by the click after a large scroll and restores the click position', async () => {
    view = makeView();
    scrollTo(view, 3_000_000); // large scroll (scrollbar drag) arms `pending`
    click(view, 42);
    scrollTo(view, 67); // browser's bogus scroll-into-view during the click dispatch

    expect(view.scrollDOM.scrollTop).toBe(3_000_000);
    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(42);
  });

  it('leaves small scrolls during the click alone', () => {
    view = makeView();
    scrollTo(view, 10_000);
    click(view, 5);
    scrollTo(view, 10_000 + VIEWPORT / 2);

    expect(view.scrollDOM.scrollTop).toBe(10_000 + VIEWPORT / 2);
  });

  it('[regression] a click that caused no scroll does not revert a later outline / Go to Line jump', async () => {
    view = makeView();
    scrollTo(view, 50_000); // PageDown-sized scroll arms `pending`
    click(view, 7); // click causes no scroll
    await frames(3); // click handling and CM6's measure are done

    const before = view.state.selection.main.head;
    scrollTo(view, 900_000); // outline jump, larger than one screen

    expect(view.scrollDOM.scrollTop).toBe(900_000);
    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(before);
  });

  it('clamps the restored click position to the current document length', async () => {
    view = makeView('0123456789');
    scrollTo(view, 5_000);
    click(view, 9);
    view.dispatch({ changes: { from: 0, to: 10, insert: 'ab' } });
    scrollTo(view, 0);

    await Promise.resolve();
    expect(view.state.selection.main.head).toBe(2);
  });

  it('ignores right-clicks', () => {
    view = makeView();
    scrollTo(view, 3_000_000);
    click(view, 1, 2);
    scrollTo(view, 0);

    expect(view.scrollDOM.scrollTop).toBe(0);
  });
});
