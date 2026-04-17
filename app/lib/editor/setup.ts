import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView, ViewPlugin, lineNumbers, highlightActiveLine, keymap, drawSelection,
  dropCursor, rectangularSelection, scrollPastEnd, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { GFM } from '@lezer/markdown';
import { Highlight, Footnote, FrontMatter, InlineMath, DisplayMath } from './markdown-extensions';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput, indentUnit } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { wysiwygPlugin, linkClickPlugin, imagePastePlugin } from './wysiwyg';
import { mermaidPlugin } from './mermaid';
import { mathPlugin } from './math';
import { tablePlugin } from './table';
import { imeComposingField, imeGuardPlugin } from './ime-guard';
import { typewriterPlugin, paragraphFocusPlugin } from './zen';
import { codeLanguages } from './languages';
import { slashCommandExtension } from './slash-commands';
import './wysiwyg.css';

export const highlightMatchCompartment = new Compartment();

/**
 * Heading font sizes MUST live in syntaxHighlighting, NOT in WYSIWYG
 * mark decorations.  The WYSIWYG plugin only decorates visible ranges;
 * when a heading scrolls out of the viewport its mark decoration is
 * removed, making the line revert to default font-size.  CM6 caches
 * the "tall" measured height but the next measurement may differ →
 * cumulative height-map drift → click-after-scroll lands on the wrong
 * line.  syntaxHighlighting is driven by the incremental parser and
 * applies consistently to every line regardless of viewport, keeping
 * heading heights stable for CM6's height estimation.
 *
 * NOTE: Even with syntaxHighlighting, the heading font-size differences
 * (1.75em for H1, etc.) cause CM6's height estimation to drift for
 * off-screen lines in documents with >5000 lines. For such "tall docs",
 * use flatNovelistHighlightStyle instead, which keeps headings bold and
 * colored but at uniform font-size, eliminating height-map drift entirely.
 */
/**
 * Heading line-height is calculated so that each heading line occupies
 * roughly the same pixel height as a body text line (1em × 1.8 = 1.8em).
 * This keeps vertical rhythm consistent and prevents large gaps.
 *
 * Formula: target_line_height = body_line_height / heading_font_size
 *   H1: 1.8 / 1.75 ≈ 1.03 → use 1.15 (minimum readable)
 *   H2: 1.8 / 1.4  ≈ 1.29 → use 1.3
 *   H3: 1.8 / 1.2  ≈ 1.5  → use 1.5
 *   H4: 1.8 / 1.05 ≈ 1.71 → use 1.7
 *   H5/H6: ≤1.0em → keep 1.8
 */
const novelistHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.heading1, fontSize: '1.75em', fontWeight: '700', lineHeight: '1.15', color: 'var(--novelist-heading-color)', letterSpacing: '-0.02em' },
  { tag: tags.heading2, fontSize: '1.4em',  fontWeight: '600', lineHeight: '1.3',  color: 'var(--novelist-heading-color)', letterSpacing: '-0.01em' },
  { tag: tags.heading3, fontSize: '1.2em',  fontWeight: '600', lineHeight: '1.5',  color: 'var(--novelist-heading-color)' },
  { tag: tags.heading4, fontSize: '1.05em', fontWeight: '600', lineHeight: '1.7',  color: 'var(--novelist-heading-color)' },
  { tag: tags.heading5, fontSize: '1.0em',  fontWeight: '600', lineHeight: '1.8',  color: 'var(--novelist-text-secondary)' },
  { tag: tags.heading6, fontSize: '0.92em', fontWeight: '600', lineHeight: '1.8',  color: 'var(--novelist-text-secondary)' },
]);

/**
 * Flat highlight style for tall documents (>5000 lines).
 * Keeps headings bold and colored but removes font-size / line-height
 * differences so every line has identical height.  This makes CM6's
 * height-map estimation exact regardless of scroll position, preventing
 * the "click after scroll jumps to wrong line" bug.
 */
const flatNovelistHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.heading1, fontWeight: '700', color: 'var(--novelist-heading-color)' },
  { tag: tags.heading2, fontWeight: '600', color: 'var(--novelist-heading-color)' },
  { tag: tags.heading3, fontWeight: '600', color: 'var(--novelist-heading-color)' },
  { tag: tags.heading4, fontWeight: '600', color: 'var(--novelist-heading-color)' },
  { tag: tags.heading5, fontWeight: '600', color: 'var(--novelist-text-secondary)' },
  { tag: tags.heading6, fontWeight: '600', color: 'var(--novelist-text-secondary)' },
]);

