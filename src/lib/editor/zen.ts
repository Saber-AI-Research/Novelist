import { type Range } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate, Decoration, type DecorationSet } from '@codemirror/view';

/**
 * Typewriter scrolling — keeps the cursor line vertically centered.
 */
export const typewriterPlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        const { view } = update;
        const head = view.state.selection.main.head;
        const coords = view.coordsAtPos(head);
        if (coords) {
          const editorRect = view.dom.getBoundingClientRect();
          const centerY = editorRect.top + editorRect.height / 2;
          const offset = coords.top - centerY;
          if (Math.abs(offset) > 10) {
            // Use requestAnimationFrame to avoid layout thrashing
            requestAnimationFrame(() => {
              view.scrollDOM.scrollBy({ top: offset, behavior: 'smooth' });
            });
          }
        }
      }
    }
  }
);

const dimLine = Decoration.line({ class: 'cm-novelist-zen-dim' });

/**
 * Paragraph focus — dims non-active paragraphs.
 */
export const paragraphFocusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.buildDim(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = this.buildDim(update.view);
      }
    }
    buildDim(view: EditorView): DecorationSet {
      const { state } = view;
      const cursorLine = state.doc.lineAt(state.selection.main.head).number;
      const decos: Range<Decoration>[] = [];

      // Find current paragraph boundaries (empty lines delimit paragraphs)
      let paraStart = cursorLine;
      let paraEnd = cursorLine;
      while (paraStart > 1 && state.doc.line(paraStart - 1).text.trim() !== '') paraStart--;
      while (paraEnd < state.doc.lines && state.doc.line(paraEnd + 1).text.trim() !== '') paraEnd++;

      // Dim all lines NOT in the current paragraph
      for (let i = 1; i <= state.doc.lines; i++) {
        if (i < paraStart || i > paraEnd) {
          const line = state.doc.line(i);
          decos.push(dimLine.range(line.from));
        }
      }

      return Decoration.set(decos);
    }
  },
  { decorations: (v) => v.decorations }
);
