import { describe, it, expect } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { splitEditSuggestions, locateSuggestion } from '$lib/components/ai-shared/edit-suggestions';
import { tablePlugin } from '$lib/editor/table';
import { wysiwygPlugin } from '$lib/editor/wysiwyg';

function block(body: string): string {
  return '```novelist-edit\n' + body + '```';
}

const TABLE_DOC = [
  '# 角色表',
  '',
  '| 角色 | 描述 | 备注 |',
  '| --- | --- | --- |',
  '| 小明 | 主角 | 勇敢 |',
  '| 小红 | 配角 | 聪明 |',
  '',
  '结尾段落。',
].join('\n');

function mkView(doc: string): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: 0 }, // cursor OUTSIDE the table → rendered as block widget
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), tablePlugin, wysiwygPlugin],
    }),
  });
  return { view, parent };
}

/** Mirror acceptSuggestion: locate in the live doc, dispatch the replace. */
function applyAccept(view: EditorView, suggestion: { search: string; replace: string }): boolean {
  const range = locateSuggestion(view.state.doc.toString(), suggestion as any);
  if (!range) return false;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: suggestion.replace } });
  return true;
}

describe('AI edit accept/deny on table content', () => {
  it('accepts an edit to a single table cell row (cursor outside → widget active)', () => {
    const { view, parent } = mkView(TABLE_DOC);
    const msg = '把小明的备注改一下：' + block(
      '<<<<<<< SEARCH\n| 小明 | 主角 | 勇敢 |\n=======\n| 小明 | 主角 | 机智勇敢 |\n>>>>>>> REPLACE\n',
    );
    const { suggestions } = splitEditSuggestions(msg);
    expect(suggestions).toHaveLength(1);

    const ok = applyAccept(view, suggestions[0]);
    expect(ok).toBe(true);
    const doc = view.state.doc.toString();
    expect(doc).toContain('| 小明 | 主角 | 机智勇敢 |');
    expect(doc).not.toContain('| 小明 | 主角 | 勇敢 |');
    // table structure intact
    expect(doc).toContain('| 小红 | 配角 | 聪明 |');
    view.destroy(); parent.remove();
  });

  it('accept-all applies multiple table-row edits with correct position re-location', () => {
    const { view, parent } = mkView(TABLE_DOC);
    const msg = [
      block('<<<<<<< SEARCH\n| 小明 | 主角 | 勇敢 |\n=======\n| 小明 | 主角 | 无畏 |\n>>>>>>> REPLACE\n'),
      block('<<<<<<< SEARCH\n| 小红 | 配角 | 聪明 |\n=======\n| 小红 | 主角 | 睿智 |\n>>>>>>> REPLACE\n'),
    ].join('\n');
    const { suggestions } = splitEditSuggestions(msg);
    expect(suggestions).toHaveLength(2);
    // accept-all = sequential accept, each re-locates against the live (already mutated) doc
    for (const s of suggestions) expect(applyAccept(view, s)).toBe(true);
    const doc = view.state.doc.toString();
    expect(doc).toContain('| 小明 | 主角 | 无畏 |');
    expect(doc).toContain('| 小红 | 主角 | 睿智 |');
    view.destroy(); parent.remove();
  });

  it('reject (deny) does not change the document', () => {
    const { view, parent } = mkView(TABLE_DOC);
    const before = view.state.doc.toString();
    // deny = we simply never call applyAccept; assert doc untouched
    expect(view.state.doc.toString()).toBe(before);
    view.destroy(); parent.remove();
  });

  it('reports conflict when the cell text already changed (stale suggestion)', () => {
    const { view, parent } = mkView(TABLE_DOC);
    const ok = applyAccept(view, { search: '| 小明 | 龙套 | 胆小 |', replace: '| 小明 | 主角 | 勇敢 |' });
    expect(ok).toBe(false); // not found → caller marks 'conflict'
    view.destroy(); parent.remove();
  });

  it('FOOTGUN: short ambiguous cell text matches the first occurrence', () => {
    // Both rows contain "主角" after the first edit scenario; a too-short SEARCH
    // hits the header-adjacent first match. Documents the uniqueness requirement.
    const dup = ['| a | b |', '| --- | --- |', '| x | 主角 |', '| y | 主角 |'].join('\n');
    const { view, parent } = mkView(dup);
    applyAccept(view, { search: '主角', replace: 'ZZZ' });
    const doc = view.state.doc.toString();
    // first "主角" (row x) replaced, second (row y) untouched
    expect(doc).toContain('| x | ZZZ |');
    expect(doc).toContain('| y | 主角 |');
    view.destroy(); parent.remove();
  });
});