/**
 * Scroll stabilizer: prevents click-after-scroll position jumps.
 *
 * Root cause: after a fast scrollbar drag, CM6's dispatch() updates the DOM
 * (re-renders viewport, sets selection). This triggers the BROWSER's native
 * scroll-into-view behavior, which computes a completely wrong scrollTop in
 * CM6's virtual scrolling environment (e.g., jumping from scrollTop=3M to 67).
 *
 * This native scroll happens synchronously during dispatch, BEFORE CM6's
 * measure loop / scrollHandler facet can intercept it. So the fix must
 * operate at the DOM event level, not the CM6 extension level.
 *
 * Three-layer defense:
 * 1. mousedown guard — saves scrollTop before CM6 processes the click
 * 2. scroll listener — detects and reverts the native browser jump
 * 3. scrollHandler facet — suppresses CM6's own scrollIntoView as backup
 */

interface StabilizerState {
  pending: boolean;     // large scroll detected, guard next click
  locked: boolean;      // block onScroll during restoration
  lastScrollTop: number;
  settleTimer: ReturnType<typeof setTimeout> | null;
  guardScrollTop: number;  // saved scrollTop at mousedown
  guardClickPos: number;   // saved document position at click
  guardActive: boolean;    // mousedown guard is armed
}

const stabilizerStates = new WeakMap<EditorView, StabilizerState>();

const scrollStabilizerPlugin = ViewPlugin.fromClass(class {
  private state: StabilizerState;
  private cleanup: () => void;

  constructor(private view: EditorView) {
    this.state = {
      pending: false,
      locked: false,
      lastScrollTop: view.scrollDOM.scrollTop,
      settleTimer: null,
      guardScrollTop: 0,
      guardClickPos: -1,
      guardActive: false,
    };
    stabilizerStates.set(view, this.state);

    // Layer 1: mousedown guard (capture phase, fires BEFORE CM6's handler)
    // Saves scrollTop and click position so we can revert native scroll
    // and fix the selection afterward.
    const onMousedown = (e: MouseEvent) => {
      if (e.button !== 0 || !this.state.pending) return;
      if (!view.contentDOM.contains(e.target as Node)) return;
      this.state.guardActive = true;
      this.state.guardScrollTop = view.scrollDOM.scrollTop;
      this.state.guardClickPos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? -1;
    };

    // Layer 2: scroll listener
    const onScroll = () => {
      // Intercept native browser scroll during click processing
      if (this.state.guardActive && this.state.pending) {
        const newTop = view.scrollDOM.scrollTop;
        const delta = Math.abs(newTop - this.state.guardScrollTop);
        if (delta > view.scrollDOM.clientHeight) {
          // Native browser scroll — revert immediately
          view.scrollDOM.scrollTop = this.state.guardScrollTop;
          this.state.guardActive = false;
          this.state.locked = true;
          this.state.pending = false;

          // Fix selection: the native scroll corrupted CM6's mouse tracking,
          // so dispatch the correct cursor position we captured at mousedown.
          const pos = this.state.guardClickPos;
          if (pos >= 0) {
            queueMicrotask(() => {
              view.dispatch({ selection: { anchor: pos } });
            });
          }

          // Unlock after CM6's measure loop completes
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              this.state.locked = false;
              this.state.lastScrollTop = view.scrollDOM.scrollTop;
            });
          });
          return;
        }
        this.state.guardActive = false;
      }

      if (this.state.locked) return;

      const newTop = view.scrollDOM.scrollTop;
      const delta = Math.abs(newTop - this.state.lastScrollTop);
      if (delta > view.scrollDOM.clientHeight * 0.5) {
        this.state.pending = true;
        view.requestMeasure();
      }
      this.state.lastScrollTop = newTop;

      if (this.state.settleTimer) clearTimeout(this.state.settleTimer);
      this.state.settleTimer = setTimeout(() => {
        view.requestMeasure();
        this.state.settleTimer = null;
      }, 150);
    };

    view.scrollDOM.addEventListener('mousedown', onMousedown, true);
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    this.cleanup = () => {
      view.scrollDOM.removeEventListener('mousedown', onMousedown, true);
      view.scrollDOM.removeEventListener('scroll', onScroll);
    };
  }

  update() {}

  destroy() {
    this.cleanup();
    stabilizerStates.delete(this.view);
    if (this.state.settleTimer) clearTimeout(this.state.settleTimer);
  }
});

