import { ViewPlugin, Decoration, type DecorationSet, EditorView, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateField } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { imeComposingField } from './ime-guard';

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const _imageCache = new Map<string, { dataUri: string; ts: number }>();
const IMAGE_CACHE_MAX = 64;
const IMAGE_CACHE_TTL = 30_000; // 30s — re-fetch if image file was replaced

function cacheImage(path: string, dataUri: string) {
  if (_imageCache.size >= IMAGE_CACHE_MAX) {
    const first = _imageCache.keys().next().value!;
    _imageCache.delete(first);
  }
  _imageCache.set(path, { dataUri, ts: Date.now() });
}

function getCachedImage(path: string): string | undefined {
  const entry = _imageCache.get(path);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > IMAGE_CACHE_TTL) {
    _imageCache.delete(path);
    return undefined;
  }
  return entry.dataUri;
}

/**
 * Widget that renders an inline image preview below the markdown line.
 * Local images are loaded via Tauri IPC (read_image_data_uri) which returns
 * a base64 data URI, bypassing the need for the asset protocol feature.
 */
class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string, private projectDir: string) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-novelist-image-widget';

    const img = document.createElement('img');
    img.alt = this.alt;

    // After image loads, tell CM6 to re-measure the height map so that
    // posAtCoords (click → position) accounts for the actual image height
    // instead of the static estimatedHeight.
    img.onload = () => {
      // Force CM6 to fully re-measure block heights after async image load.
      // requestMeasure() alone may skip measureVisibleLineHeights if it
      // doesn't detect a contentDOM height change. A zero-effect dispatch
      // forces a full update cycle that re-reads all block widget heights.
      view.requestMeasure();
      view.dispatch({ effects: [] });
    };
    img.onerror = () => {
      wrapper.innerHTML = '';
      const err = document.createElement('span');
      err.className = 'cm-novelist-image-error';
      err.textContent = `Image not found: ${this.src}`;
      wrapper.appendChild(err);
      view.requestMeasure();
      view.dispatch({ effects: [] });
    };

    if (this.src.startsWith('http://') || this.src.startsWith('https://') || this.src.startsWith('data:')) {
      img.src = this.src;
    } else {
      // Local file — resolve path and load via IPC
      const resolved = this.projectDir
        ? `${this.projectDir}/${this.src}`
        : this.src;
      const cached = getCachedImage(resolved);
      if (cached) {
        img.src = cached;
      } else {
        invoke<string>('read_image_data_uri', { path: resolved }).then(dataUri => {
          cacheImage(resolved, dataUri);
          img.src = dataUri;
        }).catch(() => {
          img.dispatchEvent(new Event('error'));
        });
      }
    }

    wrapper.appendChild(img);

    if (this.alt) {
      const caption = document.createElement('div');
      caption.className = 'cm-novelist-image-alt';
      caption.textContent = this.alt;
      wrapper.appendChild(caption);
    }

    const imgSrc = this.src;
    const imgAlt = this.alt;
    const projDir = this.projectDir;
    const isLocalImg = !imgSrc.startsWith('http://') && !imgSrc.startsWith('https://') && !imgSrc.startsWith('data:');

    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.cm-image-context-menu').forEach(el => el.remove());
      const pos = view.posAtDOM(wrapper);
      const line = view.state.doc.lineAt(pos);
      new ImageContextMenu(view, imgSrc, imgAlt, line.from, line.to, e.clientX, e.clientY, isLocalImg, projDir);
    });

    return wrapper;
  }

  eq(other: ImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt && this.projectDir === other.projectDir;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.className !== 'cm-novelist-image-widget') return false;
    const img = dom.querySelector('img');
    if (!img) return false;
    // Re-attach onload to update CM6 height map after images load
    img.onload = () => { view.requestMeasure(); view.dispatch({ effects: [] }); };
    return true;
  }

  get estimatedHeight(): number { return 200; }
  ignoreEvent(event: Event): boolean {
    return event.type === 'contextmenu';
  }
}

class ImageContextMenu {
  private dom: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;

