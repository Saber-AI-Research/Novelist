import { describe, it, expect } from 'vitest';
import {
  splitEditSuggestions,
  locateSuggestion,
  EDIT_SUGGESTION_PROTOCOL,
} from '$lib/components/ai-shared/edit-suggestions';

function block(body: string): string {
  return '```novelist-edit\n' + body + '```';
}

describe('ai-shared edit-suggestions parser', () => {
  it('returns the original text untouched when there are no blocks', () => {
    const text = '这本书整体不错，没有发现错别字。';
    const { body, suggestions } = splitEditSuggestions(text);
    expect(body).toBe(text);
    expect(suggestions).toEqual([]);
  });

  it('parses a single block with note and file headers', () => {
    const text = [
      '我发现一处笔误：',
      block(
        'file: 旧域怪诞.md\nnote: “都”应为“的”\n<<<<<<< SEARCH\n穿越到了小时候都自己身上\n=======\n穿越到了小时候的自己身上\n>>>>>>> REPLACE\n',
      ),
      '其余部分没有问题。',
    ].join('\n\n');
    const { body, suggestions } = splitEditSuggestions(text);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: 'edit-0',
      file: '旧域怪诞.md',
      note: '“都”应为“的”',
      search: '穿越到了小时候都自己身上',
      replace: '穿越到了小时候的自己身上',
    });
    expect(body).toContain('我发现一处笔误：');
    expect(body).toContain('其余部分没有问题。');
    expect(body).not.toContain('SEARCH');
  });

  it('parses multiple blocks with stable ordinal ids', () => {
    const text = [
      block('<<<<<<< SEARCH\n张文达\n=======\n张闻达\n>>>>>>> REPLACE\n'),
      block('note: 句号重复\n<<<<<<< SEARCH\n另一个方向的书。。\n=======\n另一个方向的书。\n>>>>>>> REPLACE\n'),
    ].join('\n');
    const { suggestions } = splitEditSuggestions(text);
    expect(suggestions.map((s) => s.id)).toEqual(['edit-0', 'edit-1']);
    expect(suggestions[1].note).toBe('句号重复');
  });

  it('supports multi-line search/replace bodies', () => {
    const search = '第一行\n第二行';
    const replace = '第一行（改）\n第二行（改）';
    const { suggestions } = splitEditSuggestions(
      block(`<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`),
    );
    expect(suggestions[0].search).toBe(search);
    expect(suggestions[0].replace).toBe(replace);
  });

  it('allows an empty replacement (deletion)', () => {
    const { suggestions } = splitEditSuggestions(
      block('<<<<<<< SEARCH\n多余的句子。\n=======\n\n>>>>>>> REPLACE\n'),
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].replace).toBe('');
  });

  it('leaves malformed blocks in the body instead of dropping them', () => {
    const broken = block('<<<<<<< SEARCH\n只有搜索没有替换\n');
    const { body, suggestions } = splitEditSuggestions(broken);
    expect(suggestions).toEqual([]);
    expect(body).toContain('只有搜索没有替换');
  });

  it('ignores unterminated blocks while streaming', () => {
    const partial = '```novelist-edit\n<<<<<<< SEARCH\n流式传输中…';
    const { body, suggestions } = splitEditSuggestions(partial);
    expect(suggestions).toEqual([]);
    expect(body).toContain('流式传输中…');
  });
});

describe('ai-shared edit-suggestions locator', () => {
  const suggestion = {
    id: 'edit-0',
    search: '小时候都自己',
    replace: '小时候的自己',
  };

  it('locates the exact range of the search text', () => {
    const doc = '主角穿越到了小时候都自己身上。';
    const range = locateSuggestion(doc, suggestion);
    expect(range).toEqual({ from: 6, to: 12 });
    expect(doc.slice(range!.from, range!.to)).toBe(suggestion.search);
  });

  it('returns null when the document no longer contains the text', () => {
    expect(locateSuggestion('已经被改掉的文本。', suggestion)).toBeNull();
  });
});

describe('ai-shared edit-suggestions protocol prompt', () => {
  it('documents the exact fence + markers the parser expects', () => {
    expect(EDIT_SUGGESTION_PROTOCOL).toContain('```novelist-edit');
    expect(EDIT_SUGGESTION_PROTOCOL).toContain('<<<<<<< SEARCH');
    expect(EDIT_SUGGESTION_PROTOCOL).toContain('=======');
    expect(EDIT_SUGGESTION_PROTOCOL).toContain('>>>>>>> REPLACE');
  });
});
