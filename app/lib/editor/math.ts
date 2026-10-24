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
import { StateEffect, StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { imeComposingField } from './ime-guard';
import { isBlockContainer } from './markdown-extensions';

interface MathRange {
  from: number;
  to: number;
}

interface MathDecorationState {
  decorations: DecorationSet;
  ranges: MathRange[];
}

/* ── Lazy-loaded KaTeX ────────────────────────────────────── */

let katexModule: typeof import('katex') | null = null;
let katexLoadPromise: Promise<typeof import('katex')> | null = null;
let katexCssLoaded = false;

/** Every live editor with the math extension (one per split pane). */
const mathViews = new Set<EditorView>();
/** Dispatched to every math view once KaTeX finishes loading. */
const katexLoadedEffect = StateEffect.define<null>();

function isKatexLoaded(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(katexLoadedEffect));
}

async function ensureKatex(): Promise<typeof import('katex')> {
  if (katexModule) return katexModule;
  if (!katexLoadPromise) {
    // Lazy chunk: KaTeX is only needed once a document contains math.
    katexLoadPromise = import('katex').then((mod) => {
      katexModule = mod;
      // Widgets built while loading show `$…$` placeholders; rebuild them in
      // every pane (their `eq` includes the loaded state, so DOM is replaced).
      for (const view of mathViews) view.dispatch({ effects: katexLoadedEffect.of(null) });
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
 * Render `tex` into `el` if KaTeX is loaded. Returns false (and starts the
 * load) otherwise; the caller shows a placeholder until `katexLoadedEffect`.
 */
function renderMath(el: HTMLElement, tex: string, displayMode: boolean): boolean {
  if (!katexModule) {
    void ensureKatex();
    return false;
  }
  try {
    el.innerHTML = katexModule.default.renderToString(tex, { throwOnError: false, displayMode });
  } catch {
    const error = document.createElement('span');
    error.className = 'cm-novelist-math-error';
    error.textContent = `Error rendering: ${tex}`;
    el.replaceChildren(error);
  }
  return true;
}

/* ── Inline math widget ($...$) ───────────────────────────── */

class InlineMathWidget extends WidgetType {
  private readonly katexReady = katexModule !== null;

  constructor(private tex: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-novelist-math-inline';
    if (!renderMath(span, this.tex, false)) {
      span.textContent = `$${this.tex}$`;
      span.classList.add('cm-novelist-math-loading');
    }
    return span;
  }

  eq(other: InlineMathWidget): boolean {
    return this.tex === other.tex && this.katexReady === other.katexReady;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* ── Display math widget ($$...$$) ────────────────────────── */

class DisplayMathWidget extends WidgetType {
  private readonly katexReady = katexModule !== null;

  constructor(private tex: string) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-novelist-math-display';
    if (!renderMath(div, this.tex, true)) {
      div.textContent = `$$${this.tex}$$`;
      div.classList.add('cm-novelist-math-loading');
    }
    return div;
  }

  eq(other: DisplayMathWidget): boolean {
    return this.tex === other.tex && this.katexReady === other.katexReady;
  }

  get estimatedHeight(): number { return 60; }
  ignoreEvent(): boolean { return false; }
}

/* ── Selection helpers ───────────────────────────────────── */

function selectionTouchesRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((selection) => {
    if (selection.empty) {
      // Include both delimiters. This lets the first ArrowLeft/ArrowRight
      // landing on a rendered formula boundary reveal its editable source.
      return selection.from >= from && selection.from <= to;
    }

    // A Shift+Arrow selection whose active end just reached a delimiter must
    // reveal the source before the next keypress, or visual cursor motion will
    // skip across the replacement widget as one unit.
    if (selection.head === from || selection.head === to) return true;

    // Non-empty selections use half-open overlap semantics so a selection
    // merely adjacent to a formula does not expand it.
    return selection.from < to && selection.to > from;
  });
}

function selectionTouchesRanges(state: EditorState, ranges: readonly MathRange[]): boolean {
  return ranges.some(range => selectionTouchesRange(state, range.from, range.to));
}

/* ── Block decorations (StateField) — display math ────────── */

function buildDisplayMathBlockState(state: EditorState): MathDecorationState {
  const decos: Range<Decoration>[] = [];
  const ranges: MathRange[] = [];
  let hasMath = false;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'DisplayMath') return isBlockContainer(node.name);
      hasMath = true;
      ranges.push({ from: node.from, to: node.to });

      if (selectionTouchesRange(state, node.from, node.to)) return false;

      const fullText = state.doc.sliceString(node.from, node.to);
      const lines = fullText.split('\n');
      const tex = lines.slice(1, -1).join('\n').trim();

      if (tex.length > 0) {
        decos.push(
          Decoration.replace({
            widget: new DisplayMathWidget(tex),
            block: true,
          }).range(node.from, node.to)
        );
      }

      return false;
    },
  });

  if (hasMath) {
    ensureKatexCss();
    void ensureKatex();
  }

  return { decorations: Decoration.set(decos, true), ranges };
}

