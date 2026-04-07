import { ViewPlugin, Decoration, type DecorationSet, EditorView, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range } from '@codemirror/state';

/**
 * Check if any cursor/selection head falls within the given range.
 */
function cursorInRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some(r => r.head >= from && r.head <= to);
}

/**
 * Heading level name to CSS class mapping.
 */
const headingClasses: Record<string, string> = {
  ATXHeading1: 'cm-novelist-h1',
  ATXHeading2: 'cm-novelist-h2',
  ATXHeading3: 'cm-novelist-h3',
  ATXHeading4: 'cm-novelist-h4',
  ATXHeading5: 'cm-novelist-h5',
  ATXHeading6: 'cm-novelist-h6',
};

/**
 * Walk the visible syntax tree and build WYSIWYG decorations.
 */
function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const cursorInside = cursorInRange(state, node.from, node.to);
        const markerClass = cursorInside ? 'cm-novelist-marker-visible' : 'cm-novelist-hidden';

        // --- ATX Headings ---
        if (node.name in headingClasses) {
          const headingClass = headingClasses[node.name];
          const headingNode = node.node;

          // Find HeaderMark children (the # symbols and trailing space)
          let markerEnd = node.from;
          const cursor = headingNode.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'HeaderMark') {
                // Hide or reveal the marker
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                  );
                }
                // Track the end of markers to know where content starts
                if (cursor.to > markerEnd) {
                  markerEnd = cursor.to;
                }
              }
            } while (cursor.nextSibling());
          }

          // Also hide the space after the last # mark
          const lineText = state.doc.lineAt(node.from);
          const afterMarker = markerEnd;
          // Find the first non-space character after the marker
          let contentStart = afterMarker;
          const lineEndPos = lineText.to;
          while (contentStart < lineEndPos && state.doc.sliceString(contentStart, contentStart + 1) === ' ') {
            contentStart++;
          }
          // Hide the space between marker and content
          if (contentStart > afterMarker && afterMarker < lineEndPos) {
            decos.push(
              Decoration.mark({ class: markerClass }).range(afterMarker, contentStart)
            );
          }

          // Apply heading style to the content portion
          if (contentStart < node.to) {
            decos.push(
              Decoration.mark({ class: headingClass }).range(contentStart, node.to)
            );
          }

          return false; // Don't descend further
        }

        // --- StrongEmphasis (bold) ---
        if (node.name === 'StrongEmphasis') {
          handleInlineMarkup(node.node, state, decos, markerClass, 'cm-novelist-bold', 'EmphasisMark');
          return false;
        }

        // --- Emphasis (italic) ---
        if (node.name === 'Emphasis') {
          handleInlineMarkup(node.node, state, decos, markerClass, 'cm-novelist-italic', 'EmphasisMark');
          return false;
        }

        // --- Strikethrough ---
        if (node.name === 'Strikethrough') {
          handleInlineMarkup(node.node, state, decos, markerClass, 'cm-novelist-strikethrough', 'StrikethroughMark');
          return false;
        }

        // --- InlineCode ---
        if (node.name === 'InlineCode') {
          handleInlineMarkup(node.node, state, decos, markerClass, 'cm-novelist-inline-code', 'CodeMark');
          return false;
        }

        // --- Link ---
        if (node.name === 'Link') {
          const linkNode = node.node;
          const cursor = linkNode.cursor();
          let linkTextFrom = -1;
          let linkTextTo = -1;

          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'LinkMark') {
                // Hide [ ] ( ) markers
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                  );
                }
                // Track the text range: between first [ and first ]
                const text = state.doc.sliceString(cursor.from, cursor.to);
                if (text === '[' && linkTextFrom === -1) {
                  linkTextFrom = cursor.to;
                } else if (text === ']' && linkTextTo === -1) {
                  linkTextTo = cursor.from;
                }
              } else if (cursor.name === 'URL') {
                // Hide the URL portion
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                  );
                }
              }
            } while (cursor.nextSibling());
          }

          // Style the link text
          if (linkTextFrom >= 0 && linkTextTo > linkTextFrom) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-link-text' }).range(linkTextFrom, linkTextTo)
            );
          }

          return false;
        }

        // --- Blockquote ---
        if (node.name === 'Blockquote') {
          const bqNode = node.node;

          // Apply line decoration to each line in the blockquote
          const startLine = state.doc.lineAt(node.from).number;
          const endLine = state.doc.lineAt(node.to).number;
          for (let i = startLine; i <= endLine; i++) {
            const line = state.doc.line(i);
            decos.push(
              Decoration.line({ class: 'cm-novelist-blockquote-line' }).range(line.from)
            );
          }

          // Find and hide QuoteMark children
          const cursor = bqNode.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'QuoteMark') {
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                  );
                  // Also hide the space after >
                  const afterMark = cursor.to;
                  if (afterMark < node.to && state.doc.sliceString(afterMark, afterMark + 1) === ' ') {
                    decos.push(
                      Decoration.mark({ class: markerClass }).range(afterMark, afterMark + 1)
                    );
                  }
                }
              }
              // Recurse into children to find nested QuoteMarks
              if (cursor.firstChild()) {
                do {
                  if (cursor.name === 'QuoteMark') {
                    if (cursor.from < cursor.to) {
                      decos.push(
                        Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                      );
                      const afterMark = cursor.to;
                      if (afterMark < node.to && state.doc.sliceString(afterMark, afterMark + 1) === ' ') {
                        decos.push(
                          Decoration.mark({ class: markerClass }).range(afterMark, afterMark + 1)
                        );
                      }
                    }
                  }
                } while (cursor.nextSibling());
                cursor.parent();
              }
            } while (cursor.nextSibling());
          }

          // Don't return false — let the tree walker descend to handle
          // inline formatting inside blockquotes
          return;
        }

        // --- FencedCode ---
        if (node.name === 'FencedCode') {
          const fcNode = node.node;
          const cursorIn = cursorInRange(state, node.from, node.to);
          const fenceMarkerClass = cursorIn ? 'cm-novelist-marker-visible' : 'cm-novelist-hidden';

          // Apply line decorations for code block styling
          const startLine = state.doc.lineAt(node.from).number;
          const endLine = state.doc.lineAt(node.to).number;
          for (let i = startLine; i <= endLine; i++) {
            const line = state.doc.line(i);
            decos.push(
              Decoration.line({ class: 'cm-novelist-codeblock-line' }).range(line.from)
            );
          }

          // Hide the fence markers (``` lines) and CodeInfo
          const cursor = fcNode.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'CodeMark' || cursor.name === 'CodeInfo') {
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: fenceMarkerClass }).range(cursor.from, cursor.to)
                  );
                }
              }
            } while (cursor.nextSibling());
          }

          return false;
        }

        // --- HorizontalRule ---
        if (node.name === 'HorizontalRule') {
          const line = state.doc.lineAt(node.from);
          decos.push(
            Decoration.line({ class: 'cm-novelist-hr-widget' }).range(line.from)
          );
          // Hide the actual markers (---, ***, ___) when cursor is outside
          if (!cursorInside && node.from < node.to) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-hidden' }).range(node.from, node.to)
            );
          } else if (cursorInside && node.from < node.to) {
            decos.push(
              Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(node.from, node.to)
            );
          }
          return false;
        }

        // --- TaskMarker (checkbox in list items) ---
        if (node.name === 'TaskMarker') {
          // TaskMarker is the [ ] or [x] part
          if (node.from < node.to) {
            const text = state.doc.sliceString(node.from, node.to);
            const isChecked = text.includes('x') || text.includes('X');
            const checkboxClass = isChecked
              ? 'cm-novelist-checkbox cm-novelist-checkbox-checked'
              : 'cm-novelist-checkbox';

            decos.push(
              Decoration.mark({ class: markerClass }).range(node.from, node.to)
            );

            // When cursor is away, we still show the marker but styled as checkbox
            if (!cursorInside) {
              decos.push(
                Decoration.mark({ class: checkboxClass }).range(node.from, node.to)
              );
            }
          }
          return false;
        }
      },
    });
  }

  return Decoration.set(decos, true);
}

/**
 * Helper for inline markup nodes (bold, italic, strikethrough, inline code).
 * Finds marker children, hides/reveals them, and applies content styling.
 */
function handleInlineMarkup(
  syntaxNode: ReturnType<typeof syntaxTree>['topNode'],
  state: EditorState,
  decos: Range<Decoration>[],
  markerClass: string,
  contentClass: string,
  markerNodeName: string,
) {
  const markers: { from: number; to: number }[] = [];
  const cursor = syntaxNode.cursor();

  if (cursor.firstChild()) {
    do {
      if (cursor.name === markerNodeName) {
        markers.push({ from: cursor.from, to: cursor.to });
        if (cursor.from < cursor.to) {
          decos.push(
            Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
          );
        }
      }
    } while (cursor.nextSibling());
  }

  // Apply content style to the range between (or around) markers
  // For most inline markup, the content is the full node range
  if (syntaxNode.from < syntaxNode.to) {
    decos.push(
      Decoration.mark({ class: contentClass }).range(syntaxNode.from, syntaxNode.to)
    );
  }
}

/**
 * The WYSIWYG ViewPlugin. Rebuilds decorations on doc change, selection
 * change, or viewport change.
 */
export const wysiwygPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
