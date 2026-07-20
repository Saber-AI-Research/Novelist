import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { isImeComposing } from './ime-guard';

export type HeadingTarget = 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4' | 'heading-5' | 'heading-6';
export type BlockTransformTarget =
  | 'paragraph'
  | HeadingTarget
  | 'quote'
  | 'unordered-list'
  | 'ordered-list'
  | 'task-list'
  | 'code-fence';

type LineKind = 'paragraph' | 'heading' | 'quote' | 'unordered-list' | 'ordered-list' | 'task-list';

interface LineInfo {
  number: number;
  from: number;
  to: number;
  text: string;
}

interface ParsedLine {
  content: string;
  prefixLength: number;
  kind: LineKind;
  headingLevel: number | null;
  listIndentation: string;
  unorderedMarker: '-' | '*' | '+' | null;
  taskChecked: boolean | null;
}

interface LineGroup {
  first: LineInfo;
  last: LineInfo;
}

interface FencedBlock {
  open: LineInfo;
  close: LineInfo;
  marker: string;
}

const HEADING_TARGET_RE = /^heading-([1-6])$/;

export function blockTransformSpec(
  state: EditorState,
  target: BlockTransformTarget,
  targetSelection: EditorSelection = state.selection,
): TransactionSpec | null {
  const lines = selectedLines(state, targetSelection);
  if (lines.length === 0) return null;

  const changes = target === 'code-fence'
    ? codeFenceChanges(state, lines)
    : linePrefixChanges(lines, target);

  if (changes.length === 0) return null;

  const changeDesc = state.changes(changes);
  return {
    changes,
    selection: state.selection.map(changeDesc, 1),
  };
}

