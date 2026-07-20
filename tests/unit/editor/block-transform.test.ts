import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { blockTransformSpec, type BlockTransformTarget } from '$lib/editor/block-transform';

function apply(doc: string, target: BlockTransformTarget, selection = EditorSelection.single(0, doc.length)) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  const spec = blockTransformSpec(state, target);
  expect(spec).not.toBeNull();
  const next = state.update(spec!).state;
  return { doc: next.doc.toString(), selection: next.selection };
}

describe('[precision] blockTransformSpec', () => {
  it.each([
    ['heading-1', '# Title'],
    ['heading-2', '## Title'],
    ['heading-3', '### Title'],
    ['heading-4', '#### Title'],
    ['heading-5', '##### Title'],
    ['heading-6', '###### Title'],
  ] as const)('applies %s to a paragraph', (target, expected) => {
    const result = apply('Title', target);

    expect(result.doc).toBe(expected);
  });

  it('expands partial selections to touched full lines', () => {
    const doc = 'alpha\nbravo\ncharlie';
    const result = apply(doc, 'heading-2', EditorSelection.single(2, 9));

    expect(result.doc).toBe('## alpha\n## bravo\ncharlie');
  });

  it('maps CJK selection positions through inserted block prefixes', () => {
    const doc = '开头\n你好世界\n结尾';
    const from = doc.indexOf('好');
    const to = from + '好世'.length;
    const result = apply(doc, 'quote', EditorSelection.single(from, to));

    expect(result.doc).toBe('开头\n> 你好世界\n结尾');
    expect(result.selection.main.from).toBe(from + 2);
    expect(result.selection.main.to).toBe(to + 2);
  });

  it('toggles an all-target heading selection back to paragraphs', () => {
    const result = apply('### 第一章\n### 第二章', 'heading-3');

    expect(result.doc).toBe('第一章\n第二章');
  });

  it('converts any supported block target back to paragraph text', () => {
    const doc = '# title\n> quote\n* bullet\n7. ordered\n+ [x] task\nplain';
    const result = apply(doc, 'paragraph');

    expect(result.doc).toBe('title\nquote\nbullet\nordered\ntask\nplain');
  });

  it.each([
    ['quote', '> alpha\n> beta'],
    ['unordered-list', '* alpha\n+ beta'],
    ['ordered-list', '4. alpha\n5. beta'],
    ['task-list', '* [x] alpha\n+ [ ] beta'],
  ] as const)('toggles an all-target %s selection back to paragraphs', (target, doc) => {
    const result = apply(doc, target);

    expect(result.doc).toBe('alpha\nbeta');
  });

  it('normalizes mixed block types to the requested heading without content loss', () => {
    const doc = '# Title\n> quote\n- bullet\n1. ordered\n- [x] done\nplain';
    const result = apply(doc, 'heading-4');

    expect(result.doc).toBe('#### Title\n#### quote\n#### bullet\n#### ordered\n#### done\n#### plain');
  });

  it('keeps blank lines unprefixed for non-code transforms', () => {
    const result = apply('alpha\n\nbravo', 'unordered-list');

    expect(result.doc).toBe('- alpha\n\n- bravo');
  });

  it('preserves existing unordered markers when normalizing mixed lines to unordered list', () => {
    const doc = '* star\n+ plus\nplain\n1. ordered\n- dash';
    const result = apply(doc, 'unordered-list');

    expect(result.doc).toBe('* star\n+ plus\n- plain\n- ordered\n- dash');
  });

  it('renumbers ordered lists deterministically per contiguous nonblank group', () => {
    const doc = '- alpha\n\n12. bravo\n> charlie\n- [ ] delta';
    const result = apply(doc, 'ordered-list');

    expect(result.doc).toBe('1. alpha\n\n1. bravo\n2. charlie\n3. delta');
  });

  it('preserves existing task checkbox state when normalizing to task list', () => {
    const doc = '- [x] done\n- [ ] todo\nplain\n> quoted';
    const result = apply(doc, 'task-list');

    expect(result.doc).toBe('- [x] done\n- [ ] todo\n- [ ] plain\n- [ ] quoted');
  });

  it('preserves supported markers, checkbox state, and indentation in mixed task-list normalization', () => {
    const doc = '  * [x] 已完成\n\t- [ ] todo\n* 普通条目\n  - nested';
    const result = apply(doc, 'task-list');

    expect(result.doc).toBe('  * [x] 已完成\n\t- [ ] todo\n* [ ] 普通条目\n  - [ ] nested');
  });

  it('uses the unchecked dash fallback for unsupported or markerless mixed task-list input', () => {
    const doc = '+ plus bullet\n+ [x] plus task\n1. ordered\nplain';
    const result = apply(doc, 'task-list');

    expect(result.doc).toBe('- [ ] plus bullet\n- [x] plus task\n- [ ] ordered\n- [ ] plain');
  });

  it('preserves supported task markers and indentation when converting tasks to unordered list', () => {
    const doc = '  * [x] 第一章\n\t- [ ] 第二章\nplain';
    const result = apply(doc, 'unordered-list');

    expect(result.doc).toBe('  * 第一章\n\t- 第二章\n- plain');
  });

  it.each([
    ['task-list', '  * [x] 第一章\n\t- [ ] 第二章'],
    ['unordered-list', '  * 第一章\n\t- 第二章'],
  ] as const)('preserves indentation when an all-target %s selection toggles to paragraph', (target, doc) => {
    const result = apply(doc, target);

    expect(result.doc).toBe('  第一章\n\t第二章');
  });

  it('deduplicates touched lines across multiple ranges', () => {
    const doc = 'same line\nnext line';
    const selection = EditorSelection.create([
      EditorSelection.range(1, 4),
      EditorSelection.range(5, 9),
      EditorSelection.range(12, 16),
    ]);
    const result = apply(doc, 'quote', selection);

    expect(result.doc).toBe('> same line\n> next line');
  });

  it('maps all selection ranges and preserves mainIndex for multi-range edits', () => {
    const doc = 'alpha\nbravo\ncharlie';
    const selection = EditorSelection.create([
      EditorSelection.range(1, 3),
      EditorSelection.range(8, 11),
      EditorSelection.range(15, 18),
    ], 1);
    const result = apply(doc, 'unordered-list', selection);

    expect(result.doc).toBe('- alpha\n- bravo\n- charlie');
    expect(result.selection.mainIndex).toBe(1);
    expect(result.selection.ranges.map(range => [range.anchor, range.head])).toEqual([
      [3, 5],
      [12, 15],
      [21, 24],
    ]);
  });

  it('preserves reversed anchor/head direction while mapping selections', () => {
    const result = apply('alpha\nbravo', 'quote', EditorSelection.single(9, 2));

    expect(result.doc).toBe('> alpha\n> bravo');
    expect(result.selection.main.anchor).toBe(13);
    expect(result.selection.main.head).toBe(4);
  });

  it('returns null for an empty document no-op cursor selection', () => {
    const state = EditorState.create({ doc: '' });

    expect(blockTransformSpec(state, 'paragraph')).toBeNull();
  });

  it('peels nested quote/list/task prefixes while preserving list indentation for paragraph', () => {
    const doc = '> - [x] nested task\n> > 1. nested ordered\n  - indented bullet';
    const result = apply(doc, 'paragraph');

    expect(result.doc).toBe('nested task\nnested ordered\n  indented bullet');
  });

  it('normalizes nested quote/list/task content to a task list without losing text', () => {
    const doc = '> * [x] checked\n> + bullet\n> > 2. ordered';
    const result = apply(doc, 'task-list');

    expect(result.doc).toBe('* [x] checked\n- [ ] bullet\n- [ ] ordered');
  });

  it('wraps selected lines in a safe fenced code block', () => {
    const doc = 'alpha\n```\ninside\n```\nomega';
    const result = apply(doc, 'code-fence', EditorSelection.single(0, doc.indexOf('omega') - 1));

    expect(result.doc).toBe('````\nalpha\n```\ninside\n```\n````\nomega');
  });

  it('toggles an existing fenced code block back to its body', () => {
    const doc = '```ts\nconst x = 1;\n```';
    const result = apply(doc, 'code-fence');

    expect(result.doc).toBe('const x = 1;');
  });

  it('unwraps a tilde fenced block with a longer compatible closing fence', () => {
    const doc = '~~~js\nalpha\n~~~~';
    const result = apply(doc, 'code-fence', EditorSelection.single(doc.indexOf('alpha'), doc.indexOf('alpha') + 2));

    expect(result.doc).toBe('alpha');
  });

  it('does not treat a closing fence line as an opener', () => {
    const doc = '```\nalpha\n```\nbeta';
    const closingStart = doc.indexOf('```', 1);
    const result = apply(doc, 'code-fence', EditorSelection.single(closingStart, closingStart + 3));

    expect(result.doc).toBe('```\nalpha\n````\n```\n````\nbeta');
  });

  it('does not unwrap across plain text between fenced blocks', () => {
    const doc = '```\na\n```\nplain\n```\nb\n```';
    const result = apply(doc, 'code-fence', EditorSelection.single(doc.indexOf('plain'), doc.indexOf('plain') + 2));

    expect(result.doc).toBe('```\na\n```\n```\nplain\n```\n```\nb\n```');
  });

  it('unwraps only the adjacent fenced block containing the selection', () => {
    const doc = '```\na\n```\n~~~\nb\n~~~';
    const result = apply(doc, 'code-fence', EditorSelection.single(doc.indexOf('b'), doc.indexOf('b') + 1));

    expect(result.doc).toBe('```\na\n```\nb');
  });
});