  constructor(
    private view: EditorView,
    private imgSrc: string,
    private imgAlt: string,
    private lineFrom: number,
    private lineTo: number,
    clientX: number,
    clientY: number,
    private isLocal: boolean,
    private projectDir: string,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'cm-image-context-menu';

    const items: { label: string; action: () => void; danger?: boolean; separator?: boolean }[] = [
      {
        label: 'Copy Image Path',
        action: () => {
          navigator.clipboard.writeText(this.imgSrc).catch(console.error);
          this.destroy();
        },
      },
    ];

    if (this.isLocal && this.projectDir) {
      items.push({
        label: 'Reveal in Finder',
        action: () => {
          const fullPath = `${this.projectDir}/${this.imgSrc}`;
          invoke('reveal_in_file_manager', { path: fullPath }).catch(console.error);
          this.destroy();
        },
      });
    }

    if (this.imgSrc.startsWith('http://') || this.imgSrc.startsWith('https://')) {
      items.push({
        label: 'Open in Browser',
        action: () => {
          window.open(this.imgSrc, '_blank');
          this.destroy();
        },
      });
    }

    items.push(
      { label: '', action: () => {}, separator: true },
      {
        label: 'Edit Caption',
        action: () => {
          const lineText = this.view.state.doc.sliceString(this.lineFrom, this.lineTo);
          const altStart = lineText.indexOf('![');
          if (altStart >= 0) {
            const from = this.lineFrom + altStart + 2;
            const closeBracket = lineText.indexOf(']', altStart);
            const to = closeBracket >= 0 ? this.lineFrom + closeBracket : from;
            this.view.dispatch({ selection: { anchor: from, head: to } });
            this.view.focus();
          }
          this.destroy();
        },
      },
      {
        label: 'Delete Image',
        danger: true,
        action: () => {
          const line = this.view.state.doc.lineAt(this.lineFrom);
          const deleteTo = Math.min(line.to + 1, this.view.state.doc.length);
          this.view.dispatch({ changes: { from: line.from, to: deleteTo } });
          this.destroy();
        },
      },
    );

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'cm-image-context-menu-separator';
        this.dom.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'cm-image-context-menu-item' + (item.danger ? ' cm-image-context-menu-item-danger' : '');
      el.textContent = item.label;
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        item.action();
      });
      this.dom.appendChild(el);
    }

    this.dom.style.left = `${clientX}px`;
    this.dom.style.top = `${clientY}px`;
    document.body.appendChild(this.dom);

    requestAnimationFrame(() => {
      if (!this.dom) return;
      const rect = this.dom.getBoundingClientRect();
      if (rect.bottom > window.innerHeight) {
        this.dom.style.top = `${clientY - rect.height}px`;
      }
      if (rect.right > window.innerWidth) {
        this.dom.style.left = `${clientX - rect.width}px`;
      }
    });

    const onClickOutside = (e: MouseEvent) => {
      if (this.dom && !this.dom.contains(e.target as Node)) {
        this.destroy();
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.destroy();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onEscape);
    }, 0);
    this.cleanup = () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }

  destroy() {
    this.cleanup?.();
    this.cleanup = null;
    if (this.dom) { this.dom.remove(); this.dom = null; }
  }
}

/**
 * Widget that renders a visual checkbox for task list items.
 * Clicking toggles between [ ] and [x] in the document.
 */
class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean, private pos: number) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-novelist-checkbox-widget' + (this.checked ? ' cm-novelist-checkbox-widget-checked' : '');
    span.setAttribute('aria-checked', String(this.checked));
    span.setAttribute('role', 'checkbox');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');

    if (this.checked) {
      // Filled checkbox with checkmark
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '1');
      rect.setAttribute('y', '1');
      rect.setAttribute('width', '14');
      rect.setAttribute('height', '14');
      rect.setAttribute('rx', '3');
      rect.setAttribute('fill', 'var(--novelist-accent, #4a9eff)');
      svg.appendChild(rect);

      const check = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      check.setAttribute('d', 'M4.5 8L7 10.5L11.5 5.5');
      check.setAttribute('stroke', '#fff');
      check.setAttribute('stroke-width', '1.8');
      check.setAttribute('stroke-linecap', 'round');
      check.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(check);
    } else {
      // Empty checkbox
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', '1.5');
      rect.setAttribute('y', '1.5');
      rect.setAttribute('width', '13');
      rect.setAttribute('height', '13');
      rect.setAttribute('rx', '2.5');
      rect.setAttribute('stroke', 'var(--novelist-text-secondary, #888)');
      rect.setAttribute('stroke-width', '1.2');
      svg.appendChild(rect);
    }

    span.appendChild(svg);

    // Toggle on click
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const newText = this.checked ? '[ ]' : '[x]';
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 3, insert: newText },
      });
    });

    return span;
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked && this.pos === other.pos;
  }

  ignoreEvent(event: Event): boolean {
    // Allow mousedown to pass through for toggling
    return event.type !== 'mousedown';
  }
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

