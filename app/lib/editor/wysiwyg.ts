import { ViewPlugin, Decoration, type DecorationSet, EditorView, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { invoke } from '@tauri-apps/api/core';
import { open as shellOpen } from '@tauri-apps/plugin-shell';
import { imeComposingField } from './ime-guard';
import { fileManagerLabel } from '$lib/utils/platform-labels';
import { readLocalImageDataUri } from '$lib/services/image-host';
import { pathJoin } from '$lib/utils/path';

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
 * Local images are loaded through the window's Rust-owned image capability.
 */
class ImageWidget extends WidgetType {
  constructor(private src: string, private alt: string, private documentDir: string) {
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
      const cacheKey = `${this.documentDir}\0${this.src}`;
      const cached = getCachedImage(cacheKey);
      if (cached) {
        img.src = cached;
      } else if (!this.documentDir) {
        img.dispatchEvent(new Event('error'));
      } else {
        readLocalImageDataUri(this.src, { baseDir: this.documentDir }).then(dataUri => {
          cacheImage(cacheKey, dataUri);
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
    const documentDir = this.documentDir;
    const isLocalImg = !imgSrc.startsWith('http://') && !imgSrc.startsWith('https://') && !imgSrc.startsWith('data:');

    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.querySelectorAll('.cm-image-context-menu').forEach(el => el.remove());
      const pos = view.posAtDOM(wrapper);
      const line = view.state.doc.lineAt(pos);
      new ImageContextMenu(view, imgSrc, imgAlt, line.from, line.to, e.clientX, e.clientY, isLocalImg, documentDir);
    });

    return wrapper;
  }

  eq(other: ImageWidget): boolean {
    return this.src === other.src && this.alt === other.alt && this.documentDir === other.documentDir;
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
    private documentDir: string,
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

    if (this.isLocal && this.documentDir) {
      items.push({
        label: fileManagerLabel(),
        action: () => {
          const fullPath = pathJoin(this.documentDir, this.imgSrc);
          invoke('reveal_in_file_manager', { path: fullPath }).catch(console.error);
          this.destroy();
        },
      });
      items.push({
        label: 'Upload to host',
        action: () => {
          this.uploadAndReplace().catch((e: unknown) => {
            console.error('image upload failed', e);
            const msg = e instanceof Error ? e.message : String(e);
            window.dispatchEvent(new CustomEvent('image-host-toast', { detail: { kind: 'error', message: msg } }));
          });
          this.destroy();
        },
      });
    }

    if (this.imgSrc.startsWith('http://') || this.imgSrc.startsWith('https://')) {
      items.push({
        label: 'Open in Browser',
        action: () => {
          // Tauri WKWebView blocks `window.open`; route through the shell plugin.
          shellOpen(this.imgSrc).catch(e => console.error('[editor] shell.open failed:', e));
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

  /**
   * Upload the local image referenced by `this.imgSrc` to the active
   * host and rewrite the Markdown link in place. Caller catches errors.
   */
  private async uploadAndReplace(): Promise<void> {
    const { uploadImage } = await import('$lib/services/image-host');
    const { url } = await uploadImage(this.imgSrc, {
      baseDir: this.documentDir,
    });

    // Replace the URL portion of `![alt](src)` on the line. Match the
    // current src inside parens; preserve alt and surrounding text.
    const lineText = this.view.state.doc.sliceString(this.lineFrom, this.lineTo);
    const re = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/;
    const m = re.exec(lineText);
    if (!m) return;
    const matchStart = m.index;
    const oldSrcStart = matchStart + 2 + m[1].length + 2; // past `![alt](`
    const oldSrcEnd = oldSrcStart + m[2].length;
    this.view.dispatch({
      changes: {
        from: this.lineFrom + oldSrcStart,
        to: this.lineFrom + oldSrcEnd,
        insert: url,
      },
    });
    window.dispatchEvent(
      new CustomEvent('image-host-toast', {
        detail: { kind: 'success', message: `Uploaded to ${url}` },
      }),
    );
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

export const imageDocumentDirEffect = StateEffect.define<string>();

export const imageDocumentDirField = StateField.define<string>({
  create: () => '',
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(imageDocumentDirEffect)) return effect.value;
    }
    return value;
  },
});

export function setWysiwygImageDocumentDir(view: EditorView, dir: string) {
  view.dispatch({ effects: imageDocumentDirEffect.of(dir) });
}

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
/**
 * Tracks the line number containing the cursor when that line has an Image
 * node — used to suppress block-image rendering so the user can edit the
 * markdown `![alt](url)` source (e.g. fix a broken path).
 *
 * Pointer-driven transactions (`select.pointer`) are filtered out so the
 * height map doesn't shift between mousedown and mouseup; the next
 * non-pointer transaction (keyboard nav, typing, focus) flips the state.
 */
export function computeCursorImageLine(state: EditorState): number | null {
  if (state.selection.ranges.length === 0) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  let found = false;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (node.name === 'Image') { found = true; return false; }
    },
  });
  return found ? line.number : null;
}

export const cursorImageLineField = StateField.define<number | null>({
  // Initial state: render all images. The user has to explicitly move the
  // cursor onto an image line (via keyboard) for the widget to collapse —
  // avoids hiding the first image on doc-open when cursor defaults to pos 0.
  create() { return null; },
  update(value, tr) {
    if (tr.isUserEvent('select.pointer')) return value;
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return computeCursorImageLine(tr.state);
    }
    return value;
  },
});

function buildImageBlockDecos(state: EditorState): DecorationSet {
  if (!_renderImages) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  const imageDocumentDir = state.field(imageDocumentDirField, false) ?? '';
  const skipLine = state.field(cursorImageLineField, false);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'Image') return;

      const line = state.doc.lineAt(node.from);
      if (skipLine != null && line.number === skipLine) return;

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
        decos.push(Decoration.replace({
            widget: new ImageWidget(imgUrl, imgAlt, imageDocumentDir),
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
    if (tr.effects.some((effect) => effect.is(imageDocumentDirEffect))) {
      return buildImageBlockDecos(tr.state);
    }
    if (tr.docChanged) return buildImageBlockDecos(tr.state);
    if (tr.state.field(imeComposingField, false)) return value;
    // Rebuild when the incremental parser finishes.
    if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      return buildImageBlockDecos(tr.state);
    }
    // Rebuild when the cursor enters/leaves an image line. Pointer events
    // are filtered upstream in cursorImageLineField to avoid mousedown/
    // mouseup height-map shift.
    if (tr.state.field(cursorImageLineField) !== tr.startState.field(cursorImageLineField)) {
      return buildImageBlockDecos(tr.state);
    }
    return value;
  },
  provide: f => EditorView.decorations.from(f),
});

/**
 * Clamp a replace-decoration range to a single line.
 *
 * CM6 rejects `Decoration.replace` from a ViewPlugin when `to` extends past
 * the end of the line containing `from` ("Decorations that replace line
 * breaks may not be specified via plugins"). This helper guarantees the
 * invariant for every ViewPlugin-scoped replace in this file.
 *
 * Returns null when the clamped range is empty (caller should skip).
 */
function clampReplaceRange(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const lineEnd = state.doc.lineAt(from).to;
  const clamped = Math.min(to, lineEnd);
  if (clamped <= from) return null;
  return { from, to: clamped };
}

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
                    const r = clampReplaceRange(state, cursor.from, cursor.to);
                    if (r) decos.push(Decoration.replace({}).range(r.from, r.to));
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
              const r = clampReplaceRange(state, afterMarker, contentStart);
              if (r) decos.push(Decoration.replace({}).range(r.from, r.to));
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
                  if (cursorInside) {
                    // Cursor on link line: dim the marker with opacity so the
                    // user can still see/edit the syntax.
                    decos.push(
                      Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(cursor.from, cursor.to)
                    );
                  } else {
                    // Cursor elsewhere: fully remove the bracket/paren from
                    // layout (otherwise `visibility: hidden` leaves a 1-char
                    // gap per `[`, `]`, `(`, `)` — 4 chars total per link).
                    const r = clampReplaceRange(state, cursor.from, cursor.to);
                    if (r) decos.push(Decoration.replace({}).range(r.from, r.to));
                  }
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
                  if (cursorInside) {
                    decos.push(
                      Decoration.mark({ class: 'cm-novelist-marker-visible' }).range(cursor.from, cursor.to)
                    );
                  } else {
                    // URL is long — must truly remove from layout. Markdown
                    // inline links don't cross newlines; clamp is defensive.
                    const r = clampReplaceRange(state, cursor.from, cursor.to);
                    if (r) decos.push(Decoration.replace({}).range(r.from, r.to));
                  }
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
                  const lm = clampReplaceRange(state, listMark.from, listMark.to);
                  if (lm) decos.push(Decoration.replace({}).range(lm.from, lm.to));
                  // Also hide whitespace between ListMark and TaskMarker
                  if (listMark.to < node.from) {
                    const gap = clampReplaceRange(state, listMark.to, node.from);
                    if (gap) decos.push(Decoration.replace({}).range(gap.from, gap.to));
                  }
                }
              }

              // Replace [ ]/[x] with a visual checkbox widget
              const cb = clampReplaceRange(state, node.from, node.to);
              if (cb) {
                decos.push(
                  Decoration.replace({
                    widget: new CheckboxWidget(isChecked, node.from),
                  }).range(cb.from, cb.to)
                );
              }

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
 *
 * When the cursor is NOT on the node (`markerClass === 'cm-novelist-hidden'`)
 * we use `Decoration.replace({})` to fully collapse the `**` / `*` / `~~` /
 * `` ` `` markers. `visibility: hidden` would leave a per-marker horizontal
 * gap (e.g. `**姓名**` rendered as "  姓名  "), which users perceive as an
 * unwanted space. Headings/links already collapse their markers the same way.
 */
function handleInlineMarkup(
  syntaxNode: ReturnType<typeof syntaxTree>['topNode'],
  state: EditorState,
  decos: Range<Decoration>[],
  markerClass: string,
  contentClass: string,
  markerNodeName: string,
) {
  const cursor = syntaxNode.cursor();
  const collapse = markerClass === 'cm-novelist-hidden';

  if (cursor.firstChild()) {
    do {
      if (cursor.name === markerNodeName) {
        if (cursor.from < cursor.to) {
          if (collapse) {
            const r = clampReplaceRange(state, cursor.from, cursor.to);
            if (r) decos.push(Decoration.replace({}).range(r.from, r.to));
          } else {
            decos.push(
              Decoration.mark({ class: markerClass }).range(cursor.from, cursor.to)
            );
          }
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

    // CRITICAL: rebuild on doc change even during IME composition.
    //
    // If we skip rebuilding here and just let CM6 map the previous
    // DecorationSet through the transaction, a composition that inserts
    // a newline (or any multi-line run) into a replace range will produce
    // a stale decoration whose [from..to] now crosses a line break — and
    // CM6 throws `RangeError: Decorations that replace line breaks may not
    // be specified via plugins` at the next render. Rebuilding produces a
    // fresh set matched to the current doc, which is always safe.
    if (update.docChanged || update.viewportChanged || (wasComposing && !isComposing)) {
      this.decorations = buildDecorations(update.view);
      this.lastCursorLine = update.state.doc.lineAt(update.state.selection.main.head).number;
      return;
    }

    // For non-doc updates during IME composition, leave decorations alone
    // (cursor may jump transiently but no doc change means no cross-line risk).
    if (isComposing) return;

    // Rebuild when the incremental parser advances the syntax tree, even
    // without a doc/selection/viewport change.
    //
    // CM6's language ViewPlugin parses lazily in the background and dispatches
    // tree-only transactions (no docChanged, no selectionSet) as it catches up.
    // In a long document an edit (e.g. typing in a table cell) invalidates a
    // large region, so the first post-edit rebuild runs against an incomplete
    // tree — headings beyond the synchronous parse budget aren't recognized yet,
    // leaving their marker decorations stale. Without this guard the WYSIWYG
    // decorations are never refreshed when the parser finishes, so on-screen
    // headings render wrong until the next unrelated doc/selection/viewport
    // change. The table plugins (table.ts) already guard on this same condition.
    if (syntaxTree(update.state) !== syntaxTree(update.startState)) {
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
  imageDocumentDirField,
  cursorImageLineField,
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
      // Tauri WKWebView blocks `window.open`; route through the shell plugin.
      shellOpen(url).catch(e => console.error('[editor] shell.open failed:', e));
      event.preventDefault();
      return true;
    }
    return false;
  },
});

