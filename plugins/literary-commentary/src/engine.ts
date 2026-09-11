export type LiteraryMode = 'copy' | 'comment';
export type InsertionKind = 'comment' | 'mistake';
export type DeleteUnit = 'character' | 'word' | 'line';

export interface LiteraryInsertion {
  id: string;
  sourceOffset: number;
  order: number;
  kind: InsertionKind;
  text: string;
}

export interface LiteraryStudyFile {
  schemaVersion: number;
  book: {
    title: string;
    author: string | null;
    language: string | null;
  };
  chapter: {
    id: string;
    title: string;
    volume: string | null;
    index: number;
    total: number;
    previousPath: string | null;
    nextPath: string | null;
  };
  source: string;
  sourceCursor: number;
  insertions: LiteraryInsertion[];
  stats: {
    correct: number;
    mistakes: number;
    pasted: number;
    startedAt: string | null;
    completedAt: string | null;
  };
}

export type RenderPiece =
  | { type: 'source'; text: string; copied: boolean; start: number | null }
  | { type: 'insertion'; insertion: LiteraryInsertion; text: string; start: number }
  | { type: 'caret' };

/**
 * Where the insertion point sits, expressed against the *rendered* transcript.
 *
 * The document model only records how far the source has been transcribed
 * (`sourceCursor`). Editing used to happen exclusively at that frontier, which
 * made it impossible to rewind and annotate a passage already copied. A caret
 * index is a UTF-16 offset into the rendered copied region — source prefix
 * plus every insertion anchored inside it — so `0` is the top of the chapter
 * and `renderedLength(file)` is the frontier.
 */
export interface CaretAnchor {
  /** Source offset the caret sits at (how much source precedes it). */
  sourceOffset: number;
  /** Insertion the caret is inside, or `null` between source characters. */
  insertionId: string | null;
  /** UTF-16 offset inside that insertion's text. */
  textIndex: number;
  /** True when the caret is at the transcription frontier. */
  atFrontier: boolean;
}

type CopiedSegment =
  | { kind: 'source'; from: number; to: number }
  | { kind: 'insertion'; insertion: LiteraryInsertion };

export function normalizeStudyFile(value: unknown): LiteraryStudyFile {
  if (!value || typeof value !== 'object') throw new Error('无效的文学评注文件');
  const raw = value as Partial<LiteraryStudyFile>;
  if (typeof raw.source !== 'string' || !raw.chapter || !raw.book) {
    throw new Error('文学评注文件缺少原文或章节信息');
  }
  const cursor = clampOffset(raw.source, Number(raw.sourceCursor) || 0);
  const insertions = Array.isArray(raw.insertions)
    ? raw.insertions
        .filter((item): item is LiteraryInsertion =>
          !!item
          && typeof item.id === 'string'
          && typeof item.text === 'string'
          && (item.kind === 'comment' || item.kind === 'mistake'),
        )
        .map((item, index) => ({
          ...item,
          sourceOffset: clampOffset(raw.source!, Number(item.sourceOffset) || 0),
          order: Number.isFinite(item.order) ? item.order : index,
        }))
    : [];

  const normalized: LiteraryStudyFile = {
    schemaVersion: Number(raw.schemaVersion) || 1,
    book: {
      title: String(raw.book.title ?? ''),
      author: raw.book.author ?? null,
      language: raw.book.language ?? null,
    },
    chapter: {
      id: String(raw.chapter.id ?? ''),
      title: String(raw.chapter.title ?? ''),
      volume: raw.chapter.volume ?? null,
      index: Number(raw.chapter.index) || 1,
      total: Number(raw.chapter.total) || 1,
      previousPath: raw.chapter.previousPath ?? null,
      nextPath: raw.chapter.nextPath ?? null,
    },
    source: raw.source,
    sourceCursor: cursor,
    insertions,
    stats: {
      correct: countSourceCharacters(raw.source, cursor),
      mistakes: countInsertionCharacters(insertions, 'mistake'),
      pasted: Number(raw.stats?.pasted) || 0,
      startedAt: raw.stats?.startedAt ?? null,
      completedAt: cursor >= raw.source.length
        ? (raw.stats?.completedAt ?? new Date().toISOString())
        : null,
    },
  };
  return normalized;
}

