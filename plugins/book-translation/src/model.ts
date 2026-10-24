export type TranslationReferenceProvider = 'google' | 'llm';

export interface TranslationSegment {
  id: string;
  source: string;
  translation: string;
  googleReference: string | null;
  llmReference: string | null;
}

export interface BookTranslationBook {
  title: string;
  author: string | null;
  sourceLanguage: string | null;
  targetLanguage: string;
}

export interface BookTranslationChapter {
  id: string;
  title: string;
  volume: string | null;
  index: number;
  total: number;
  previousPath: string | null;
  nextPath: string | null;
}

export interface BookTranslationFile {
  schemaVersion: number;
  book: BookTranslationBook;
  chapter: BookTranslationChapter;
  segments: TranslationSegment[];
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Normalize the persisted chapter schema without mutating the parsed object. */
export function normalizeBookTranslationFile(value: unknown): BookTranslationFile {
  const raw = asRecord(value, 'Invalid book translation file');
  const schemaVersion = raw.schemaVersion === undefined ? 1 : raw.schemaVersion;
  if (schemaVersion !== 1) throw new Error(`Unsupported book translation schema version: ${String(schemaVersion)}`);

  const book = asRecord(raw.book, 'Book translation file is missing book metadata');
  const chapter = asRecord(raw.chapter, 'Book translation file is missing chapter metadata');
  if (typeof book.title !== 'string' || typeof book.targetLanguage !== 'string') {
    throw new Error('Book translation file is missing language or title metadata');
  }
  if (typeof chapter.id !== 'string' || typeof chapter.title !== 'string') {
    throw new Error('Book translation file is missing chapter metadata');
  }
  if (!Array.isArray(raw.segments)) throw new Error('Book translation file is missing segments');

  const segments = raw.segments.map((value, index) => {
    const segment = asRecord(value, `Invalid translation segment ${index + 1}`);
    if (typeof segment.id !== 'string' || typeof segment.source !== 'string') {
      throw new Error(`Translation segment ${index + 1} is missing an id or source`);
    }
    return {
      id: segment.id,
      source: segment.source,
      // Older files did not persist a translation until the user edited it.
      translation: typeof segment.translation === 'string' ? segment.translation : '',
      // Missing optional fields are deliberately represented as null in memory
      // and therefore become explicit nulls when the file is saved again.
      googleReference: nullableString(segment.googleReference),
      llmReference: nullableString(segment.llmReference),
    };
  });

  return {
    schemaVersion: 1,
    book: {
      title: book.title,
      author: nullableString(book.author),
      sourceLanguage: nullableString(book.sourceLanguage),
      targetLanguage: book.targetLanguage,
    },
    chapter: {
      id: chapter.id,
      title: chapter.title,
      volume: nullableString(chapter.volume),
      index: positiveInteger(chapter.index, 1),
      total: positiveInteger(chapter.total, 1),
      previousPath: nullableString(chapter.previousPath),
      nextPath: nullableString(chapter.nextPath),
    },
    segments,
  };
}

export function parseBookTranslationFile(content: string): BookTranslationFile {
  if (typeof content !== 'string') throw new Error('Book translation content must be text');
  try {
    return normalizeBookTranslationFile(JSON.parse(content));
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error('Book translation file contains invalid JSON');
    throw cause;
  }
}

export function serializeBookTranslationFile(file: BookTranslationFile): string {
  return `${JSON.stringify(normalizeBookTranslationFile(file), null, 2)}\n`;
}

/** Return a new file with exactly one segment's editable translation changed. */
export function updateSegmentTranslation(
  file: BookTranslationFile,
  segmentId: string,
  translation: string,
): BookTranslationFile {
  let found = false;
  const segments = file.segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    found = true;
    return { ...segment, translation };
  });
  return found ? { ...file, segments } : file;
}

/** Return a new file with exactly one provider reference changed. */
export function updateSegmentReference(
  file: BookTranslationFile,
  segmentId: string,
  provider: TranslationReferenceProvider,
  reference: string,
): BookTranslationFile {
  let found = false;
  const field = provider === 'google' ? 'googleReference' : 'llmReference';
  const segments = file.segments.map((segment) => {
    if (segment.id !== segmentId) return segment;
    found = true;
    return { ...segment, [field]: reference };
  });
  return found ? { ...file, segments } : file;
}

// Short aliases keep call sites readable and make the pure model useful to
// callers that already use "updateTranslation" terminology.
export const updateTranslation = updateSegmentTranslation;
export const updateReference = updateSegmentReference;
