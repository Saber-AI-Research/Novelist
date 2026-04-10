import { ViewPlugin, Decoration, type DecorationSet, EditorView, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { imeComposingField } from './ime-guard';

/**
 * Widget that renders an inline image preview below the markdown line.
 */
class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string, private projectDir: string) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-novelist-image-widget';

    const img = document.createElement('img');
    // Resolve relative paths against project directory
    if (this.src.startsWith('http://') || this.src.startsWith('https://') || this.src.startsWith('data:')) {
      img.src = this.src;
    } else {
      // Local file — use Tauri's asset protocol or file://
      const resolved = this.projectDir
        ? `${this.projectDir}/${this.src}`
        : this.src;
      img.src = `https://asset.localhost/${encodeURIComponent(resolved)}`;
    }
    img.alt = this.alt;
    img.loading = 'lazy';
    img.onerror = () => {
      wrapper.innerHTML = '';
      const err = document.createElement('span');
      err.className = 'cm-novelist-image-error';
      err.textContent = `Image not found: ${this.src}`;
      wrapper.appendChild(err);
    };
    wrapper.appendChild(img);

    if (this.alt) {
      const caption = document.createElement('div');
      caption.className = 'cm-novelist-image-alt';
      caption.textContent = this.alt;
      wrapper.appendChild(caption);
    }

    return wrapper;
  }

  eq(other: ImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt;
  }

  get estimatedHeight(): number { return 200; }
  ignoreEvent(): boolean { return false; }
}

/**
 * Pre-compute cursor positions into a sorted array for fast range checks.
 * Avoids re-iterating state.selection.ranges on every node.
 */
function makeCursorSet(state: EditorState): number[] {
  return state.selection.ranges.map(r => r.head).sort((a, b) => a - b);
}