export function applyBlockTransform(view: EditorView, target: BlockTransformTarget): boolean {
  if (isImeComposing(view)) return false;
  const spec = blockTransformSpec(view.state, target);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

function selectedLines(state: EditorState, selection: EditorSelection): LineInfo[] {
  const lineNumbers = new Set<number>();
  for (const range of selection.ranges) {
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

function linePrefixChanges(lines: LineInfo[], target: Exclude<BlockTransformTarget, 'code-fence'>): ChangeSpec[] {
  const parsed = lines.map(line => ({ line, parsed: parseLine(line.text) }));
  const outputTarget = target !== 'paragraph' && parsed.every(({ line, parsed: p }) => {
    if (line.text.trim() === '') return true;
    return matchesTarget(p, target);
  }) ? 'paragraph' : target;

  const changes: ChangeSpec[] = [];
  let orderedIndex = 1;
  let previousNonblankLineNumber: number | null = null;
  for (const { line, parsed: p } of parsed) {
    const isBlank = line.text.trim() === '';
    if (outputTarget === 'ordered-list' && (isBlank || previousNonblankLineNumber !== line.number - 1)) {
      orderedIndex = 1;
    }
    const replacement = isBlank ? '' : renderPrefix(p, outputTarget, orderedIndex);
    if (!isBlank && outputTarget === 'ordered-list') orderedIndex += 1;
    if (!isBlank) previousNonblankLineNumber = line.number;
    const currentPrefix = line.text.slice(0, p.prefixLength);
    if (replacement !== currentPrefix) {
      changes.push({ from: line.from, to: line.from + p.prefixLength, insert: replacement });
    }
  }

  return changes;
}

function parseLine(text: string): ParsedLine {
  let rest = text;
  let prefixLength = 0;
  let quoteDepth = 0;
  let headingLevel: number | null = null;
  let listIndentation = '';
  let unorderedMarker: '-' | '*' | '+' | null = null;
  let taskChecked: boolean | null = null;
  let kind: LineKind = 'paragraph';

  while (true) {
    const quote = /^(?: {0,3}>[ \t]?)/.exec(rest);
    if (!quote) break;
    quoteDepth += 1;
    prefixLength += quote[0].length;
    rest = rest.slice(quote[0].length);
  }

  const heading = /^(#{1,6})[ \t]*/.exec(rest);
  if (heading) {
    headingLevel = heading[1].length;
    kind = 'heading';
    prefixLength += heading[0].length;
    rest = rest.slice(heading[0].length);
  }

  const task = /^([ \t]*)([-+*]|\d+[.)])[ \t]+\[([ xX])\][ \t]*/.exec(rest);
  if (task) {
    listIndentation = task[1];
    if (task[2] === '-' || task[2] === '*' || task[2] === '+') unorderedMarker = task[2];
    taskChecked = task[3].toLowerCase() === 'x';
    kind = 'task-list';
    prefixLength += task[0].length;
    rest = rest.slice(task[0].length);
  } else {
    const unordered = /^([ \t]*)([-+*])[ \t]+/.exec(rest);
    if (unordered) {
      kind = 'unordered-list';
      listIndentation = unordered[1];
      unorderedMarker = unordered[2] as '-' | '*' | '+';
      prefixLength += unordered[0].length;
      rest = rest.slice(unordered[0].length);
    } else {
      const ordered = /^([ \t]*)\d+[.)][ \t]+/.exec(rest);
      if (ordered) {
        kind = 'ordered-list';
        listIndentation = ordered[1];
        prefixLength += ordered[0].length;
        rest = rest.slice(ordered[0].length);
      }
    }
  }

  if (quoteDepth > 0 && kind === 'paragraph') kind = 'quote';
  return { content: rest, prefixLength, kind, headingLevel, listIndentation, unorderedMarker, taskChecked };
}

function matchesTarget(line: ParsedLine, target: Exclude<BlockTransformTarget, 'code-fence'>): boolean {
  if (target === 'paragraph') return line.kind === 'paragraph';
  if (target === 'quote') return line.kind === 'quote';
  if (target === 'unordered-list') return line.kind === 'unordered-list';
  if (target === 'ordered-list') return line.kind === 'ordered-list';
  if (target === 'task-list') return line.kind === 'task-list';

  const heading = HEADING_TARGET_RE.exec(target);
  return line.kind === 'heading' && line.headingLevel === Number(heading?.[1]);
}

function renderPrefix(line: ParsedLine, target: Exclude<BlockTransformTarget, 'code-fence'>, orderedIndex: number): string {
  if (target === 'paragraph') return line.listIndentation;
  if (target === 'quote') return '> ';
  if (target === 'unordered-list') return `${line.listIndentation}${line.unorderedMarker ?? '-'} `;
  if (target === 'ordered-list') return `${line.listIndentation}${orderedIndex}. `;
  if (target === 'task-list') {
    const marker = line.unorderedMarker === '*' ? '*' : '-';
    return `${line.listIndentation}${marker} [${line.taskChecked ? 'x' : ' '}] `;
  }

  const heading = HEADING_TARGET_RE.exec(target);
  const level = Number(heading?.[1] ?? 1);
  return `${'#'.repeat(level)} `;
}

function codeFenceChanges(state: EditorState, lines: LineInfo[]): ChangeSpec[] {
  const groups = expandEnclosingFenceGroups(fencedBlocks(state), contiguousGroups(lines));
  if (groups.length === 0) return [];
  const unwraps = groups.map(group => fencedGroupBodyRange(group));
  const allFenced = unwraps.every(Boolean);

  return allFenced
    ? groups.map((group, index) => {
        const body = unwraps[index]!;
        const changes: ChangeSpec[] = [
          { from: group.first.from, to: body.from, insert: '' },
          { from: body.to, to: group.last.to, insert: '' },
        ];
        return changes;
      })
        .flat()
    : groups.map(group => {
        const body = state.doc.sliceString(group.first.from, group.last.to);
        const fence = safeBacktickFence(body);
        const changes: ChangeSpec[] = [
          { from: group.first.from, insert: `${fence}\n` },
          { from: group.last.to, insert: `\n${fence}` },
        ];
        return changes;
      })
        .flat();
}

function expandEnclosingFenceGroups(blocks: FencedBlock[], groups: LineGroup[]): LineGroup[] {
  const expanded: LineGroup[] = [];
  for (const group of groups) {
    const enclosing = enclosingFenceGroup(blocks, group) ?? group;
    const previous = expanded[expanded.length - 1];
    if (previous && enclosing.first.number <= previous.last.number) {
      if (enclosing.last.number > previous.last.number) previous.last = enclosing.last;
    } else {
      expanded.push({ first: enclosing.first, last: enclosing.last });
    }
  }
  return expanded;
}

function enclosingFenceGroup(blocks: FencedBlock[], group: LineGroup): LineGroup | null {
  for (const block of blocks) {
    const selectionInsideBody = group.first.number > block.open.number && group.last.number < block.close.number;
    if (selectionInsideBody) return { first: block.open, last: block.close };
  }
  return null;
}

function fencedBlocks(state: EditorState): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { line: LineInfo; marker: string } | null = null;

  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = lineInfo(state, number);
    if (open) {
      if (fenceCloseRe(open.marker).test(line.text)) {
        blocks.push({ open: open.line, close: line, marker: open.marker });
        open = null;
      }
      continue;
    }

    const opener = fenceOpen(line.text);
    if (opener) open = { line, marker: opener.marker };
  }

  return blocks;
}

function contiguousGroups(lines: LineInfo[]): LineGroup[] {
  const groups: LineGroup[] = [];
  let current: LineGroup | null = null;
  for (const line of lines) {
    if (!current || line.number !== current.last.number + 1) {
      current = { first: line, last: line };
      groups.push(current);
    } else {
      current.last = line;
    }
  }
  return groups;
}

function fencedGroupBodyRange(group: LineGroup): { from: number; to: number } | null {
  if (group.first.number >= group.last.number) return null;
  const open = fenceOpen(group.first.text);
  if (!open) return null;
  const closeRe = fenceCloseRe(open.marker);
  if (!closeRe.test(group.last.text)) return null;
  return {
    from: group.first.to + 1,
    to: Math.max(group.first.to + 1, group.last.from - 1),
  };
}

function lineInfo(state: EditorState, number: number): LineInfo {
  const line = state.doc.line(number);
  return { number, from: line.from, to: line.to, text: line.text };
}

function fenceOpen(text: string): { marker: string } | null {
  const open = /^(`{3,}|~{3,})[^`~]*$/.exec(text);
  return open ? { marker: open[1] } : null;
}

function fenceCloseRe(marker: string): RegExp {
  return new RegExp(`^${escapeRegExp(marker[0])}{${marker.length},}[ \\t]*$`);
}

function safeBacktickFence(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
