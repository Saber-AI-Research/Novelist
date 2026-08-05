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
  | { type: 'source'; text: string; copied: boolean }
  | { type: 'insertion'; insertion: LiteraryInsertion }
  | { type: 'caret' };

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

export function buildRenderPieces(file: LiteraryStudyFile): RenderPiece[] {
  const grouped = new Map<number, LiteraryInsertion[]>();
  for (const insertion of file.insertions) {
    const offset = clampOffset(file.source, insertion.sourceOffset);
    const items = grouped.get(offset) ?? [];
    items.push(insertion);
    grouped.set(offset, items);
  }
  for (const items of grouped.values()) items.sort((a, b) => a.order - b.order);

  const offsets = new Set<number>([0, file.sourceCursor, file.source.length, ...grouped.keys()]);
  const sorted = [...offsets].sort((a, b) => a - b);
  const pieces: RenderPiece[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const offset = sorted[index];
    for (const insertion of grouped.get(offset) ?? []) {
      pieces.push({ type: 'insertion', insertion });
    }
    if (offset === file.sourceCursor) pieces.push({ type: 'caret' });

    const nextOffset = sorted[index + 1];
    if (nextOffset === undefined || nextOffset <= offset) continue;
    pieces.push({
      type: 'source',
      text: file.source.slice(offset, nextOffset),
      copied: nextOffset <= file.sourceCursor,
    });
  }
  return pieces;
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
