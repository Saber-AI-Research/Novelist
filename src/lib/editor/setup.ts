import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { wysiwygPlugin } from './wysiwyg';
import { imeComposingField, imeGuardPlugin } from './ime-guard';
import './wysiwyg.css';

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
    padding: '2rem 1rem',
    caretColor: 'var(--novelist-accent)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--novelist-accent)',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--novelist-bg-secondary)',
    color: 'var(--novelist-text-secondary)',
    borderRight: '1px solid var(--novelist-border)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--novelist-border)',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--novelist-accent) 5%, transparent)',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--novelist-accent) 20%, transparent) !important',
  },
  '.cm-line': {
    padding: '0 4px',
  },
});

export function createEditorExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage }),
    imeComposingField,
    imeGuardPlugin,
    wysiwygPlugin,
    EditorView.lineWrapping,
    novelistTheme,
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),
  ];
}

export function createEditorState(doc: string, extensions: Extension[]): EditorState {
  return EditorState.create({ doc, extensions });
}
