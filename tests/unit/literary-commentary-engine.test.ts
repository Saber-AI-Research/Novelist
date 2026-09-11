import { describe, expect, it } from 'vitest';
import {
  applyBackspace,
  applyDeleteBackward,
  applyDeleteBackwardAtCaret,
  applyDelimitedInput,
  applyDelimitedInputAtCaret,
  applyInput,
  buildRenderPieces,
  clampCaret,
  insertAtCaret,
  moveCaret,
  normalizeStudyFile,
  renderedLength,
  renderedText,
  resolveCaret,
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
      { type: 'source', text: '最终，', copied: true, start: 0 },
      { type: 'source', text: '绝对', copied: false, start: null },
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

/**
 * Rewound editing: the caret used to be welded to the transcription frontier,
 * so a reader who noticed something two sentences back had no way to annotate
 * it. These lock in the rules that replaced that: free movement across copied
 * text, insertions editable anywhere, source characters read-only away from
 * the frontier.
 */
describe('[regression] literary commentary caret', () => {
  function copied(source = '最终，绝对', upTo = source.length): LiteraryStudyFile {
    return applyInput(study(source), source.slice(0, upTo), 'copy', false, '2026-08-02T00:00:00Z');
  }

  it('treats the frontier as the last caret index and clamps beyond it', () => {
    const file = copied('最终，绝对', 3);
    expect(renderedLength(file)).toBe(3);
    expect(renderedText(file)).toBe('最终，');
    expect(clampCaret(file, 99)).toBe(3);
    expect(clampCaret(file, -5)).toBe(0);
    expect(resolveCaret(file, 3).atFrontier).toBe(true);
    expect(resolveCaret(file, 1).atFrontier).toBe(false);
  });

  it('counts insertions as part of the rendered transcript', () => {
    const withComment = applyDelimitedInput(copied('最终，绝对', 3), '【好】', 'copy').file;
    // three copied source characters plus a one-character comment
    expect(renderedLength(withComment)).toBe(4);
    expect(renderedText(withComment)).toBe('最终，好');
  });

  it('steps left and right by code point and stops at both ends', () => {
    const file = copied('最终，绝对');
    expect(moveCaret(file, 5, 'left')).toBe(4);
    expect(moveCaret(file, 0, 'left')).toBe(0);
    expect(moveCaret(file, 4, 'right')).toBe(5);
    expect(moveCaret(file, 5, 'right')).toBe(5);
  });

  it('never lands the caret between the halves of a surrogate pair', () => {
    const file = copied('a𝄞b');
    // '𝄞' occupies UTF-16 offsets 1..3 — index 2 is not a legal caret stop.
    expect(clampCaret(file, 2)).toBe(1);
    expect(moveCaret(file, 3, 'left')).toBe(1);
    expect(moveCaret(file, 1, 'right')).toBe(3);
  });

  it('moves to the start and end of the current logical line', () => {
    const file = copied('第一行\n第二行');
    expect(moveCaret(file, 5, 'lineStart')).toBe(4);
    expect(moveCaret(file, 5, 'lineEnd')).toBe(7);
    expect(moveCaret(file, 1, 'lineStart')).toBe(0);
    expect(moveCaret(file, 1, 'lineEnd')).toBe(3);
  });

  it('renders the caret at a rewound position and splits the piece around it', () => {
    const pieces = buildRenderPieces(copied('最终，绝对', 3), 1);
    expect(pieces.map((p) => (p.type === 'caret' ? '|' : p.text))).toEqual([
      '最',
      '|',
      '终，',
      '绝对',
    ]);
  });

  it('inserts commentary at a rewound caret without moving the source cursor', () => {
    const file = copied('最终，绝对', 3);
    const result = applyDelimitedInputAtCaret(file, 1, '【好】', 'copy');
    expect(result.file.sourceCursor).toBe(3);
    expect(result.mode).toBe('copy');
    expect(result.file.insertions).toHaveLength(1);
    expect(result.file.insertions[0]).toMatchObject({ kind: 'comment', text: '好', sourceOffset: 1 });
    // Caret advanced past the text it just inserted.
    expect(result.caretIndex).toBe(2);
    expect(renderedText(result.file)).toBe('最好终，');
  });

  it('marks rewound plain typing as a mistake rather than consuming source', () => {
    const file = copied('最终，绝对', 3);
    const result = applyDelimitedInputAtCaret(file, 1, '错', 'copy');
    expect(result.file.sourceCursor).toBe(3);
    expect(result.file.insertions[0]).toMatchObject({ kind: 'mistake', text: '错' });
    expect(result.file.stats.mistakes).toBe(1);
  });

  it('extends an existing same-kind insertion instead of fragmenting it', () => {
    const file = copied('最终，绝对', 3);
    const first = applyDelimitedInputAtCaret(file, 1, '【好】', 'copy');
    const second = applyDelimitedInputAtCaret(first.file, first.caretIndex, '【句】', 'copy');
    expect(second.file.insertions).toHaveLength(1);
    expect(second.file.insertions[0].text).toBe('好句');
  });

  it('keeps newline and subsequent typing inside an earlier annotation', () => {
    const now = '2026-08-02T00:00:00Z';
    const original = applyDelimitedInput(
      study('北凉王府\n龙盘虎踞'), '北凉【风骨凛然】王府【后文评注】', 'copy', false, now,
    ).file;
    const newline = applyDelimitedInputAtCaret(original, 4, '\n', 'comment', false, now);

    expect(newline.caretIndex).toBe(5);
    expect(newline.mode).toBe('comment');
    expect(renderedText(newline.file)).toBe('北凉风骨\n凛然王府后文评注');

    const continued = applyDelimitedInputAtCaret(
      newline.file, newline.caretIndex, '续注', newline.mode, false, now,
    );
    expect(continued.caretIndex).toBe(7);
    expect(continued.mode).toBe('comment');
    expect(renderedText(continued.file)).toBe('北凉风骨\n续注凛然王府后文评注');
    expect(continued.file.source).toBe(original.source);
    expect(continued.file.sourceCursor).toBe(original.sourceCursor);
    expect(continued.file.insertions).toHaveLength(2);
    expect(continued.file.insertions.find((insertion) => insertion.id === original.insertions[0].id)).toMatchObject({
      id: original.insertions[0].id, kind: 'comment', sourceOffset: 2, text: '风骨\n续注凛然',
    });
    expect(continued.file.insertions.find((insertion) => insertion.id === original.insertions[1].id))
      .toEqual(original.insertions[1]);
    expect(continued.file.stats).toEqual(original.stats);
    expect(renderedText(original)).toBe('北凉风骨凛然王府后文评注');
  });

  it('transcribes a matching frontier newline and marks an unmatched newline as a mistake', () => {
    const now = '2026-08-02T00:00:00Z';
    const original = copied('首行\n续行', 2);
    const matched = applyDelimitedInputAtCaret(original, renderedLength(original), '\n', 'copy', false, now);
    expect(matched.file.sourceCursor).toBe(3);
    expect(matched.caretIndex).toBe(3);
    expect(matched.mode).toBe('copy');
    expect(matched.file.insertions).toEqual([]);
    expect(renderedText(matched.file)).toBe('首行\n');

    const unmatched = applyDelimitedInputAtCaret(
      matched.file, matched.caretIndex, '\n', matched.mode, false, now,
    );
    expect(unmatched.file.sourceCursor).toBe(3);
    expect(unmatched.caretIndex).toBe(4);
    expect(unmatched.file.insertions).toMatchObject([{ kind: 'mistake', sourceOffset: 3, text: '\n' }]);
    expect(unmatched.file.stats.mistakes).toBe(1);
    expect(renderedText(unmatched.file)).toBe('首行\n\n');
  });

  it('keeps a frontier newline in comment mode even when the source expects a newline', () => {
    const original = copied('首行\n续行', 2);
    const result = applyDelimitedInputAtCaret(
      original, renderedLength(original), '\n', 'comment', false, '2026-08-02T00:00:00Z',
    );
    expect(result.file.sourceCursor).toBe(2);
    expect(result.caretIndex).toBe(3);
    expect(result.mode).toBe('comment');
    expect(result.file.insertions).toMatchObject([{ kind: 'comment', sourceOffset: 2, text: '\n' }]);
    expect(result.file.stats.mistakes).toBe(0);
  });

  it('keeps a different-kind insertion separate when typed mid-run', () => {
    const file = copied('最终，绝对', 3);
    const commented = applyDelimitedInputAtCaret(file, 1, '【好句】', 'copy').file;
    // caret sits between 好 and 句 inside the comment
    const split = insertAtCaret(commented, 2, 'mistake', '×');
    const kinds = split.file.insertions
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((i) => `${i.kind}:${i.text}`);
    expect(kinds).toEqual(['comment:好', 'mistake:×', 'comment:句']);
    expect(renderedText(split.file)).toBe('最好×句终，');
  });

  it('backspace at a rewound caret deletes insertion text only', () => {
    const file = copied('最终，绝对', 3);
    const commented = applyDelimitedInputAtCaret(file, 1, '【好】', 'copy');
    const deleted = applyDeleteBackwardAtCaret(commented.file, commented.caretIndex, 'copy', 'character');
    expect(deleted.file.insertions).toHaveLength(0);
    expect(deleted.file.sourceCursor).toBe(3);
    expect(deleted.caretIndex).toBe(1);
  });

  it('refuses to un-transcribe source when the caret is rewound', () => {
    const file = copied('最终，绝对', 3);
    const result = applyDeleteBackwardAtCaret(file, 2, 'copy', 'character');
    expect(result.file.sourceCursor).toBe(3);
    expect(result.caretIndex).toBe(2);
  });

  it('still un-transcribes source when the caret is at the frontier', () => {
    const file = copied('最终，绝对', 3);
    const result = applyDeleteBackwardAtCaret(file, 3, 'copy', 'character');
    expect(result.file.sourceCursor).toBe(2);
    expect(result.caretIndex).toBe(2);
  });

  it('word delete at a rewound caret stops at the first source character', () => {
    const file = copied('最终，绝对', 3);
    const commented = applyDelimitedInputAtCaret(file, 1, '【good】', 'copy');
    const result = applyDeleteBackwardAtCaret(commented.file, commented.caretIndex, 'copy', 'word');
    expect(result.file.insertions).toHaveLength(0);
    expect(result.file.sourceCursor).toBe(3);
    expect(renderedText(result.file)).toBe('最终，');
  });
});