// ── caret geometry over the rendered transcript ──────────────────────────────

function groupInsertions(file: LiteraryStudyFile): Map<number, LiteraryInsertion[]> {
  const grouped = new Map<number, LiteraryInsertion[]>();
  for (const insertion of file.insertions) {
    const offset = clampOffset(file.source, insertion.sourceOffset);
    const items = grouped.get(offset) ?? [];
    items.push(insertion);
    grouped.set(offset, items);
  }
  for (const items of grouped.values()) items.sort((a, b) => a.order - b.order);
  return grouped;
}

/**
 * The transcribed region as an ordered run of segments. Insertions anchored at
 * offset `O` render immediately *before* the source character at `O`, which is
 * what puts a comment after the character it comments on.
 */
function copiedSegments(file: LiteraryStudyFile): CopiedSegment[] {
  const grouped = groupInsertions(file);
  const cursor = file.sourceCursor;
  const offsets = [...grouped.keys()].filter((o) => o <= cursor).sort((a, b) => a - b);
  const segments: CopiedSegment[] = [];
  let pos = 0;
  for (const offset of offsets) {
    if (offset > pos) segments.push({ kind: 'source', from: pos, to: offset });
    pos = Math.max(pos, offset);
    for (const insertion of grouped.get(offset) ?? []) {
      segments.push({ kind: 'insertion', insertion });
    }
  }
  if (cursor > pos) segments.push({ kind: 'source', from: pos, to: cursor });
  return segments;
}

function segmentLength(segment: CopiedSegment): number {
  return segment.kind === 'source'
    ? segment.to - segment.from
    : segment.insertion.text.length;
}

/** UTF-16 length of everything the reader has transcribed so far. */
export function renderedLength(file: LiteraryStudyFile): number {
  return copiedSegments(file).reduce((total, s) => total + segmentLength(s), 0);
}

/** The transcribed region as plain text — used for caret stepping and line moves. */
export function renderedText(file: LiteraryStudyFile): string {
  return copiedSegments(file)
    .map((s) => (s.kind === 'source' ? file.source.slice(s.from, s.to) : s.insertion.text))
    .join('');
}

export function clampCaret(file: LiteraryStudyFile, caretIndex: number): number {
  const max = renderedLength(file);
  if (!Number.isFinite(caretIndex)) return max;
  const bounded = Math.max(0, Math.min(max, Math.trunc(caretIndex)));
  // Never park between the halves of a surrogate pair.
  const text = renderedText(file);
  if (
    bounded > 0
    && bounded < text.length
    && isHighSurrogate(text.charCodeAt(bounded - 1))
    && isLowSurrogate(text.charCodeAt(bounded))
  ) {
    return bounded - 1;
  }
  return bounded;
}

export function resolveCaret(file: LiteraryStudyFile, caretIndex: number): CaretAnchor {
  const index = clampCaret(file, caretIndex);
  let seen = 0;
  for (const segment of copiedSegments(file)) {
    const length = segmentLength(segment);
    if (index < seen + length) {
      const within = Math.max(0, index - seen);
      return segment.kind === 'insertion'
        ? {
            sourceOffset: clampOffset(file.source, segment.insertion.sourceOffset),
            insertionId: segment.insertion.id,
            textIndex: within,
            atFrontier: false,
          }
        : {
            sourceOffset: segment.from + within,
            insertionId: null,
            textIndex: 0,
            atFrontier: false,
          };
    }
    seen += length;
  }
  return {
    sourceOffset: file.sourceCursor,
    insertionId: null,
    textIndex: 0,
    atFrontier: true,
  };
}