const mathBlockDecoField = StateField.define<MathDecorationState>({
  create(state) { return buildDisplayMathBlockState(state); },
  update(value, tr) {
    if (tr.docChanged || isKatexLoaded(tr)) return buildDisplayMathBlockState(tr.state);
    if (tr.state.field(imeComposingField, false)) return value;
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildDisplayMathBlockState(tr.state);
    }
    if (
      tr.selection &&
      (selectionTouchesRanges(tr.startState, value.ranges) ||
        selectionTouchesRanges(tr.state, value.ranges))
    ) {
      return buildDisplayMathBlockState(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f, value => value.decorations),
});

/* ── Inline/line decorations (ViewPlugin) ─────────────────── */

function buildMathInlineState(view: EditorView): MathDecorationState {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const ranges: MathRange[] = [];
  let hasMath = false;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        // Code never contains math; skip its (possibly nested-language) subtree.
        if (node.name === 'FencedCode' || node.name === 'CodeBlock') return false;

        // --- Inline math $...$ ---
        if (node.name === 'InlineMath') {
          hasMath = true;
          ranges.push({ from: node.from, to: node.to });
          const selectionTouches = selectionTouchesRange(state, node.from, node.to);

          if (!selectionTouches) {
            const tex = state.doc.sliceString(node.from + 1, node.to - 1);
            // Defensive: CM6 forbids ViewPlugin Decoration.replace that crosses
            // a line break. InlineMath should never cross lines per the parser,
            // but during IME composition the incremental tree can briefly
            // contain a malformed InlineMath whose node.to is past the line
            // end. Clamp to the line containing node.from and skip if the
            // clamped range would be empty (widget would render nothing useful).
            const lineEnd = state.doc.lineAt(node.from).to;
            const endClamped = Math.min(node.to, lineEnd);
            if (tex.length > 0 && endClamped > node.from && endClamped === node.to) {
              decos.push(
                Decoration.replace({
                  widget: new InlineMathWidget(tex),
                }).range(node.from, endClamped)
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
          ranges.push({ from: node.from, to: node.to });
          if (!selectionTouchesRange(state, node.from, node.to)) return false;

          // Cursor inside: show raw source with styled background. Only the
          // visible part of a long block gets line decorations.
          const lineDeco = Decoration.line({ class: 'cm-novelist-math-block-line' });
          const end = Math.min(node.to, to);
          for (let pos = Math.max(node.from, from); pos <= end;) {
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
    void ensureKatex();
  }

  return {
    decorations: Decoration.set(decos, true),
    ranges,
  };
}

class MathInlinePluginClass {
  decorations: DecorationSet;
  private ranges: MathRange[];

  constructor(private view: EditorView) {
    mathViews.add(view);
    const state = buildMathInlineState(view);
    this.decorations = state.decorations;
    this.ranges = state.ranges;
  }

  update(update: ViewUpdate) {
    const wasComposing = update.startState.field(imeComposingField, false);
    const isComposing = update.state.field(imeComposingField, false);

    // Rebuild on doc change even during IME — same reasoning as wysiwyg.ts:
    // if we skip and let CM6 map the DecorationSet through a composition
    // that inserts a newline inside a `$...$` replace range, the mapped
    // decoration now crosses a line and CM6 throws RangeError on the next
    // render. Rebuilding produces a fresh set consistent with the new doc.
    if (
      update.docChanged || update.viewportChanged || (wasComposing && !isComposing) ||
      update.transactions.some(isKatexLoaded)
    ) {
      this.rebuild(update.view);
      return;
    }

    if (isComposing) return;

    if (syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.rebuild(update.view);
      return;
    }

    if (
      update.selectionSet &&
      (selectionTouchesRanges(update.startState, this.ranges) ||
        selectionTouchesRanges(update.state, this.ranges))
    ) {
      this.rebuild(update.view);
    }
  }

  private rebuild(view: EditorView) {
    const state = buildMathInlineState(view);
    this.decorations = state.decorations;
    this.ranges = state.ranges;
  }

  destroy() {
    mathViews.delete(this.view);
  }
}

const mathInlinePlugin = ViewPlugin.fromClass(MathInlinePluginClass, {
  decorations: (v) => v.decorations,
});

/* ── Exported extension ──────────────────────────────────── */

export const mathPlugin = [mathBlockDecoField, mathInlinePlugin];
