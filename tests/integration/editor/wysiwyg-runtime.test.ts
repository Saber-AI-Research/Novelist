import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { wysiwygPlugin } from '$lib/editor/wysiwyg';
import { createEditorExtensions } from '$lib/editor/setup';

/**
 * Runtime integration tests for the WYSIWYG extension.
 *
 * These tests instantiate an actual CM6 EditorView with the real wysiwygPlugin
 * attached to a happy-dom DOM node, then exercise the decoration pipeline by
 * loading content and dispatching transactions.
 *
 * The rest of our editor tests are pure state-machine models (see
 * image-block-deco.test.ts, checklist.test.ts, etc.) — they verify the
 * logic of decoration strategies but do NOT run CM6's actual decoration
 * validator. CM6 throws at runtime when:
 *   - a ViewPlugin emits Decoration.replace({block: true})
 *   - a ViewPlugin emits Decoration.replace across a line break
 * Those runtime rules can only be caught by tests that actually boot CM6.
 */

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

describe('wysiwygPlugin — runtime decoration validation', () => {
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
  });

  it('accepts a document of plain text', () => {
    view = makeView('hello world');
    expect(view.state.doc.length).toBe(11);
  });

  it('accepts an ATX heading', () => {
    view = makeView('# Hello\n\nbody');
    expect(() => view!.dispatch({ selection: { anchor: 8 } })).not.toThrow();
  });

  it('accepts turning a body paragraph into an H1 by typing "# "', () => {
    // Reported scenario: user has a doc with existing content, moves cursor
    // to a paragraph in the middle, and types "# " to promote it to H1.
    // This triggers an incremental re-parse and a burst of new decorations.
    const initial =
      '# Existing title\n' +
      '\n' +
      'paragraph one\n' +
      'paragraph two\n' +
      '\n' +
      'final paragraph\n';
    view = makeView(initial);

    // Find start of "paragraph two" line
    const lineStart = initial.indexOf('paragraph two');
    expect(lineStart).toBeGreaterThan(0);

    expect(() => {
      // Move cursor to start of line
      view!.dispatch({ selection: { anchor: lineStart } });
      // Type '#'
      view!.dispatch({ changes: { from: lineStart, insert: '#' } });
      // Type ' ' — this is the char that promotes the line to ATXHeading1
      view!.dispatch({ changes: { from: lineStart + 1, insert: ' ' } });
      // Move cursor off so the !cursorInside branch runs for both headings
      view!.dispatch({ selection: { anchor: view!.state.doc.length } });
      // Move cursor back onto the new heading
      view!.dispatch({ selection: { anchor: lineStart } });
    }).not.toThrow();
  });

  it('accepts a task list (the checkbox widget path)', () => {
    view = makeView('- [ ] Task one\n- [x] Task two\n- [ ] Task three\n');
    // Move cursor off any task line so !cursorInside branch runs for ALL tasks
    expect(() => view!.dispatch({ selection: { anchor: view!.state.doc.length } }))
      .not.toThrow();
  });

  it('accepts a list of inline links (the URL-hiding path)', () => {
    const doc =
      '- [coc-markmap](https://github.com/jaywcjlove/coc-markmap) for Neovim\n' +
      '- [markmap-vscode](https://marketplace.visualstudio.com/items?itemName=gera2ld.markmap-vscode) for VSCode\n' +
      '- [eaf-markmap](https://github.com/emacs-eaf/eaf-markmap) for Emacs\n';
    view = makeView(doc);
    // Park cursor on an empty trailing line so no link has cursor inside
    expect(() => view!.dispatch({ selection: { anchor: doc.length } })).not.toThrow();
  });

  it('accepts typing into a task list document (reproduces user scenario)', () => {
    // User scenario: typing inside a link text on a line that also has a task list.
    const doc =
      '## Tools\n' +
      '\n' +
      '- [coc-markmap](https://github.com/jaywcjlove/coc-markmap) for Neovim\n' +
      '- [ ] write a review of markmap\n';
    view = makeView(doc);

    // Find position inside "coc-markmap" — char 22 puts us between "coc-" and "markmap"
    const pos = doc.indexOf('markmap', 12);
    expect(pos).toBeGreaterThan(0);

    expect(() => {
      view!.dispatch({ selection: { anchor: pos } });
      view!.dispatch({ changes: { from: pos, insert: 'X' } });
      view!.dispatch({ changes: { from: pos + 1, insert: 'Y' } });
    }).not.toThrow();
  });

  it('accepts incomplete inline constructs (partial link, unclosed $, unterminated code)', () => {
    // Mid-typing states — these can momentarily produce odd parser tree shapes.
    const docs = [
      '[partial-link\nnext line\n',              // unclosed `[`
      '[text](http://example.com\nmore\n',       // unclosed URL paren
      'inline $math that never closes\nnext\n', // unclosed $
      'typing `code without close\nnext\n',     // unclosed inline code
      '- [ ] task\n  continuation on wrapped line that extends the content\n',
      '- \n  [ ] would-be task on next line\n', // ListMark with content on next line
    ];
    for (const doc of docs) {
      const state = EditorState.create({ doc, extensions: createEditorExtensions() });
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const v = new EditorView({ state, parent });
      try {
        expect(() => {
          v.dispatch({ selection: { anchor: 0 } });
          v.dispatch({ selection: { anchor: doc.length } });
          v.dispatch({ selection: { anchor: Math.floor(doc.length / 2) } });
        }).not.toThrow();
      } finally {
        v.destroy();
      }
    }
  });

  it('full extension stack accepts typical markdown without errors', () => {
    // Reproduces the user's reported bug scenario using the real extension chain.
    const doc =
      '# Markmap notes\n' +
      '\n' +
      '## Tools\n' +
      '\n' +
      '- [coc-markmap](https://github.com/jaywcjlove/coc-markmap) for Neovim\n' +
      '- [markmap-vscode](https://marketplace.visualstudio.com/items?itemName=gera2ld.markmap-vscode) for VSCode\n' +
      '- [eaf-markmap](https://github.com/emacs-eaf/eaf-markmap) for Emacs\n' +
      '\n' +
      '## Checklist\n' +
      '\n' +
      '- [ ] read docs\n' +
      '- [x] try demo\n' +
      '\n' +
      'Inline math $x^2 + y^2 = z^2$ and emphasis *em* and code `x`.\n';
    const state = EditorState.create({ doc, extensions: createEditorExtensions() });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    // Dispatch a sequence mirroring what happens when the user types.
    expect(() => {
      const mid = doc.indexOf('markmap', 40);
      view!.dispatch({ selection: { anchor: mid } });
      view!.dispatch({ changes: { from: mid, insert: 'z' } });
      view!.dispatch({ selection: { anchor: view!.state.doc.length } });
    }).not.toThrow();
  });

  it('simulates the user crash file (01.md from /Users/.../小说模板/) — frontmatter + inline math + links + IME-like insert', () => {
    // Content mirrors the user's actual crash file structure. The `# c`
    // heading simulates a mid-composition IME state.
    const doc =
      '---\n' +
      'title: markmap\n' +
      'markmap:\n' +
      '  colorFreezeLevel: 2\n' +
      '---\n' +
      '\n' +
      '# c\n' +
      '\n' +
      '## Links\n' +
      '\n' +
      '- [Website](https://markmap.js.org/)\n' +
      '- [GitHub](https://github.com/gera2ld/markmap)\n' +
      '\n' +
      '## Related Projects\n' +
      '\n' +
      '- [coc-markmap](https://github.com/gera2ld/coc-markmap) for Neovim\n' +
      '- [markmap-vscode](https://marketplace.visualstudio.com/items?itemName=gera2ld.markmap-vscode) for VSCode\n' +
      '\n' +
      '- Katex: $x = {-b \\pm \\sqrt{b^2-4ac} \\over 2a}$\n' +
      '- [x] checkbox\n' +
      '\n' +
      '```js\n' +
      "console.log('hello, JavaScript')\n" +
      '```\n' +
      '\n' +
      '| Products | Price |\n' +
      '|-|-|\n' +
      '| Apple | 4 |\n';

    const state = EditorState.create({ doc, extensions: createEditorExtensions() });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(() => {
      // Cursor on the "# c" heading (position where user was composing)
      const hPos = doc.indexOf('# c') + 3; // after 'c'
      view!.dispatch({ selection: { anchor: hPos } });
      // Simulate IME inserting chinese chars one by one (compositionend has
      // already committed each). The critical thing is that doc changes
      // fire while potentially in transient tree states.
      for (const ch of '章节标题开篇') {
        view!.dispatch({ changes: { from: view!.state.selection.main.head, insert: ch } });
      }
      // Move cursor around (triggers onSelectionChange)
      view!.dispatch({ selection: { anchor: 0 } });
      view!.dispatch({ selection: { anchor: view!.state.doc.length } });
      // Insert a newline inside a position that currently has a link URL
      // — this is the pathological case that caused stale cross-line replace
      const urlPos = view!.state.doc.toString().indexOf('https://markmap.js.org/');
      if (urlPos > 0) {
        view!.dispatch({ selection: { anchor: urlPos + 5 } });
        view!.dispatch({ changes: { from: urlPos + 5, insert: '\n' } });
      }
    }).not.toThrow();
  });

  it('IME composition then docChange must not leak stale cross-line decorations', () => {
    // Regression for the runtime RangeError reported with CJK IME:
    //   "Decorations that replace line breaks may not be specified via plugins"
    //
    // The old WysiwygPlugin.update returned early on isComposing BEFORE the
    // docChanged branch. CM6 would then map the stale DecorationSet through
    // the composition's change — if that change inserted a newline inside a
    // `Decoration.replace` range (e.g., inside a Link/TaskMarker/header),
    // the mapped decoration now crosses a line break and CM6 throws on the
    // next render.
    //
    // Fix: rebuild on docChanged even during IME. This test dispatches a
    // compositionstart event to set the IME guard, then a docChange
    // transaction that inserts content across/inside a link URL.
    const doc =
      '# Title\n' +
      '\n' +
      'See [link](https://example.com) for info.\n' +
      '\n' +
      '- [ ] task\n';
    const state = EditorState.create({ doc, extensions: createEditorExtensions() });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    view = new EditorView({ state, parent });

    expect(() => {
      // Simulate IME composition start — imeGuardPlugin listens on contentDOM.
      view!.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      // Position cursor inside the link URL and insert a newline — the
      // pathological case that creates a cross-line replace if the ViewPlugin
      // skips rebuild.
      const urlStart = doc.indexOf('https://');
      view!.dispatch({ selection: { anchor: urlStart + 8 } });
      view!.dispatch({ changes: { from: urlStart + 8, insert: '\n' } });
      // And a plain character insert
      view!.dispatch({ changes: { from: urlStart + 9, insert: 'x' } });
      // End composition. imeGuardPlugin's setTimeout delay is irrelevant
      // to the docChange rebuild path.
      view!.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }));
    }).not.toThrow();
  });

  it('does not emit cross-line or block Decoration.replace from the ViewPlugin', () => {
    // This is the structural assertion that backs up the runtime checks
    // above. We walk the plugin's decoration set and verify every Point
    // decoration is within a single line and not block-level.
    const doc =
      '# Heading\n' +
      '\n' +
      '- [ ] task one\n' +
      '- [x] task two\n' +
      '\n' +
      '[link](https://example.com)\n' +
      '\n' +
      'Paragraph with *emphasis* and **strong** and `code`.\n';
    view = makeView(doc);
    view.dispatch({ selection: { anchor: doc.length } }); // cursor outside all constructs

    // Iterate over the VIEW's decoration set (what CM6 would validate).
    const decoSets = view.state.facet(EditorView.decorations);
    // Some entries are functions (from ViewPlugin decorations); resolve them.
    for (const entry of decoSets) {
      const set = typeof entry === 'function' ? entry(view) : entry;
      const iter = set.iter();
      while (iter.value) {
        const { from, to } = iter;
        const fromLine = view.state.doc.lineAt(from).to;
        // If this is a point decoration (widget/replace), from..to must not cross lines.
        // Mark decorations can span lines (CM6 allows them), so don't flag those.
        const spec: any = iter.value.spec ?? {};
        const isReplace = 'widget' in spec || spec.block === true || (to > from && !spec.class);
        if (isReplace && to > fromLine) {
          throw new Error(
            `Decoration.replace/widget spans line break at [${from}..${to}] (line ends at ${fromLine})`,
          );
        }
        iter.next();
      }
    }
  });
});