export type CaretMove = 'left' | 'right' | 'lineStart' | 'lineEnd' | 'documentStart' | 'documentEnd';

/**
 * Step the caret through the transcript. Movement is code-point aware so a
 * single arrow press never lands inside an astral character, and it is capped
 * at the frontier — the pending grey source is not yet part of the document.
 */
export function moveCaret(
  file: LiteraryStudyFile,
  caretIndex: number,
  move: CaretMove,
): number {
  const text = renderedText(file);
  const index = clampCaret(file, caretIndex);
  switch (move) {
    case 'left': {
      if (index <= 0) return 0;
      const step = isLowSurrogate(text.charCodeAt(index - 1))
        && index >= 2
        && isHighSurrogate(text.charCodeAt(index - 2))
        ? 2
        : 1;
      return index - step;
    }
    case 'right': {
      if (index >= text.length) return text.length;
      const step = isHighSurrogate(text.charCodeAt(index))
        && index + 1 < text.length
        && isLowSurrogate(text.charCodeAt(index + 1))
        ? 2
        : 1;
      return index + step;
    }
    case 'lineStart': {
      const previousBreak = text.lastIndexOf('\n', index - 1);
      return previousBreak === -1 ? 0 : previousBreak + 1;
    }
    case 'lineEnd': {
      const nextBreak = text.indexOf('\n', index);
      return nextBreak === -1 ? text.length : nextBreak;
    }
    case 'documentStart':
      return 0;
    case 'documentEnd':
      return text.length;
  }
}

export function applyInput(
  file: LiteraryStudyFile,
  input: string,
  mode: LiteraryMode,
  pasted = false,
  now = new Date().toISOString(),
): LiteraryStudyFile {
  if (!input) return file;
  const next = cloneFile(file);
  next.stats.startedAt ??= now;
  if (pasted) next.stats.pasted += Array.from(input).length;

  if (mode === 'comment') {
    appendInsertion(next, 'comment', input);
    return finishMutation(next, now);
  }

  let mistakeBuffer = '';
  const flushMistake = () => {
    if (!mistakeBuffer) return;
    appendInsertion(next, 'mistake', mistakeBuffer);
    next.stats.mistakes += Array.from(mistakeBuffer).length;
    mistakeBuffer = '';
  };

  for (const character of input) {
    if (next.source.startsWith(character, next.sourceCursor)) {
      flushMistake();
      next.sourceCursor += character.length;
    } else {
      mistakeBuffer += character;
    }
  }
  flushMistake();
  return finishMutation(next, now);
}

/**
 * Apply normal transcription plus inline comments from one committed input
 * batch. Full-width brackets are control characters unless the source itself
 * expects an opening bracket at the current cursor:
 *
 *   source text【inline comment】more source text
 *
 * This function only receives committed text. IME composition guarding lives
 * in App.svelte so pinyin/pre-edit updates never reach the document model.
 */
export function applyDelimitedInput(
  file: LiteraryStudyFile,
  input: string,
  initialMode: LiteraryMode,
  pasted = false,
  now = new Date().toISOString(),
): { file: LiteraryStudyFile; mode: LiteraryMode } {
  let next = file;
  let mode = initialMode;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    next = applyInput(next, buffer, mode, pasted, now);
    buffer = '';
  };

  for (const character of input) {
    if (mode === 'copy' && character === '【') {
      flush();
      // A real opening bracket in the source must remain transcribable. The
      // keyboard shortcut can still force comment mode at this position.
      if (!next.source.startsWith(character, next.sourceCursor)) {
        mode = 'comment';
        continue;
      }
    } else if (mode === 'comment' && character === '】') {
      flush();
      mode = 'copy';
      continue;
    }
    buffer += character;
  }
  flush();

  return { file: next, mode };
}

export function applyBackspace(
  file: LiteraryStudyFile,
  mode: LiteraryMode,
  now = new Date().toISOString(),
): LiteraryStudyFile {
  return applyDeleteBackward(file, mode, 'character', now);
}