// Layer 3: scrollHandler — backup suppression of CM6's own scrollIntoView
const scrollStabilizerHandler = EditorView.scrollHandler.of((view, range) => {
  const state = stabilizerStates.get(view);
  if (!state || !state.pending) return false;

  const vp = view.viewport;
  if (range.head < vp.from || range.head > vp.to) return false;

  state.pending = false;
  state.locked = true;

  // Clear settleTimer to prevent delayed height-map corrections
  if (state.settleTimer) {
    clearTimeout(state.settleTimer);
    state.settleTimer = null;
  }

  // Brief lock — no rAF restoration needed since native scroll was already
  // handled by Layer 2. This just prevents height anchor correction.
  requestAnimationFrame(() => {
    state.locked = false;
    state.lastScrollTop = view.scrollDOM.scrollTop;
  });

  return true;
});

/**
 * Scroll stabilizer extensions.
 * Add to extensions to prevent click-after-scroll position jumps.
 */
export const scrollStabilizer: Extension = [
  scrollStabilizerPlugin,
  scrollStabilizerHandler,
];

const novelistTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--novelist-editor-font-size)',
    backgroundColor: 'var(--novelist-editor-bg)',
    color: 'var(--novelist-text)',
  },
  '.cm-content': {
    fontFamily: 'var(--novelist-editor-font)',
    lineHeight: 'var(--novelist-editor-line-height)',
    maxWidth: 'var(--novelist-editor-max-width)',
    margin: '0 auto',
    padding: '3rem 1.5rem',
    caretColor: 'var(--novelist-accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--novelist-accent)',
    borderLeftWidth: '1.5px',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--novelist-text-tertiary, var(--novelist-text-secondary))',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-gutterElement': {
    overflow: 'hidden',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--novelist-text-secondary)',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--novelist-accent) 16%, transparent) !important',
  },
  '.cm-line': {
    padding: '0 4px',
  },
  '.cm-placeholder': {
    color: 'var(--novelist-text-tertiary, var(--novelist-text-secondary))',
    fontStyle: 'italic',
  },
  /* Heading font-size — scoped inside CM6 theme for high specificity.
     Line-heights tuned so each heading occupies ~1.8em (matching body rhythm). */
  '.cm-novelist-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.15', color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h2': { fontSize: '1.4em',  fontWeight: '600', lineHeight: '1.3',  color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h3': { fontSize: '1.2em',  fontWeight: '600', lineHeight: '1.5',  color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h4': { fontSize: '1.05em', fontWeight: '600', lineHeight: '1.7',  color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h5': { fontSize: '1.0em',  fontWeight: '600', lineHeight: '1.8',  color: 'var(--novelist-text-secondary)' },
  '.cm-novelist-h6': { fontSize: '0.92em', fontWeight: '600', lineHeight: '1.8',  color: 'var(--novelist-text-secondary)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(0, 180, 80, 0.15)' },
});

export type FileType = 'markdown' | 'json' | 'plaintext';

export function detectFileType(fileName: string): FileType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'json';
  if (lower.endsWith('.csv')) return 'plaintext';
  return 'markdown';
}

interface EditorOptions {
  wysiwyg?: boolean;
  zen?: boolean;
  largeFile?: boolean;   // Stripped extension set (no WYSIWYG, 1-3.5MB)
  tallDoc?: boolean;     // >5000 lines — flat heading sizes, no WYSIWYG decorations
  readOnly?: boolean;    // View-only mode (>3.5MB)
  /** 'tab' for real tab character, or number for spaces (2, 4, 8). Default: 4 */
  indentStyle?: 'tab' | number;
  /** Highlight matching words on selection. Default: true */
  highlightMatches?: boolean;
  /** File type for language mode selection. Default: 'markdown' */
  fileType?: FileType;
}

/**
 * Create editor extensions. For large files (>1MB), uses a stripped-down
 * extension set that avoids O(doc) operations per keystroke.
 */
