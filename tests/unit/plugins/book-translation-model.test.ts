import { describe, expect, it } from 'vitest';
import createdChapterRaw from '../../fixtures/book-translation/chapter.novtrans?raw';
import {
  parseBookTranslationFile,
  serializeBookTranslationFile,
  updateSegmentReference,
  updateSegmentTranslation,
  type BookTranslationFile,
} from '../../../plugins/book-translation/src/model';

function chapterFile(): BookTranslationFile {
  return {
    schemaVersion: 1,
    book: {
      title: '示例书',
      author: '作者',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    },
    chapter: {
      id: 'chapter-1',
      title: '第一章',
      volume: null,
      index: 1,
      total: 1,
      previousPath: null,
      nextPath: null,
    },
    segments: [
      {
        id: 'segment-0001',
        source: 'Hello',
        translation: '',
        googleReference: null,
        llmReference: null,
      },
      {
        id: 'segment-0002',
        source: '世界',
        translation: '',
        googleReference: null,
        llmReference: null,
      },
    ],
  };
}

describe('book translation model', () => {
  it('preserves CJK and empty translations through JSON round-trip', () => {
    const file = chapterFile();
    const parsed = parseBookTranslationFile(serializeBookTranslationFile(file));

    expect(parsed).toEqual(file);
    expect(parsed.segments.map((segment) => segment.source)).toEqual(['Hello', '世界']);
    expect(parsed.segments.map((segment) => segment.translation)).toEqual(['', '']);
  });

  it('[regression] re-serializes a Rust-created chapter byte for byte', () => {
    // Same fixture as book_translation.rs `chapter_bytes_match_the_plugin_serializer`:
    // publishing an unedited chapter must not change (and dirty) the file.
    expect(serializeBookTranslationFile(parseBookTranslationFile(createdChapterRaw))).toBe(createdChapterRaw);
  });

  it('normalizes old files with missing optional fields', () => {
    const parsed = parseBookTranslationFile(JSON.stringify({
      schemaVersion: 1,
      book: { title: 'Book', targetLanguage: 'zh-CN' },
      chapter: { id: 'one', title: 'Chapter' },
      segments: [{ id: 'segment-0001', source: 'Hello' }],
    }));

    expect(parsed.book.author).toBeNull();
    expect(parsed.book.sourceLanguage).toBeNull();
    expect(parsed.segments[0]).toEqual({
      id: 'segment-0001',
      source: 'Hello',
      translation: '',
      googleReference: null,
      llmReference: null,
    });
  });

  it('updates one segment without changing another segment', () => {
    const original = chapterFile();
    const updated = updateSegmentTranslation(original, 'segment-0001', '你好');

    expect(updated.segments[0].translation).toBe('你好');
    expect(updated.segments[1]).toEqual(original.segments[1]);
    expect(original.segments[0].translation).toBe('');
  });

  it('updates only the selected reference provider', () => {
    const original = chapterFile();
    const updated = updateSegmentReference(original, 'segment-0001', 'google', '你好');

    expect(updated.segments[0].googleReference).toBe('你好');
    expect(updated.segments[0].llmReference).toBeNull();
    expect(updated.segments[1]).toEqual(original.segments[1]);
  });

  it('rejects malformed and unsupported documents', () => {
    expect(() => parseBookTranslationFile('{')).toThrow(/invalid JSON/i);
    expect(() => parseBookTranslationFile(JSON.stringify({ schemaVersion: 2 })))
      .toThrow(/unsupported/i);
  });
});
