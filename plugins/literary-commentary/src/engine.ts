export type LiteraryMode = 'copy' | 'comment';
export type InsertionKind = 'comment' | 'mistake';

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

  return {
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
      correct: cursor,
      mistakes: Number(raw.stats?.mistakes) || 0,
      pasted: Number(raw.stats?.pasted) || 0,
      startedAt: raw.stats?.startedAt ?? null,
      completedAt: cursor >= raw.source.length
        ? (raw.stats?.completedAt ?? new Date().toISOString())
        : null,
    },
  };
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

export function applyBackspace(
  file: LiteraryStudyFile,
  mode: LiteraryMode,
  now = new Date().toISOString(),
): LiteraryStudyFile {
  const next = cloneFile(file);
  const preferredKind: InsertionKind = mode === 'comment' ? 'comment' : 'mistake';
  const index = findLatestInsertion(next, preferredKind, next.sourceCursor);
  if (index >= 0) {
    const insertion = next.insertions[index];
    insertion.text = removeLastCodePoint(insertion.text);
    if (!insertion.text) next.insertions.splice(index, 1);
    return finishMutation(next, now);
  }

  if (mode === 'copy' && next.sourceCursor > 0) {
    const prefix = next.source.slice(0, next.sourceCursor);
    const last = Array.from(prefix).at(-1);
    if (last) next.sourceCursor -= last.length;
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
  const existingIndex = findLatestInsertion(file, kind, file.sourceCursor);
  if (existingIndex >= 0) {
    file.insertions[existingIndex].text += text;
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

function findLatestInsertion(
  file: LiteraryStudyFile,
  kind: InsertionKind,
  sourceOffset: number,
): number {
  let found = -1;
  let order = -Infinity;
  file.insertions.forEach((insertion, index) => {
    if (
      insertion.kind === kind
      && insertion.sourceOffset === sourceOffset
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
  file.stats.correct = file.sourceCursor;
  file.stats.completedAt = file.sourceCursor >= file.source.length ? now : null;
  return file;
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
  return Math.max(0, Math.min(source.length, Math.trunc(value)));
}

function removeLastCodePoint(value: string): string {
  const characters = Array.from(value);
  characters.pop();
  return characters.join('');
}
