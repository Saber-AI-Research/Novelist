import { describe, expect, it } from 'vitest';
import {
  applyBackspace,
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
});