/**
 * Delete from the rendered tail just like a normal editor. Inline comments
 * and mistakes at the caret are part of that tail regardless of the current
 * input mode, so leaving comment mode never makes a comment undeletable.
 */
export function applyDeleteBackward(
  file: LiteraryStudyFile,
  _mode: LiteraryMode,
  unit: DeleteUnit,
  now = new Date().toISOString(),
): LiteraryStudyFile {
  const next = cloneFile(file);
  if (unit === 'character') {
    removePreviousCharacter(next);
  } else if (unit === 'line') {
    let previous = peekPrevious(next)?.character ?? null;
    while (previous && previous !== '\n') {
      removePreviousCharacter(next);
      previous = peekPrevious(next)?.character ?? null;
    }
  } else {
    let previous = peekPrevious(next);
    const segment = previous?.segment;
    while (previous && previous.segment === segment && isWhitespace(previous.character)) {
      removePreviousCharacter(next);
      previous = peekPrevious(next);
    }
    if (previous && previous.segment === segment) {
      const category = deletionCategory(previous.character);
      while (
        previous
        && previous.segment === segment
        && deletionCategory(previous.character) === category
      ) {
        removePreviousCharacter(next);
        previous = peekPrevious(next);
      }
    }
  }
  return finishMutation(next, now);
}

/**
 * Flatten the study file into inline pieces, with the caret marker placed at
 * `caretIndex` (defaults to the frontier). Copied pieces carry the rendered
 * offset they start at so the view can map a click back to a caret index.
 */
export function buildRenderPieces(
  file: LiteraryStudyFile,
  caretIndex: number = renderedLength(file),
): RenderPiece[] {
  const caret = clampCaret(file, caretIndex);
  const pieces: RenderPiece[] = [];
  let seen = 0;
  let caretEmitted = false;

  const emitCaret = () => {
    pieces.push({ type: 'caret' });
    caretEmitted = true;
  };

  for (const segment of copiedSegments(file)) {
    if (!caretEmitted && caret === seen) emitCaret();
    const length = segmentLength(segment);
    const split = !caretEmitted && caret > seen && caret < seen + length
      ? caret - seen
      : -1;

    if (segment.kind === 'source') {
      const text = file.source.slice(segment.from, segment.to);
      if (split < 0) {
        pieces.push({ type: 'source', text, copied: true, start: seen });
      } else {
        pieces.push({ type: 'source', text: text.slice(0, split), copied: true, start: seen });
        emitCaret();
        pieces.push({
          type: 'source',
          text: text.slice(split),
          copied: true,
          start: seen + split,
        });
      }
    } else {
      const { insertion } = segment;
      if (split < 0) {
        pieces.push({ type: 'insertion', insertion, text: insertion.text, start: seen });
      } else {
        pieces.push({
          type: 'insertion',
          insertion,
          text: insertion.text.slice(0, split),
          start: seen,
        });
        emitCaret();
        pieces.push({
          type: 'insertion',
          insertion,
          text: insertion.text.slice(split),
          start: seen + split,
        });
      }
    }
    seen += length;
  }

  if (!caretEmitted) emitCaret();

  // Anything anchored past the frontier would be unreachable by the caret, so
  // it is rendered after it, followed by the untranscribed source tail.
  const grouped = groupInsertions(file);
  for (const offset of [...grouped.keys()].filter((o) => o > file.sourceCursor).sort((a, b) => a - b)) {
    for (const insertion of grouped.get(offset) ?? []) {
      pieces.push({ type: 'insertion', insertion, text: insertion.text, start: seen });
    }
  }
  if (file.sourceCursor < file.source.length) {
    pieces.push({
      type: 'source',
      text: file.source.slice(file.sourceCursor),
      copied: false,
      start: null,
    });
  }
  return pieces;
}