/** Whether to render inline image previews. Set by Editor.svelte based on settings + project type. */
let _renderImages = true;
export function setWysiwygRenderImages(enabled: boolean) { _renderImages = enabled; }

/**
 * Build block-level image decorations from the full document syntax tree.
 * Provided via a StateField (direct DecorationSet) so CM6 accounts for
 * block widget heights in its height map — fixing click-position errors.
 *
 * Uses a single Decoration.replace({block: true, widget}) to replace the
 * entire image line (line.from..line.to) with the rendered image widget.
 * This produces one block entry in CM6's height map whose height equals
 * the rendered widget, so posAtCoords maps click coordinates correctly.
 *
 * Full-document scan is acceptable: WYSIWYG is only enabled for docs
 * < 5000 lines, and Image nodes are rare (typically 0-20 per doc).
 */
function buildImageBlockDecos(state: EditorState): DecorationSet {
  if (!_renderImages) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const projectDir = _projectDir;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Image') return;

      let imgUrl = '';
      let imgAlt = '';
      const imgCursor = node.node.cursor();
      if (imgCursor.firstChild()) {
        do {
          if (imgCursor.name === 'URL') {
            imgUrl = state.doc.sliceString(imgCursor.from, imgCursor.to);
          }
        } while (imgCursor.nextSibling());
      }
      const fullText = state.doc.sliceString(node.from, node.to);
      const closeBracketIdx = fullText.indexOf(']');
      if (closeBracketIdx > 0) {
        imgAlt = fullText.slice(2, closeBracketIdx);
      }

      if (imgUrl) {
        const line = state.doc.lineAt(node.from);
        decos.push(Decoration.replace({
          widget: new ImageWidget(imgUrl, imgAlt, projectDir),
          block: true,
        }).range(line.from, line.to));
      }
    }
  });

  return Decoration.set(decos, true);
}