/**
 * If auto-on-paste is enabled in settings AND an active host is configured,
 * upload the just-inserted local image and rewrite the Markdown link to
 * the remote URL. The local file under `.novelist/images/` is retained.
 *
 * `linkText` is the literal `![alt](path)` string that was inserted at
 * `insertPos`, of length `linkText.length`. We re-derive the URL portion
 * from a regex over that span and replace just it.
 */
async function maybeAutoUpload(
  view: EditorView,
  insertPos: number,
  linkText: string,
  absLocalPath: string,
  filename: string,
  mime: string,
  bytes: Uint8Array,
): Promise<void> {
  try {
    const { commands } = await import('$lib/ipc/commands');
    const r = await commands.getImageHostSettings();
    if (r.status !== 'ok') return;
    if (!r.data.auto_on_paste) return;
    if (!r.data.active_host_id) return;
    const { uploadInlineBytes } = await import('$lib/services/image-host');
    const { url } = await uploadInlineBytes(bytes, filename, mime);
    // Replace the URL portion of the just-inserted markdown link.
    const re = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/;
    const m = re.exec(linkText);
    if (!m) return;
    const matchStart = m.index;
    const oldSrcStart = insertPos + matchStart + 2 + m[1].length + 2;
    const oldSrcEnd = oldSrcStart + m[2].length;
    view.dispatch({
      changes: { from: oldSrcStart, to: oldSrcEnd, insert: url },
    });
    window.dispatchEvent(
      new CustomEvent('image-host-toast', {
        detail: { kind: 'success', message: `Uploaded to ${url}` },
      }),
    );
  } catch (e) {
    console.warn('[ImagePaste] auto-upload failed; keeping local link', e);
    window.dispatchEvent(
      new CustomEvent('image-host-toast', {
        detail: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
      }),
    );
  }
  // Suppress unused-arg lint when localPath isn't needed in current impl
  void absLocalPath;
}

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
          await maybeAutoUpload(view, pos, mdText, imgPath, filename, file.type, new Uint8Array(arrayBuffer));
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
      type DropQueued = { mdText: string; filename: string; mime: string; bytes: Uint8Array; imgPath: string };
      const queued: DropQueued[] = [];
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

          const md = `![${file.name}](.novelist/images/${filename})\n`;
          insertText += md;
          queued.push({ mdText: md, filename, mime: file.type, bytes: new Uint8Array(arrayBuffer), imgPath });
        } catch (err) {
          console.error('[ImageDrop] Failed:', err);
        }
      }

      if (insertText) {
        view.dispatch({
          changes: { from: pos, insert: insertText },
          selection: { anchor: pos + insertText.length },
        });
        // Auto-upload each dropped image (sequentially, after the bulk insert).
        let runningPos = pos;
        for (const q of queued) {
          await maybeAutoUpload(view, runningPos, q.mdText, q.imgPath, q.filename, q.mime, q.bytes);
          runningPos += q.mdText.length;
        }
      }
    })();

    return true;
  },
});
