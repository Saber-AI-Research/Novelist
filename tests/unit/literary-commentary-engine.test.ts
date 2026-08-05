import { describe, expect, it } from 'vitest';
import {
  applyBackspace,
  applyDeleteBackward,
  applyDelimitedInput,
  applyInput,
  buildRenderPieces,
  normalizeStudyFile,
  type LiteraryStudyFile,
} from '../../plugins/literary-commentary/src/engine';

function study(source = '最终，绝对'): LiteraryStudyFile {
  return normalizeStudyFile({
    schemaVersion: 1,
    book: { title: '雪中悍刀行', author: '烽火戏诸侯', language: 'zh-CN' },
    chapter: {
      id: 'c1',
      title: '第一章',
      volume: null,
      index: 1,
      total: 1,
      previousPath: null,
      nextPath: null,
    },
    source,
    sourceCursor: 0,
    insertions: [],
    stats: {
      correct: 0,
      mistakes: 0,
      pasted: 0,
      startedAt: null,
      completedAt: null,
    },
  });
}

describe('literary commentary engine', () => {
  it('advances matching source and leaves the remainder pending', () => {
    const next = applyInput(study(), '最终，', 'copy', false, '2026-08-02T00:00:00Z');
    expect(next.sourceCursor).toBe(3);
    const sources = buildRenderPieces(next).filter((piece) => piece.type === 'source');
    expect(sources).toEqual([
      { type: 'source', text: '最终，', copied: true },
      { type: 'source', text: '绝对', copied: false },
    ]);
  });

  it('inserts blue commentary without consuming source', () => {
    const copied = applyInput(study(), '最终，', 'copy');
    const commented = applyInput(copied, '气质出尘，评价极高，', 'comment');
    expect(commented.sourceCursor).toBe(3);
    expect(commented.insertions).toMatchObject([
      { sourceOffset: 3, kind: 'comment', text: '气质出尘，评价极高，' },
    ]);
  });

  it('uses full-width brackets to enter and leave inline commentary', () => {
    const result = applyDelimitedInput(
      study('最终，绝对'),
      '最终，【气质出尘】绝对',
      'copy',
      false,
      '2026-08-02T00:00:00Z',
    );

    expect(result.mode).toBe('copy');
    expect(result.file.sourceCursor).toBe(result.file.source.length);
    expect(result.file.insertions).toMatchObject([
      { sourceOffset: 3, kind: 'comment', text: '气质出尘' },
    ]);
  });

  it('transcribes a full-width opening bracket when the source expects it', () => {
    const result = applyDelimitedInput(study('【题记】正文'), '【题记】正文', 'copy');

    expect(result.mode).toBe('copy');
    expect(result.file.sourceCursor).toBe(result.file.source.length);
    expect(result.file.insertions).toEqual([]);
  });

  it('keeps comment mode open across committed input batches until a closing bracket', () => {
    const opened = applyDelimitedInput(study('正文'), '【第一句', 'copy');
    const closed = applyDelimitedInput(opened.file, '，第二句】正文', opened.mode);

    expect(opened.mode).toBe('comment');
    expect(closed.mode).toBe('copy');
    expect(closed.file.sourceCursor).toBe(closed.file.source.length);
    expect(closed.file.insertions).toMatchObject([
      { sourceOffset: 0, kind: 'comment', text: '第一句，第二句' },
    ]);
  });

  it('keeps mistakes red at the current source offset', () => {
    const copied = applyInput(study(), '最终，', 'copy');
    const mistaken = applyInput(copied, '决', 'copy');
    expect(mistaken.sourceCursor).toBe(3);
    expect(mistaken.insertions[0]).toMatchObject({
      sourceOffset: 3,
      kind: 'mistake',
      text: '决',
    });
    const corrected = applyInput(mistaken, '绝', 'copy');
    expect(corrected.sourceCursor).toBe(4);
  });

  it('backspace removes inline text before moving the source cursor', () => {
    const commented = applyInput(study(), '批注', 'comment');
    const shortened = applyBackspace(commented, 'comment');
    expect(shortened.insertions[0].text).toBe('批');
    const removed = applyBackspace(shortened, 'comment');
    expect(removed.insertions).toHaveLength(0);

    const copied = applyInput(study(), '最终，', 'copy');
    expect(applyBackspace(copied, 'copy').sourceCursor).toBe(2);
  });

  it('deletes commentary at the caret even after returning to copy mode', () => {
    const copied = applyInput(study('正文'), '正文', 'copy');
    const commented = applyInput(copied, '浅蓝批注', 'comment');

    const shortened = applyBackspace(commented, 'copy');
    expect(shortened.insertions).toMatchObject([
      { kind: 'comment', text: '浅蓝批' },
    ]);

    const wordDeleted = applyDeleteBackward(commented, 'copy', 'word');
    expect(wordDeleted.insertions).toHaveLength(0);
    expect(wordDeleted.sourceCursor).toBe(copied.sourceCursor);
  });

  it('deletes to the logical line start across comments and source text', () => {
    const copied = applyInput(study('第一行\n第二行'), '第一行\n第二行', 'copy');
    const commented = applyInput(copied, '行尾批注', 'comment');
    const deleted = applyDeleteBackward(commented, 'copy', 'line');

    expect(deleted.insertions).toHaveLength(0);
    expect(deleted.source.slice(0, deleted.sourceCursor)).toBe('第一行\n');
  });

  it('recomputes mistake statistics when mistaken text is deleted or loaded', () => {
    const mistaken = applyInput(study('甲'), '乙', 'copy');
    expect(mistaken.stats.mistakes).toBe(1);
    expect(applyBackspace(mistaken, 'copy').stats.mistakes).toBe(0);

    const normalized = normalizeStudyFile({
      ...study('甲'),
      stats: { ...study('甲').stats, mistakes: 17 },
    });
    expect(normalized.stats.mistakes).toBe(0);
  });

  it('counts Unicode code points while retaining UTF-16 source offsets', () => {
    const copied = applyInput(study('甲😀乙'), '甲😀', 'copy');
    expect(copied.sourceCursor).toBe(3);
    expect(copied.stats.correct).toBe(2);

    const backedUp = applyBackspace(copied, 'copy');
    expect(backedUp.sourceCursor).toBe(1);
    expect(backedUp.stats.correct).toBe(1);
  });

  it('normalizes a corrupt cursor away from the middle of a surrogate pair', () => {
    const normalized = normalizeStudyFile({
      ...study('甲😀乙'),
      sourceCursor: 2,
    });
    expect(normalized.sourceCursor).toBe(1);
    expect(normalized.stats.correct).toBe(1);
  });
});