// ── editing away from the frontier ───────────────────────────────────────────

/**
 * The source text is the model being studied: it is fixed, and the reader's
 * own output lives entirely in insertions. So a rewound caret can create and
 * edit insertions freely, but source characters stay read-only — they can only
 * be un-transcribed by backspacing at the frontier itself.
 */
function writeGroup(
  file: LiteraryStudyFile,
  sourceOffset: number,
  group: LiteraryInsertion[],
): void {
  const merged: LiteraryInsertion[] = [];
  for (const insertion of group) {
    if (!insertion.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.kind === insertion.kind) {
      previous.text += insertion.text;
      continue;
    }
    merged.push(insertion);
  }
  // Orders only rank insertions within one anchor, so renumbering a group is
  // local — but the base must stay above every other order so a later
  // frontier append (max + 1) still sorts last.
  const base = file.insertions.reduce((max, i) => Math.max(max, i.order), -1) + 1;
  merged.forEach((insertion, index) => {
    insertion.sourceOffset = sourceOffset;
    insertion.order = base + index;
  });
  file.insertions = file.insertions
    .filter((i) => clampOffset(file.source, i.sourceOffset) !== sourceOffset)
    .concat(merged);
}

function newInsertion(
  sourceOffset: number,
  kind: InsertionKind,
  text: string,
  seed: number,
): LiteraryInsertion {
  return {
    id: `${kind}-${Date.now()}-${seed}`,
    sourceOffset,
    order: 0, // assigned by writeGroup
    kind,
    text,
  };
}

/** Splice `text` into the transcript at `caretIndex`, as an insertion of `kind`. */
export function insertAtCaret(
  file: LiteraryStudyFile,
  caretIndex: number,
  kind: InsertionKind,
  text: string,
  now = new Date().toISOString(),
): { file: LiteraryStudyFile; caretIndex: number } {
  if (!text) return { file, caretIndex: clampCaret(file, caretIndex) };
  const anchor = resolveCaret(file, caretIndex);
  const next = cloneFile(file);
  next.stats.startedAt ??= now;

  const group = groupInsertions(next).get(anchor.sourceOffset) ?? [];
  let gi = anchor.insertionId
    ? group.findIndex((i) => i.id === anchor.insertionId)
    : group.length;
  if (gi < 0) gi = group.length;
  const ti = anchor.insertionId ? anchor.textIndex : 0;

  const target = group[gi];
  if (target && target.kind === kind) {
    // Caret is inside (or at the head of) a run of the same kind — just type into it.
    target.text = target.text.slice(0, ti) + text + target.text.slice(ti);
  } else if (ti > 0 && target && ti < target.text.length) {
    // Different kind, mid-run: split it so the new text keeps its own styling.
    const tail = target.text.slice(ti);
    target.text = target.text.slice(0, ti);
    group.splice(gi + 1, 0, newInsertion(anchor.sourceOffset, kind, text, gi + 1));
    group.splice(gi + 2, 0, newInsertion(anchor.sourceOffset, target.kind, tail, gi + 2));
  } else {
    const at = ti > 0 ? gi + 1 : gi;
    const previous = group[at - 1];
    if (previous && previous.kind === kind) {
      previous.text += text;
    } else {
      group.splice(at, 0, newInsertion(anchor.sourceOffset, kind, text, at));
    }
  }

  writeGroup(next, anchor.sourceOffset, group);
  return {
    file: finishMutation(next, now),
    caretIndex: clampCaret(next, caretIndex + text.length),
  };
}

/**
 * Apply one committed input batch at the caret.
 *
 * At the frontier this is the existing transcribe-or-mark behaviour. Rewound,
 * there is no pending source character to match, so every typed character
 * becomes an insertion — commentary in comment mode, a mistake mark otherwise
 * — and the full-width brackets keep working as the comment delimiters.
 */
