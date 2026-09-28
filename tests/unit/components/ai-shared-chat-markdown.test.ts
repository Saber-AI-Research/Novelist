import { describe, it, expect } from 'vitest';
import { escapeHtml, renderChatMarkdown } from '$lib/components/ai-shared/chat-markdown';

describe('[contract] ai-shared chat markdown renderer', () => {
  it('escapes raw HTML so model output cannot inject markup', () => {
    const out = renderChatMarkdown('<img src=x onerror="alert(1)"> **hi**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(out).toContain('<strong>hi</strong>');
  });

  it('renders links as inert text, never an anchor', () => {
    const out = renderChatMarkdown('see [docs](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).toContain('<span class="md-link" title="javascript:alert(1">docs</span>');
  });

  it('renders headings, lists, quotes and paragraphs with CJK text', () => {
    const out = renderChatMarkdown('## 第一章\n\n- 萧炎\n- 药老\n\n1. 开场\n2. 冲突\n\n> 三十年河东\n\n正文第一行\n正文第二行');
    expect(out).toBe(
      '<h2>第一章</h2>' +
        '<ul><li>萧炎</li><li>药老</li></ul>' +
        '<ol><li>开场</li><li>冲突</li></ol>' +
        '<blockquote>三十年河东</blockquote>' +
        '<p>正文第一行<br>正文第二行</p>',
    );
  });

  it('keeps code fences verbatim and escaped', () => {
    const out = renderChatMarkdown('```ts\nconst a = 1 < 2 && **b**;\n```');
    expect(out).toBe('<pre><code>const a = 1 &lt; 2 &amp;&amp; **b**;</code></pre>');
  });

  it('renders an unterminated fence (mid-stream) as an open code block', () => {
    const out = renderChatMarkdown('before\n```\npartial line');
    expect(out).toBe('<p>before</p><pre><code>partial line</code></pre>');
  });

  it('does not apply emphasis inside inline code', () => {
    expect(renderChatMarkdown('`**x**` and *y*')).toBe('<p><code>**x**</code> and <em>y</em></p>');
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