function cursorInRangeFast(heads: number[], from: number, to: number): boolean {
  // Binary search for first head >= from
  let lo = 0, hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < heads.length && heads[lo] <= to;
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
/** Project directory for resolving relative image paths. Set by Editor.svelte. */
let _projectDir = '';
export function setWysiwygProjectDir(dir: string) { _projectDir = dir; }

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);
  const projectDir = _projectDir;

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const cursorInside = cursorInRangeFast(cursorHeads, node.from, node.to);
        const markerClass = cursorInside ? 'cm-novelist-marker-visible' : 'cm-novelist-hidden';

        // --- ATX Headings ---
        // NOTE: Heading font-sizes are applied via syntaxHighlighting (setup.ts),
        // NOT via mark decorations here. This is critical: mark decorations only
        // cover visible ranges, so heading lines outside the viewport would lose
        // their font-size → CM6's cached line heights become stale → click-after-
        // scroll lands on the wrong line.  syntaxHighlighting is driven by the
        // incremental parser and applies consistently regardless of viewport.
        //
        // This block only handles marker hiding (# symbols + trailing space).
        if (node.name in headingClasses) {
          const headingNode = node.node;

          // Find HeaderMark children (the # symbols)
          let markerEnd = node.from;
          const cursor = headingNode.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'HeaderMark') {
                if (cursor.from < cursor.to) {
                  if (cursorInside) {
                    // Cursor on heading line: show markers with reduced opacity
                    decos.push(
                      Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(cursor.from, cursor.to)
                    );
                  } else {
                    // Cursor elsewhere: collapse markers to zero width (Typora-style)
                    decos.push(Decoration.replace({}).range(cursor.from, cursor.to));
                  }
                }
                if (cursor.to > markerEnd) {
                  markerEnd = cursor.to;
                }
              }
            } while (cursor.nextSibling());
          }

          // Also handle the space between # marks and heading text.
          const afterMarker = markerEnd;
          const lineEndPos = state.doc.lineAt(node.from).to;
          const maxSpaces = Math.min(lineEndPos - afterMarker, 4);
          let contentStart = afterMarker;
          if (maxSpaces > 0) {
            const chunk = state.doc.sliceString(afterMarker, afterMarker + maxSpaces);
            while (contentStart - afterMarker < chunk.length && chunk[contentStart - afterMarker] === ' ') {
              contentStart++;
            }
          }
          if (contentStart > afterMarker && afterMarker < lineEndPos) {
            if (cursorInside) {
              decos.push(
                Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(afterMarker, contentStart)
              );
            } else {
              decos.push(Decoration.replace({}).range(afterMarker, contentStart));
            }
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
          let linkMarkCount = 0;

          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'LinkMark') {
                if (cursor.from < cursor.to) {
                  decos.push(
                    Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                  );
                }
                // First LinkMark is "[", second is "]" — use count instead of sliceString
                linkMarkCount++;
                if (linkMarkCount === 1) {
                  linkTextFrom = cursor.to;
                } else if (linkMarkCount === 2) {
                  linkTextTo = cursor.from;
                }
              } else if (cursor.name === 'URL') {
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

          // Apply line decorations using iterRange (avoids repeated line-number lookups)
          const bqDeco = Decoration.line({ class: 'cm-novelist-blockquote-line' });
          let pos = node.from;
          while (pos <= node.to) {
            const line = state.doc.lineAt(pos);
            decos.push(bqDeco.range(line.from));
            pos = line.to + 1;
          }

          // Find and hide QuoteMark children (including nested)
          // Use a recursive tree cursor walk to find all QuoteMarks
          const cursor = bqNode.cursor();
          const hideQuoteMark = (c: typeof cursor) => {
            if (c.from < c.to) {
              decos.push(Decoration.mark({ class: markerClass }).range(c.from, c.to));
              // Hide trailing space after > (single sliceString, max 1 char)
              const after = c.to;
              if (after < node.to && state.doc.sliceString(after, after + 1) === ' ') {
                decos.push(Decoration.mark({ class: markerClass }).range(after, after + 1));
              }
            }
          };
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'QuoteMark') hideQuoteMark(cursor);
              // One level of nesting for nested blockquotes
              if (cursor.firstChild()) {
                do {
                  if (cursor.name === 'QuoteMark') hideQuoteMark(cursor);
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
          const cursorIn = cursorInRangeFast(cursorHeads, node.from, node.to);
          const fenceMarkerClass = cursorIn ? 'cm-novelist-marker-visible' : 'cm-novelist-hidden';

          // Apply line decorations — walk by position to avoid line-number lookups
          const codeDeco = Decoration.line({ class: 'cm-novelist-codeblock-line' });
          let codePos = node.from;
          while (codePos <= node.to) {
            const line = state.doc.lineAt(codePos);
            decos.push(codeDeco.range(line.from));
            codePos = line.to + 1;
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
          if (node.from < node.to) {
            const text = state.doc.sliceString(node.from, node.to);
            const isChecked = text.includes('x') || text.includes('X');
            const checkboxClass = isChecked
              ? 'cm-novelist-checkbox cm-novelist-checkbox-checked'
              : 'cm-novelist-checkbox';

            decos.push(
              Decoration.mark({ class: markerClass }).range(node.from, node.to)
            );

            if (!cursorInside) {
              decos.push(
                Decoration.mark({ class: checkboxClass }).range(node.from, node.to)
              );
            }
          }
          return false;
        }

        // --- Image ![alt](url) ---
        // NOTE: We do NOT use block widgets for image preview.
        // Block widgets add height that only exists in the viewport,
        // causing CM6's height estimate for off-screen lines to drift
        // cumulatively — click-after-scroll lands on the wrong line
        // in documents >1000 lines. Instead, we style the image syntax
        // as a link-like element (hide URL, show alt text styled).
        if (node.name === 'Image') {
          if (!cursorInside) {
            // Find URL and alt text
            let imgUrl = '';
            const imgCursor = node.node.cursor();
            if (imgCursor.firstChild()) {
              do {
                if (imgCursor.name === 'URL') {
                  imgUrl = state.doc.sliceString(imgCursor.from, imgCursor.to);
                }
              } while (imgCursor.nextSibling());
            }

            // Hide everything except alt text: hide ![, ](url)
            // Find the ranges: ![alt](url)
            const fullText = state.doc.sliceString(node.from, node.to);
            const bangBracket = node.from; // position of !
            const altStart = node.from + 2; // after ![
            const closeBracketIdx = fullText.indexOf(']');
            if (closeBracketIdx > 0) {
              const altEnd = node.from + closeBracketIdx;
              // Hide "!["
              if (bangBracket < altStart) {
                decos.push(Decoration.mark({ class: 'cm-novelist-hidden' }).range(bangBracket, altStart));
              }
              // Style alt text as image indicator
              if (altStart < altEnd) {
                decos.push(Decoration.mark({ class: 'cm-novelist-image-inline' }).range(altStart, altEnd));
              }
              // Hide "](url)"
              if (altEnd < node.to) {
                decos.push(Decoration.mark({ class: 'cm-novelist-hidden' }).range(altEnd, node.to));
              }
            }
          } else {
            // Cursor inside — show raw syntax with dimmed markers
            decos.push(
              Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(node.from, node.to)
            );
          }
          return false;
        }

        // --- Table (GFM) — apply monospace styling for alignment ---
        if (node.name === 'Table') {
          const tableDeco = Decoration.line({ class: 'cm-novelist-table-line' });
          let tPos = node.from;
          while (tPos <= node.to) {
            const line = state.doc.lineAt(tPos);
            decos.push(tableDeco.range(line.from));
            tPos = line.to + 1;
          }
          // Don't return false — allow inline formatting inside table cells
          return;
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
 * change, or viewport change. Skips rebuilds during IME composition,
 * then forces a rebuild once composition ends.
 *
 * All rebuilds are synchronous — deferring to rAF causes CM6 to settle
 * scroll/layout before decoration changes take effect, leading to visible
 * jumps when heading font-sizes or hidden markers change line heights.
 */
class WysiwygPluginClass {
  decorations: DecorationSet;
  private lastCursorLine = -1;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
    this.lastCursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  }

  update(update: ViewUpdate) {
    const wasComposing = update.startState.field(imeComposingField, false);
    const isComposing = update.state.field(imeComposingField, false);

    // Skip during active IME composition
    if (isComposing) return;

    // Always rebuild on doc change, viewport change, or composition end
    if (update.docChanged || update.viewportChanged || (wasComposing && !isComposing)) {
      this.decorations = buildDecorations(update.view);
      this.lastCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      return;
    }

    // For selection-only changes: skip rebuild if cursor stayed on the same line.
    if (update.selectionSet) {
      const newLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      if (newLine !== this.lastCursorLine) {
        this.decorations = buildDecorations(update.view);
        this.lastCursorLine = newLine;
      }
    }
  }
}

export const wysiwygPlugin = ViewPlugin.fromClass(WysiwygPluginClass, {
  decorations: (v) => v.decorations,
});

/**
 * Cmd+Click on links to open in browser.
 * Walks the syntax tree at click position to find a Link node with URL child.
 */
export const linkClickPlugin = EditorView.domEventHandlers({
  click(event: MouseEvent, view: EditorView) {
    if (!(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;

    // Walk syntax tree at click position looking for a Link ancestor
    let url = '';
    syntaxTree(view.state).iterate({
      from: pos, to: pos,
      enter(node) {
        if (node.name === 'URL') {
          url = view.state.doc.sliceString(node.from, node.to);
        }
        if (node.name === 'Link' || node.name === 'Image') {
          // Continue into children to find URL
        }
      },
    });

    if (url) {
      // Ensure it has a protocol
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
      window.open(url, '_blank');
      event.preventDefault();
      return true;
    }
    return false;
  },
});

/**
 * Image paste handler — when user pastes an image from clipboard,
 * save it to .novelist/images/ and insert markdown reference.
 */
export const imagePastePlugin = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, view: EditorView) {
    const items = event.clipboardData?.items;
    if (!items || !_projectDir) return false;

    let hasImage = false;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      hasImage = true;

      event.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;

      const ext = file.type.split('/')[1] || 'png';
      const timestamp = Date.now();
      const filename = `paste-${timestamp}.${ext}`;
      const projectDir = _projectDir;

      (async () => {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);

          const imagesDir = `${projectDir}/.novelist/images`;
          await invoke('create_directory', {
            parentDir: `${projectDir}/.novelist`,
            name: 'images',
          }).catch(() => {});

          const imgPath = `${imagesDir}/${filename}`;
          await invoke('write_file', {
            path: imgPath,
            content: Array.from(bytes).map(b => String.fromCharCode(b)).join(''),
          });

          const pos = view.state.selection.main.head;
          const mdText = `![pasted image](.novelist/images/${filename})`;
          view.dispatch({
            changes: { from: pos, insert: mdText },
            selection: { anchor: pos + mdText.length },
          });
        } catch (err) {
          console.error('[ImagePaste] Failed:', err);
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const pos = view.state.selection.main.head;
            const mdText = `![pasted image](${dataUrl})`;
            view.dispatch({
              changes: { from: pos, insert: mdText },
              selection: { anchor: pos + mdText.length },
            });
          };
          reader.readAsDataURL(file);
        }
      })();

      break;
    }
    return hasImage || undefined;
  },

  drop(event: DragEvent, view: EditorView) {
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0 || !_projectDir) return false;

    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return false;

    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const projectDir = _projectDir;

    (async () => {
      let insertText = '';
      for (const file of imageFiles) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const timestamp = Date.now();
        const filename = `${timestamp}-${safeName}`;

        try {
          const arrayBuffer = await file.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);

          const imagesDir = `${projectDir}/.novelist/images`;
          await invoke('create_directory', {
            parentDir: `${projectDir}/.novelist`,
            name: 'images',
          }).catch(() => {});

          const imgPath = `${imagesDir}/${filename}`;
          await invoke('write_file', {
            path: imgPath,
            content: Array.from(bytes).map(b => String.fromCharCode(b)).join(''),
          });

          insertText += `![${file.name}](.novelist/images/${filename})\n`;
        } catch (err) {
          console.error('[ImageDrop] Failed:', err);
        }
      }

      if (insertText) {
        view.dispatch({
          changes: { from: pos, insert: insertText },
          selection: { anchor: pos + insertText.length },
        });
      }
    })();

    return true;
  },
});