export function applyDelimitedInputAtCaret(
  file: LiteraryStudyFile,
  caretIndex: number,
  input: string,
  initialMode: LiteraryMode,
  pasted = false,
  now = new Date().toISOString(),
): { file: LiteraryStudyFile; mode: LiteraryMode; caretIndex: number } {
  if (resolveCaret(file, caretIndex).atFrontier) {
    const result = applyDelimitedInput(file, input, initialMode, pasted, now);
    return {
      file: result.file,
      mode: result.mode,
      caretIndex: renderedLength(result.file),
    };
  }

  let next = file;
  let index = clampCaret(file, caretIndex);
  let mode = initialMode;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    const kind: InsertionKind = mode === 'comment' ? 'comment' : 'mistake';
    if (pasted) {
      next = cloneFile(next);
      next.stats.pasted += Array.from(buffer).length;
    }
    const result = insertAtCaret(next, index, kind, buffer, now);
    next = result.file;
    index = result.caretIndex;
    buffer = '';
  };

  for (const character of input) {
    if (mode === 'copy' && character === '【') {
      flush();
      mode = 'comment';
      continue;
    }
    if (mode === 'comment' && character === '】') {
      flush();
      mode = 'copy';
      continue;
    }
    buffer += character;
  }
  flush();

  return { file: next, mode, caretIndex: index };
}

/**
 * Backspace at the caret.
 *
 * At the frontier this is the existing behaviour (delete inline text, then
 * un-transcribe source). Rewound, deletion stops at the first source
 * character: the model text is not the reader's to erase.
 */
export function applyDeleteBackwardAtCaret(
  file: LiteraryStudyFile,
  caretIndex: number,
  mode: LiteraryMode,
  unit: DeleteUnit,
  now = new Date().toISOString(),
): { file: LiteraryStudyFile; caretIndex: number } {
  if (resolveCaret(file, caretIndex).atFrontier) {
    const next = applyDeleteBackward(file, mode, unit, now);
    return { file: next, caretIndex: renderedLength(next) };
  }

  let next = file;
  let index = clampCaret(file, caretIndex);

  const peek = (): { character: string; insertionId: string } | null => {
    if (index <= 0) return null;
    const previous = moveCaret(next, index, 'left');
    const anchor = resolveCaret(next, previous);
    if (!anchor.insertionId) return null;
    const insertion = next.insertions.find((i) => i.id === anchor.insertionId);
    if (!insertion) return null;
    return {
      character: insertion.text.slice(anchor.textIndex, index - previous + anchor.textIndex),
      insertionId: anchor.insertionId,
    };
  };

  const removeOne = (): boolean => {
    const previous = peek();
    if (!previous) return false;
    const at = moveCaret(next, index, 'left');
    const anchor = resolveCaret(next, at);
    const clone = cloneFile(next);
    const insertion = clone.insertions.find((i) => i.id === anchor.insertionId);
    if (!insertion) return false;
    insertion.text =
      insertion.text.slice(0, anchor.textIndex)
      + insertion.text.slice(anchor.textIndex + (index - at));
    if (!insertion.text) {
      clone.insertions = clone.insertions.filter((i) => i.id !== insertion.id);
    }
    next = finishMutation(clone, now);
    index = at;
    return true;
  };

  if (unit === 'character') {
    removeOne();
  } else if (unit === 'line') {
    let previous = peek();
    while (previous && previous.character !== '\n' && removeOne()) {
      previous = peek();
    }
  } else {
    let previous = peek();
    while (previous && isWhitespace(previous.character) && removeOne()) {
      previous = peek();
    }
    previous = peek();
    if (previous) {
      const category = deletionCategory(previous.character);
      while (previous && deletionCategory(previous.character) === category && removeOne()) {
        previous = peek();
      }
    }
  }

  return { file: next, caretIndex: clampCaret(next, index) };
}

