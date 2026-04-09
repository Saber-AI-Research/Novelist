import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, lineNumbers, highlightActiveLine, keymap, drawSelection,
  dropCursor, rectangularSelection, scrollPastEnd, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { wysiwygPlugin, linkClickPlugin, imagePastePlugin } from './wysiwyg';
import { imeComposingField, imeGuardPlugin } from './ime-guard';
import { typewriterPlugin, paragraphFocusPlugin } from './zen';
import './wysiwyg.css';

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
const novelistHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold' },
  { tag: tags.heading1, fontSize: '1.75em', fontWeight: '700', lineHeight: '1.35', color: 'var(--novelist-heading-color)', letterSpacing: '-0.02em' },
  { tag: tags.heading2, fontSize: '1.4em',  fontWeight: '600', lineHeight: '1.35', color: 'var(--novelist-heading-color)', letterSpacing: '-0.01em' },
  { tag: tags.heading3, fontSize: '1.2em',  fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-heading-color)' },
  { tag: tags.heading4, fontSize: '1.05em', fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-heading-color)' },
  { tag: tags.heading5, fontSize: '1.0em',  fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-text-secondary)' },
  { tag: tags.heading6, fontSize: '0.92em', fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-text-secondary)' },
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
  /* Heading font-size — scoped inside CM6 theme for high specificity */
  '.cm-novelist-h1': { fontSize: '1.75em', fontWeight: '700', lineHeight: '1.35', color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h2': { fontSize: '1.4em',  fontWeight: '600', lineHeight: '1.35', color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h3': { fontSize: '1.2em',  fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h4': { fontSize: '1.05em', fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-heading-color)' },
  '.cm-novelist-h5': { fontSize: '1.0em',  fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-text-secondary)' },
  '.cm-novelist-h6': { fontSize: '0.92em', fontWeight: '600', lineHeight: '1.4',  color: 'var(--novelist-text-secondary)' },
});

interface EditorOptions {
  wysiwyg?: boolean;
  zen?: boolean;
  largeFile?: boolean;   // Stripped extension set (no WYSIWYG, 1-3.5MB)
  tallDoc?: boolean;     // >5000 lines — flat heading sizes, no WYSIWYG decorations
  readOnly?: boolean;    // View-only mode (>3.5MB)
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

  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    bracketMatching(),
    closeBrackets(),
    highlightSelectionMatches(),
    indentOnInput(),
    scrollPastEnd(),
    placeholder('Start writing...'),
    syntaxHighlighting(options?.tallDoc ? flatNovelistHighlightStyle : novelistHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, extensions: [GFM] }),
    imeComposingField,
    imeGuardPlugin,
    EditorView.lineWrapping,
    novelistTheme,
    keymap.of([
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
  }

  // Always add link click and image paste (even without WYSIWYG)
  exts.push(linkClickPlugin, imagePastePlugin);

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
