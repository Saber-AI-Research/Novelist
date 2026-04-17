/**
 * KaTeX math rendering for CodeMirror 6.
 *
 * Renders $..$ inline math and $$...$$ display math blocks using KaTeX.
 * KaTeX is lazy-loaded on first encounter of a math node.
 *
 * Architecture: display math uses Decoration.replace with block: true,
 * which CM6 requires to come from a StateField (not ViewPlugin).
 * Inline math and cursor-inside styling use a separate ViewPlugin.
 */
import {
  ViewPlugin, Decoration, type DecorationSet, EditorView,
  type ViewUpdate, WidgetType,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { StateField, type EditorState, type Range } from '@codemirror/state';
import { imeComposingField } from './ime-guard';

/* ── Lazy-loaded KaTeX ────────────────────────────────────── */

let katexModule: typeof import('katex') | null = null;
let katexLoadPromise: Promise<typeof import('katex')> | null = null;
let katexCssLoaded = false;

async function ensureKatex(): Promise<typeof import('katex')> {
  if (katexModule) return katexModule;
  if (!katexLoadPromise) {
    katexLoadPromise = import('katex').then((mod) => {
      katexModule = mod;
      return mod;
    });
  }
  return katexLoadPromise;
}

function ensureKatexCss() {
  if (katexCssLoaded) return;
  katexCssLoaded = true;
  import('katex/dist/katex.min.css');
}

/**
 * Synchronously render math if KaTeX is loaded, otherwise return null
 * and trigger async load.  The `viewRef` callback is used to dispatch
 * a no-op transaction after KaTeX finishes loading so decorations rebuild.
 */
function renderMathSync(
  tex: string,
  displayMode: boolean,
  viewRef: (() => EditorView | null) | null,
): string | null {
  if (katexModule) {
    try {
      return katexModule.default.renderToString(tex, {
        throwOnError: false,
        displayMode,
      });
    } catch {
      return `<span class="cm-novelist-math-error">Error rendering: ${tex}</span>`;
    }
  }
  // Trigger async load, then request re-measure so decorations rebuild
  ensureKatex().then(() => {
    const view = viewRef?.();
    if (view) {
      view.dispatch({});
    }
  });
  return null;
}

/* ── Inline math widget ($...$) ───────────────────────────── */

class InlineMathWidget extends WidgetType {
  constructor(private tex: string, private viewRef: () => EditorView | null) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-novelist-math-inline';

    const html = renderMathSync(this.tex, false, this.viewRef);
    if (html) {
      span.innerHTML = html;
    } else {
      span.textContent = `$${this.tex}$`;
      span.classList.add('cm-novelist-math-loading');
    }

    return span;
  }

  eq(other: InlineMathWidget): boolean {
    return this.tex === other.tex;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* ── Display math widget ($$...$$) ────────────────────────── */

class DisplayMathWidget extends WidgetType {
  constructor(private tex: string, private viewRef: () => EditorView | null) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-novelist-math-display';

    const html = renderMathSync(this.tex, true, this.viewRef);
    if (html) {
      div.innerHTML = html;
    } else {
      div.textContent = `$$${this.tex}$$`;
      div.classList.add('cm-novelist-math-loading');
    }

    return div;
  }

  eq(other: DisplayMathWidget): boolean {
    return this.tex === other.tex;
  }

  get estimatedHeight(): number { return 60; }
  ignoreEvent(): boolean { return false; }
}

/* ── Cursor helpers (reused from wysiwyg.ts pattern) ──────── */

function makeCursorSet(state: EditorState): number[] {
  return state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
}

function cursorInRangeFast(heads: number[], from: number, to: number): boolean {
  let lo = 0, hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < heads.length && heads[lo] <= to;
}

/* ── Block decorations (StateField) — display math ────────── */

// Weak ref to the active EditorView, used by widgets for lazy KaTeX reload
let _mathEditorView: EditorView | null = null;
function getMathEditorView(): EditorView | null { return _mathEditorView; }

function buildDisplayMathBlockDecos(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);
  let hasMath = false;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'DisplayMath') return;
      hasMath = true;

      if (cursorInRangeFast(cursorHeads, node.from, node.to)) return false;

      const fullText = state.doc.sliceString(node.from, node.to);
      const lines = fullText.split('\n');
      const tex = lines.slice(1, -1).join('\n').trim();

      if (tex.length > 0) {
        decos.push(
          Decoration.replace({
            widget: new DisplayMathWidget(tex, getMathEditorView),
            block: true,
          }).range(node.from, node.to)
        );
      }

      return false;
    },
  });

  if (hasMath) {
    ensureKatexCss();
    ensureKatex();
  }

  return Decoration.set(decos, true);
}

