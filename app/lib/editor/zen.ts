import { type Range } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate, Decoration, type DecorationSet } from '@codemirror/view';

/**
 * Typewriter scrolling — keeps the cursor line vertically centered.
 * Uses instant scroll to avoid fighting with typing cadence.
 */
export const typewriterPlugin = ViewPlugin.fromClass(
  class {
    private raf: number | null = null;

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        if (this.raf !== null) cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(() => {
          this.raf = null;
          const { view } = update;
          const head = view.state.selection.main.head;
          const coords = view.coordsAtPos(head);
          if (coords) {
            const editorRect = view.dom.getBoundingClientRect();
            const centerY = editorRect.top + editorRect.height / 2;
            const offset = coords.top - centerY;
            if (Math.abs(offset) > 10) {
              view.scrollDOM.scrollBy({ top: offset, behavior: 'instant' });
            }
          }
        });
      }
    }

    destroy() {
      if (this.raf !== null) cancelAnimationFrame(this.raf);
    }
  }
);

const dimLine = Decoration.line({ class: 'cm-novelist-zen-dim' });

/**
 * Paragraph focus — dims non-active paragraphs.
 *
 * Optimizations vs original:
 * - Caches paragraph boundaries; skips rebuild if cursor is in the same paragraph
 * - Does NOT call view.requestMeasure() (let CM6 schedule its own layout)
 * - Only processes visible lines
 */
export const paragraphFocusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private pending: number | null = null;
    private lastParaStart = -1;
    private lastParaEnd = -1;

    constructor(view: EditorView) {
      this.decorations = this.buildDim(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        // Doc or viewport changed — must rebuild
        this.lastParaStart = -1;
        this.scheduleBuild(update.view);
        return;
      }

      if (update.selectionSet) {
        // Only rebuild if cursor moved to a different paragraph
        const { state } = update.view;
        const cursorLine = state.doc.lineAt(state.selection.main.head).number;
        if (cursorLine >= this.lastParaStart && cursorLine <= this.lastParaEnd) {
          return; // Still in same paragraph — skip rebuild
        }
        this.scheduleBuild(update.view);
      }
    }

    private scheduleBuild(view: EditorView) {
      if (this.pending !== null) cancelAnimationFrame(this.pending);
      this.pending = requestAnimationFrame(() => {
        this.pending = null;
        this.decorations = this.buildDim(view);
      });
    }

    buildDim(view: EditorView): DecorationSet {
      const { state } = view;
      const cursorLine = state.doc.lineAt(state.selection.main.head).number;
      const decos: Range<Decoration>[] = [];

      // Find current paragraph boundaries
      let paraStart = cursorLine;
      let paraEnd = cursorLine;
      while (paraStart > 1 && state.doc.line(paraStart - 1).text.trim() !== '') paraStart--;
      while (paraEnd < state.doc.lines && state.doc.line(paraEnd + 1).text.trim() !== '') paraEnd++;

      // Cache for fast same-paragraph check
      this.lastParaStart = paraStart;
      this.lastParaEnd = paraEnd;

      // Only dim VISIBLE lines outside the current paragraph
      for (const { from, to } of view.visibleRanges) {
        const startLine = state.doc.lineAt(from).number;
        const endLine = state.doc.lineAt(to).number;
        for (let i = startLine; i <= endLine; i++) {
          if (i < paraStart || i > paraEnd) {
            decos.push(dimLine.range(state.doc.line(i).from));
          }
        }
      }

      return Decoration.set(decos, true);
    }

    destroy() {
      if (this.pending !== null) cancelAnimationFrame(this.pending);
    }
  },
  { decorations: (v) => v.decorations }
);