export function createEditorExtensions(options?: EditorOptions): Extension[] {
  if (options?.readOnly) {
    return createReadOnlyExtensions();
  }
  if (options?.largeFile) {
    return createLargeFileExtensions();
  }

  // Indent configuration
  const useTab = options?.indentStyle === 'tab';
  const spaces = typeof options?.indentStyle === 'number' ? options.indentStyle : 4;
  const indentStr = useTab ? '\t' : ' '.repeat(spaces);

  const exts: Extension[] = [
    // Tab size and indent unit
    EditorState.tabSize.of(useTab ? spaces : spaces),
    indentUnit.of(indentStr),
    lineNumbers(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    bracketMatching(),
    closeBrackets(),
    highlightMatchCompartment.of(
      options?.highlightMatches !== false ? highlightSelectionMatches() : []
    ),
    indentOnInput(),
    scrollPastEnd(),
    placeholder('Start writing...'),
    syntaxHighlighting(options?.tallDoc ? flatNovelistHighlightStyle : novelistHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, extensions: [GFM, Highlight, Footnote, FrontMatter, InlineMath, DisplayMath], codeLanguages }),
    imeComposingField,
    imeGuardPlugin,
    // NO lineWrapping for tall docs — same reason as large files:
    // CM6's height estimation for unseen wrapped lines is inaccurate,
    // especially with CJK text and bold headings. Over 5000+ lines the
    // cumulative drift causes posAtCoords (click → position) to land on
    // the wrong line. Fixed-width lines have uniform height, making the
    // height-map estimation exact.
    ...(options?.tallDoc ? [] : [EditorView.lineWrapping]),
    novelistTheme,
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...markdownKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      { key: 'Mod-f', run: openSearchPanel },
    ]),
  ];

  // Disable WYSIWYG for tall docs to prevent height-map drift
  if (options?.wysiwyg !== false && !options?.tallDoc) {
    exts.push(wysiwygPlugin);
    // Mermaid diagram rendering — lazy-loaded, only active when mermaid blocks exist
    exts.push(mermaidPlugin);
    // KaTeX math rendering — lazy-loaded, only active when math nodes exist
    exts.push(mathPlugin);
    // GFM table rendering — shows rendered HTML table when cursor is outside
    exts.push(tablePlugin);
  }

  // Always add link click and image paste (even without WYSIWYG)
  exts.push(linkClickPlugin, imagePastePlugin);

  // Slash command menu — Notion-style "/" block insertion
  exts.push(slashCommandExtension);

  // Scroll stabilizer — prevents click-after-scroll jumping in long documents
  exts.push(scrollStabilizer);

  if (options?.zen) {
    exts.push(typewriterPlugin, paragraphFocusPlugin);
  }

  return exts;
}

/**
 * Minimal extension set for large files (1-10MB).
 * Removes all extensions with O(document) per-keystroke cost:
 * - No WYSIWYG decorations
 * - No highlightSelectionMatches (scans full doc)
 * - No bracketMatching (can be expensive)
 * - No closeBrackets
 * - No scrollPastEnd (measurement overhead)
 * - No highlightActiveLine (minor but cumulative)
 *
 * Keeps:
 * - lineNumbers (virtualized by CM6)
 * - history (incremental)
 * - markdown syntax highlighting (incremental parser)
 * - search (user-initiated)
 * - lineWrapping (CSS)
 */
function createLargeFileExtensions(): Extension[] {
  return [
    lineNumbers(),
    history({ minDepth: 50 }),
    drawSelection(),
    // NO lineWrapping for large files — CM6's line-height estimation is
    // inaccurate for unseen wrapped lines, causing scroll jumps on click
    // after scrolling tens of thousands of lines. Fixed-width lines have
    // uniform height, making scroll position calculation exact.
    novelistTheme,
    scrollStabilizer,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      { key: 'Mod-f', run: openSearchPanel },
    ]),
  ];
}

/**
 * Read-only extension set for very large files (>3.5MB).
 * No parser, no gutters — absolute minimum for viewing large text.
 */
function createReadOnlyExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    drawSelection(),
    EditorView.lineWrapping,
    novelistTheme,
    keymap.of([
      ...searchKeymap,
      { key: 'Mod-f', run: openSearchPanel },
    ]),
  ];
}

export function createEditorState(doc: string, extensions: Extension[]): EditorState {
  return EditorState.create({ doc, extensions });
}