function appendInsertion(
  file: LiteraryStudyFile,
  kind: InsertionKind,
  text: string,
): void {
  const tailIndex = findLatestInsertionAtOffset(file, file.sourceCursor);
  if (tailIndex >= 0 && file.insertions[tailIndex].kind === kind) {
    file.insertions[tailIndex].text += text;
    return;
  }
  const nextOrder = file.insertions.reduce((max, insertion) => Math.max(max, insertion.order), -1) + 1;
  file.insertions.push({
    id: `${kind}-${Date.now()}-${nextOrder}`,
    sourceOffset: file.sourceCursor,
    order: nextOrder,
    kind,
    text,
  });
}

function findLatestInsertionAtOffset(
  file: LiteraryStudyFile,
  sourceOffset: number,
): number {
  let found = -1;
  let order = -Infinity;
  file.insertions.forEach((insertion, index) => {
    if (
      insertion.sourceOffset === sourceOffset
      && insertion.order >= order
    ) {
      found = index;
      order = insertion.order;
    }
  });
  return found;
}

function finishMutation(file: LiteraryStudyFile, now: string): LiteraryStudyFile {
  file.sourceCursor = clampOffset(file.source, file.sourceCursor);
  file.stats.correct = countSourceCharacters(file.source, file.sourceCursor);
  file.stats.mistakes = countInsertionCharacters(file.insertions, 'mistake');
  file.stats.completedAt = file.sourceCursor >= file.source.length ? now : null;
  return file;
}

function peekPrevious(
  file: LiteraryStudyFile,
): { character: string; segment: string } | null {
  const insertionIndex = findLatestInsertionAtOffset(file, file.sourceCursor);
  if (insertionIndex >= 0) {
    const insertion = file.insertions[insertionIndex];
    const character = Array.from(insertion.text).at(-1);
    return character ? { character, segment: `insertion:${insertion.id}` } : null;
  }
  if (file.sourceCursor <= 0) return null;
  const character = Array.from(file.source.slice(0, file.sourceCursor)).at(-1);
  return character ? { character, segment: 'source' } : null;
}

function removePreviousCharacter(file: LiteraryStudyFile): string | null {
  const insertionIndex = findLatestInsertionAtOffset(file, file.sourceCursor);
  if (insertionIndex >= 0) {
    const insertion = file.insertions[insertionIndex];
    const characters = Array.from(insertion.text);
    const removed = characters.pop() ?? null;
    insertion.text = characters.join('');
    if (!insertion.text) file.insertions.splice(insertionIndex, 1);
    return removed;
  }

  if (file.sourceCursor <= 0) return null;
  const prefix = file.source.slice(0, file.sourceCursor);
  const removed = Array.from(prefix).at(-1) ?? null;
  if (removed) file.sourceCursor -= removed.length;
  return removed;
}

function deletionCategory(character: string): 'word' | 'punctuation' {
  return /[\p{L}\p{M}\p{N}_]/u.test(character) ? 'word' : 'punctuation';
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function countInsertionCharacters(
  insertions: LiteraryInsertion[],
  kind: InsertionKind,
): number {
  return insertions
    .filter((insertion) => insertion.kind === kind)
    .reduce((total, insertion) => total + Array.from(insertion.text).length, 0);
}

function cloneFile(file: LiteraryStudyFile): LiteraryStudyFile {
  return {
    ...file,
    book: { ...file.book },
    chapter: { ...file.chapter },
    insertions: file.insertions.map((insertion) => ({ ...insertion })),
    stats: { ...file.stats },
  };
}

function clampOffset(source: string, value: number): number {
  const bounded = Math.max(0, Math.min(source.length, Math.trunc(value)));
  if (
    bounded > 0
    && bounded < source.length
    && isHighSurrogate(source.charCodeAt(bounded - 1))
    && isLowSurrogate(source.charCodeAt(bounded))
  ) {
    return bounded - 1;
  }
  return bounded;
}

function countSourceCharacters(source: string, cursor: number): number {
  return Array.from(source.slice(0, clampOffset(source, cursor))).length;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
