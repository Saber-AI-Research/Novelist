import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import { EditorView, type KeyBinding } from '@codemirror/view';
import { blockTransformSpec } from './block-transform';
import { isImeComposing } from './ime-guard';
import { isSlashMenuOpen } from './slash-commands';

interface LineInfo {
  number: number;
  from: number;
  to: number;
  text: string;
}

type StructuralKind = 'quote' | 'unordered-list' | 'task-list';

interface StructuralLine {
  kind: StructuralKind;
  indentLength: number;
  marker: '-' | '*';
}

const INDENT = '  ';

export const selectedQuoteInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '>' || from === to) return false;
  if (isImeComposing(view) || isSlashMenuOpen(view.state)) return false;
  const spec = blockTransformSpec(view.state, 'quote', EditorSelection.single(from, to));
  if (!spec) return false;
  view.dispatch(spec);
  return true;
});

export const structuralHierarchyKeymap: readonly KeyBinding[] = [
  { key: 'Tab', run: view => applyStructuralHierarchy(view, 'indent') },
  { key: 'Shift-Tab', run: view => applyStructuralHierarchy(view, 'outdent') },
];

export function applyStructuralHierarchy(view: EditorView, direction: 'indent' | 'outdent'): boolean {
  if (isImeComposing(view) || isSlashMenuOpen(view.state)) return false;
  const spec = structuralHierarchySpec(view.state, direction);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

export function structuralHierarchySpec(state: EditorState, direction: 'indent' | 'outdent'): TransactionSpec | null {
  const lines = touchedLines(state);
  if (lines.length === 0) return null;

  const parsed = lines.map(line => ({ line, structural: parseStructuralLine(line.text) }));
  const nonblank = parsed.filter(({ line }) => line.text.trim() !== '');
  if (nonblank.length === 0) return null;
  if (nonblank.some(({ structural }) => !structural)) return null;

  const changes: ChangeSpec[] = [];
  for (const { line, structural } of parsed) {
    if (!structural) continue;
    const change = direction === 'indent'
      ? indentChange(line, structural)
      : outdentChange(line, structural);
    if (change) changes.push(change);
  }

  if (changes.length === 0) return null;
  const changeDesc = state.changes(changes);
  return {
    changes,
    selection: state.selection.map(changeDesc, 1),
  };
}

function touchedLines(state: EditorState): LineInfo[] {
  const lineNumbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const first = state.doc.lineAt(from);
    const lastPos = range.empty ? from : Math.max(from, to - 1);
    const last = state.doc.lineAt(lastPos);
    for (let number = first.number; number <= last.number; number += 1) {
      lineNumbers.add(number);
    }
  }
  return [...lineNumbers]
    .sort((a, b) => a - b)
    .map(number => {
      const line = state.doc.line(number);
      return { number, from: line.from, to: line.to, text: line.text };
    });
}

function parseStructuralLine(text: string): StructuralLine | null {
  const quote = /^(?: {0,3}>[ \t]?)/.exec(text);
  if (quote) return { kind: 'quote', indentLength: 0, marker: '-' };

  const task = /^([ \t]*)([-*])[ \t]+\[([ xX])\][ \t]+/.exec(text);
  if (task) return { kind: 'task-list', indentLength: task[1].length, marker: task[2] as '-' | '*' };

  const unordered = /^([ \t]*)([-*])[ \t]+/.exec(text);
  if (unordered) return { kind: 'unordered-list', indentLength: unordered[1].length, marker: unordered[2] as '-' | '*' };

  return null;
}

function indentChange(line: LineInfo, structural: StructuralLine): ChangeSpec {
  if (structural.kind === 'quote') return { from: line.from, insert: '> ' };
  return { from: line.from, insert: INDENT };
}

function outdentChange(line: LineInfo, structural: StructuralLine): ChangeSpec | null {
  if (structural.kind === 'quote') {
    const quote = /^(?: {0,3}>[ \t]?)/.exec(line.text);
    return quote ? { from: line.from, to: line.from + quote[0].length, insert: '' } : null;
  }

  if (structural.indentLength <= 0) return null;
  const remove = Math.min(INDENT.length, structural.indentLength);
  return { from: line.from, to: line.from + remove, insert: '' };
}