const mathBlockDecoField = StateField.define<DecorationSet>({
  create(state) { return buildDisplayMathBlockDecos(state); },
  update(value, tr) {
    if (tr.state.field(imeComposingField, false)) return value;
    if (tr.docChanged) return buildDisplayMathBlockDecos(tr.state);
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildDisplayMathBlockDecos(tr.state);
    }
    if (tr.selection) return buildDisplayMathBlockDecos(tr.state);
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

/* ── Inline/line decorations (ViewPlugin) ─────────────────── */

function buildMathInlineDecos(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);
  let hasMath = false;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        // --- Inline math $...$ ---
        if (node.name === 'InlineMath') {
          hasMath = true;
          const cursorInside = cursorInRangeFast(cursorHeads, node.from, node.to);

          if (!cursorInside) {
            const tex = state.doc.sliceString(node.from + 1, node.to - 1);
            if (tex.length > 0) {
              decos.push(
                Decoration.replace({
                  widget: new InlineMathWidget(tex, () => view),
                }).range(node.from, node.to)
              );
            }
          } else {
            // Cursor inside: show raw source with dimmed markers
            const mathNode = node.node;
            const cursor = mathNode.cursor();
            if (cursor.firstChild()) {
              do {
                if (cursor.name === 'InlineMathMark' && cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(cursor.from, cursor.to)
                  );
                }
              } while (cursor.nextSibling());
            }
            decos.push(
              Decoration.mark({ class: 'cm-novelist-math-source' }).range(node.from, node.to)
            );
          }

          return false;
        }

        // --- Display math $$...$$ (cursor-inside styling only) ---
        if (node.name === 'DisplayMath') {
          hasMath = true;
          if (!cursorInRangeFast(cursorHeads, node.from, node.to)) return false;

          // Cursor inside: show raw source with styled background
          const lineDeco = Decoration.line({ class: 'cm-novelist-math-block-line' });
          let pos = node.from;
          while (pos <= node.to) {
            const line = state.doc.lineAt(pos);
            decos.push(lineDeco.range(line.from));
            pos = line.to + 1;
          }

          // Dim the $$ delimiter lines
          const firstLine = state.doc.lineAt(node.from);
          const lastLine = state.doc.lineAt(node.to);
          if (firstLine.from < firstLine.to) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(firstLine.from, firstLine.to)
            );
          }
          if (lastLine.from !== firstLine.from && lastLine.from < lastLine.to) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(lastLine.from, lastLine.to)
            );
          }

          return false;
        }
      },
    });
  }

  if (hasMath) {
    ensureKatexCss();
    ensureKatex();
  }

  return Decoration.set(decos, true);
}

class MathInlinePluginClass {
  decorations: DecorationSet;
  private lastCursorLine = -1;
  private editorView: EditorView;

  constructor(view: EditorView) {
    this.editorView = view;
    _mathEditorView = view;
    this.decorations = buildMathInlineDecos(view);
    this.lastCursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  }

  update(update: ViewUpdate) {
    this.editorView = update.view;
    _mathEditorView = update.view;
    const wasComposing = update.startState.field(imeComposingField, false);
    const isComposing = update.state.field(imeComposingField, false);
    if (isComposing) return;

    if (update.docChanged || update.viewportChanged || (wasComposing && !isComposing)) {
      this.decorations = buildMathInlineDecos(update.view);
      this.lastCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      return;
    }

    if (update.selectionSet) {
      const newLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      if (newLine !== this.lastCursorLine) {
        this.decorations = buildMathInlineDecos(update.view);
        this.lastCursorLine = newLine;
      }
    }
  }

  destroy() {
    if (_mathEditorView === this.editorView) _mathEditorView = null;
  }
}

const mathInlinePlugin = ViewPlugin.fromClass(MathInlinePluginClass, {
  decorations: (v) => v.decorations,
});

/* ── Exported extension ──────────────────────────────────── */

export const mathPlugin = [mathBlockDecoField, mathInlinePlugin];