const imageBlockDecoField = StateField.define<DecorationSet>({
  create(state) { return buildImageBlockDecos(state); },
  update(value, tr) {
    if (tr.state.field(imeComposingField, false)) return value;
    if (tr.docChanged) return buildImageBlockDecos(tr.state);
    // Rebuild when the incremental parser finishes.
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildImageBlockDecos(tr.state);
    }
    // No selection-based rebuild — toggling block decorations on cursor
    // change causes height-map oscillation (see buildImageBlockDecos).
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const decos: Range<Decoration>[] = [];
  const cursorHeads = makeCursorSet(state);

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

            if (!cursorInside) {
              // Hide the ListMark ("- ") before the checkbox
              const listItem = node.node.parent;
              if (listItem) {
                const listMark = listItem.getChild('ListMark');
                if (listMark && listMark.from < listMark.to) {
                  decos.push(Decoration.replace({}).range(listMark.from, listMark.to));
                  // Also hide whitespace between ListMark and TaskMarker
                  if (listMark.to < node.from) {
                    decos.push(Decoration.replace({}).range(listMark.to, node.from));
                  }
                }
              }

              // Replace [ ]/[x] with a visual checkbox widget
              decos.push(
                Decoration.replace({
                  widget: new CheckboxWidget(isChecked, node.from),
                }).range(node.from, node.to)
              );

              // Apply strikethrough to the content after the checkbox for checked items
              if (isChecked && node.to < (node.node.parent?.to ?? node.to)) {
                const contentStart = node.to;
                const contentEnd = node.node.parent?.to ?? node.to;
                // Only apply on the first line of the list item
                const line = state.doc.lineAt(node.from);
                const lineContentEnd = Math.min(contentEnd, line.to);
                if (contentStart < lineContentEnd) {
                  decos.push(
                    Decoration.mark({ class: 'cm-novelist-task-checked' }).range(contentStart, lineContentEnd)
                  );
                }
              }
            } else {
              // Cursor on the line — show raw syntax with reduced opacity
              decos.push(
                Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(node.from, node.to)
              );
            }
          }
          return false;
        }

        // --- Image ![alt](url) ---
        if (node.name === 'Image') {
          if (!_renderImages) {
            const fullText = state.doc.sliceString(node.from, node.to);
            const closeBracketIdx = fullText.indexOf(']');
            if (closeBracketIdx > 0) {
              const bangBracket = node.from;
              const altStart = node.from + 2;
              const altEnd = node.from + closeBracketIdx;
              if (bangBracket < altStart) {
                decos.push(Decoration.mark({ class: 'cm-novelist-hidden' }).range(bangBracket, altStart));
              }
              if (altStart < altEnd) {
                decos.push(Decoration.mark({ class: 'cm-novelist-image-inline' }).range(altStart, altEnd));
              }
              if (altEnd < node.to) {
                decos.push(Decoration.mark({ class: 'cm-novelist-hidden' }).range(altEnd, node.to));
              }
            }
          }
          return false;
        }

        // --- Table (GFM) — handled by table.ts plugin (rendered widget) ---
        if (node.name === 'Table') {
          return false; // Skip — table.ts handles all table decorations
        }

        // --- ==Highlight== ---
        if (node.name === 'Highlight') {
          handleInlineMarkup(node.node, state, decos, markerClass, 'cm-novelist-highlight', 'HighlightMark');
          return false;
        }

        // --- Footnote reference [^id] ---
        if (node.name === 'FootnoteReference') {
          if (node.from < node.to) {
            // Style the whole reference as superscript
            decos.push(
              Decoration.mark({ class: 'cm-novelist-footnote-ref' }).range(node.from, node.to)
            );
            // Hide the brackets and caret when cursor is not on the line
            const fnNode = node.node;
            const cursor = fnNode.cursor();
            if (cursor.firstChild()) {
              do {
                if (cursor.name === 'FootnoteMark') {
                  if (cursor.from < cursor.to) {
                    decos.push(
                      Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
                    );
                  }
                }
              } while (cursor.nextSibling());
            }
          }
          return false;
        }

        // --- Footnote definition [^id]: text ---
        if (node.name === 'FootnoteDefinition') {
          const fnDefDeco = Decoration.line({ class: 'cm-novelist-footnote-def' });
          let fnPos = node.from;
          while (fnPos <= node.to) {
            const line = state.doc.lineAt(fnPos);
            decos.push(fnDefDeco.range(line.from));
            fnPos = line.to + 1;
          }
          return false;
        }

        // --- YAML Front-matter ---
        if (node.name === 'FrontMatter') {
          const fmDeco = Decoration.line({ class: 'cm-novelist-frontmatter' });
          let fmPos = node.from;
          while (fmPos <= node.to) {
            const line = state.doc.lineAt(fmPos);
            decos.push(fmDeco.range(line.from));
            fmPos = line.to + 1;
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

export const wysiwygPlugin: Extension = [
  imageBlockDecoField,
  ViewPlugin.fromClass(WysiwygPluginClass, {
    decorations: (v) => v.decorations,
  }),
];

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
          const base64 = uint8ToBase64(new Uint8Array(arrayBuffer));

          const imagesDir = `${projectDir}/.novelist/images`;
          await invoke('create_directory', {
            parentDir: `${projectDir}/.novelist`,
            name: 'images',
          }).catch(() => {});

          const imgPath = `${imagesDir}/${filename}`;
          await invoke('write_binary_file', {
            path: imgPath,
            base64Data: base64,
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
          const base64 = uint8ToBase64(new Uint8Array(arrayBuffer));

          const imagesDir = `${projectDir}/.novelist/images`;
          await invoke('create_directory', {
            parentDir: `${projectDir}/.novelist`,
            name: 'images',
          }).catch(() => {});

          const imgPath = `${imagesDir}/${filename}`;
          await invoke('write_binary_file', {
            path: imgPath,
            base64Data: base64,
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
