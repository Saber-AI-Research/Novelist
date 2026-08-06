import { describe, expect, it } from 'vitest';
import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { deleteParagraphSpec } from '$lib/editor/delete-paragraph';

function apply(doc: string, selection: EditorSelection) {
  const state = EditorState.create({ doc, selection, extensions: [markdown()] });
  const spec = deleteParagraphSpec(state);
  expect(spec).not.toBeNull();
  return state.update(spec!).state;
}

describe('[precision] deleteParagraphSpec', () => {
  it('deletes a wrapped CJK Markdown paragraph and preserves surrounding spacing', () => {
    const doc = '甲\n\n第二段第一行\n第二段第二行\n\n尾声';
    const cursor = doc.indexOf('第二行') + 1;

    const next = apply(doc, EditorSelection.single(cursor));

    expect(next.doc.toString()).toBe('甲\n\n尾声');
    expect(next.selection.main.head).toBe('甲\n\n'.length);
  });

  it('deletes the final paragraph together with its preceding separator', () => {
    const doc = '前言\n\n最后一段';

    const next = apply(doc, EditorSelection.single(doc.length));

    expect(next.doc.toString()).toBe('前言');
    expect(next.selection.main.head).toBe(doc.indexOf('\n'));
  });

  it('expands a partial selection to every touched paragraph', () => {
    const doc = '第一段\n\n第二段\n\n第三段';
    const selection = EditorSelection.single(doc.indexOf('一') + 1, doc.indexOf('二') + 2);

    const next = apply(doc, selection);

    expect(next.doc.toString()).toBe('第三段');
    expect(next.selection.main.empty).toBe(true);
    expect(next.selection.main.head).toBe(0);
  });

  it('removes a blank logical line when no paragraph syntax node is present', () => {
    const doc = '上文\n\n下文';

    const next = apply(doc, EditorSelection.single(doc.indexOf('\n') + 1));

    expect(next.doc.toString()).toBe('上文\n下文');
  });

  it('returns null for empty and read-only documents', () => {
    expect(deleteParagraphSpec(EditorState.create({ doc: '' }))).toBeNull();
    expect(deleteParagraphSpec(EditorState.create({
      doc: '只读内容',
      extensions: [EditorState.readOnly.of(true)],
    }))).toBeNull();
  });
});
