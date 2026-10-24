import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type * as Katex from 'katex';
import { createEditorExtensions } from '$lib/editor/setup';

/**
 * Runtime tests for KaTeX rendering (`math.ts`) in real EditorViews. KaTeX is
 * lazy-loaded on first use, so the first math document renders `$…$`
 * placeholders; these must turn into formulas in every open pane.
 */

const THROWING_TEX = 'boom<img src=x>';

vi.mock('katex', async (importOriginal) => {
  const actual = await importOriginal<typeof Katex>();
  return {
    default: {
      ...actual.default,
      renderToString: (tex: string, options?: Parameters<typeof actual.default.renderToString>[1]) => {
        if (tex === THROWING_TEX) throw new Error('render failed');
        return actual.default.renderToString(tex, options);
      },
    },
  };
});

const views: EditorView[] = [];

function mount(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    // Caret at the end so no formula shows its source.
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: createEditorExtensions({ wysiwyg: true }) }),
    parent,
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = '';
});

describe('[regression] KaTeX placeholders become formulas', () => {
  it('re-renders inline and display placeholders in every split pane once KaTeX loads', async () => {
    const doc = `inline $x^2$ here\n\n$$\na+b\n$$\n\n${'$'}${THROWING_TEX}${'$'}\n\nend`;
    const left = mount(doc);
    const right = mount(doc);
    for (const view of [left, right]) {
      expect(view.dom.querySelectorAll('.cm-novelist-math-loading').length).toBeGreaterThan(0);
    }

    await vi.waitFor(() => {
      for (const view of [left, right]) {
        expect(view.dom.querySelector('.cm-novelist-math-loading')).toBeNull();
        expect(view.dom.querySelector('.cm-novelist-math-inline .katex')).not.toBeNull();
        expect(view.dom.querySelector('.cm-novelist-math-display .katex')).not.toBeNull();
      }
    }, { timeout: 5000 });

    // A render failure shows the formula as text, never as markup.
    const error = left.dom.querySelector('.cm-novelist-math-error');
    expect(error?.textContent).toBe(`Error rendering: ${THROWING_TEX}`);
    expect(left.dom.querySelector('.cm-novelist-math-inline img')).toBeNull();
  });
});
