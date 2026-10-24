import { describe, it, expect } from 'vitest';
import { markdownToHtml, markdownToPlainText } from '$lib/utils/markdown-copy';

describe('markdownToHtml', () => {
  it('converts headings', () => {
    expect(markdownToHtml('# Title')).toContain('<h1>Title</h1>');
    expect(markdownToHtml('## Subtitle')).toContain('<h2>Subtitle</h2>');
    expect(markdownToHtml('### H3')).toContain('<h3>H3</h3>');
  });

  it('converts bold text', () => {
    expect(markdownToHtml('**bold**')).toContain('<strong>bold</strong>');
    expect(markdownToHtml('__bold__')).toContain('<strong>bold</strong>');
  });

  it('converts italic text', () => {
    expect(markdownToHtml('*italic*')).toContain('<em>italic</em>');
  });

  it('converts bold+italic text', () => {
    expect(markdownToHtml('***both***')).toContain('<strong><em>both</em></strong>');
  });

  it('converts strikethrough', () => {
    expect(markdownToHtml('~~deleted~~')).toContain('<del>deleted</del>');
  });

  it('converts inline code', () => {
    expect(markdownToHtml('use `code` here')).toContain('<code>code</code>');
  });

  it('converts links', () => {
    const result = markdownToHtml('[click](https://example.com)');
    expect(result).toContain('<a href="https://example.com">click</a>');
  });

  it('converts blockquotes', () => {
    expect(markdownToHtml('> quoted text')).toContain('<blockquote>quoted text</blockquote>');
  });

  it('converts unordered lists', () => {
    const md = '- item 1\n- item 2';
    const html = markdownToHtml(md);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>item 1</li>');
    expect(html).toContain('<li>item 2</li>');
    expect(html).toContain('</ul>');
  });

  it('converts ordered lists', () => {
    const md = '1. first\n2. second';
    const html = markdownToHtml(md);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    expect(html).toContain('</ol>');
  });

  it('wraps normal lines in paragraphs', () => {
    expect(markdownToHtml('Hello world')).toContain('<p>Hello world</p>');
  });

  it('converts empty lines to br', () => {
    const result = markdownToHtml('line 1\n\nline 2');
    expect(result).toContain('<br>');
  });

  it('handles inline formatting inside headings', () => {
    expect(markdownToHtml('# **Bold** Title')).toContain('<h1><strong>Bold</strong> Title</h1>');
  });

  it('handles mixed list types', () => {
    const md = '- bullet\n1. numbered';
    const html = markdownToHtml(md);
    expect(html).toContain('<ul>');
    expect(html).toContain('</ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('</ol>');
  });

  it('escapes HTML-significant characters in prose and inline code', () => {
    expect(markdownToHtml('if a<b && c>d')).toBe('<p>if a&lt;b &amp;&amp; c&gt;d</p>');
    expect(markdownToHtml('use `Vec<String>` here')).toBe('<p>use <code>Vec&lt;String&gt;</code> here</p>');
    expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('keeps inline code contents literal instead of applying emphasis', () => {
    expect(markdownToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('drops non-http link targets but keeps their text', () => {
    expect(markdownToHtml('[点我](javascript:alert(1))')).toBe('<p>点我)</p>');
    expect(markdownToHtml('[x](data:text/html,hi)')).toBe('<p>x</p>');
  });

  it('escapes quotes in link targets and ignores link titles', () => {
    expect(markdownToHtml('[a](https://e.com/?q="x"&y=1 "Title")')).toBe(
      '<p><a href="https://e.com/?q=&quot;x&quot;&amp;y=1">a</a></p>',
    );
  });

  it('does not let emphasis rules rewrite underscores inside link targets', () => {
    expect(markdownToHtml('[章节](https://e.com/_a_/b)')).toBe('<p><a href="https://e.com/_a_/b">章节</a></p>');
  });
});

describe('markdownToPlainText', () => {
  it('strips heading markers', () => {
    expect(markdownToPlainText('# Title')).toBe('Title');
    expect(markdownToPlainText('### Deep Heading')).toBe('Deep Heading');
  });

  it('strips bold markers', () => {
    expect(markdownToPlainText('**bold**')).toBe('bold');
    expect(markdownToPlainText('__bold__')).toBe('bold');
  });

  it('strips italic markers', () => {
    expect(markdownToPlainText('*italic*')).toBe('italic');
  });

  it('strips bold+italic markers', () => {
    expect(markdownToPlainText('***both***')).toBe('both');
  });

  it('strips strikethrough markers', () => {
    expect(markdownToPlainText('~~deleted~~')).toBe('deleted');
  });

  it('strips inline code backticks', () => {
    expect(markdownToPlainText('use `code` here')).toBe('use code here');
  });

  it('converts links to text only', () => {
    expect(markdownToPlainText('[click](https://example.com)')).toBe('click');
  });

  it('strips blockquote markers', () => {
    expect(markdownToPlainText('> quoted')).toBe('quoted');
  });

  it('strips unordered list markers', () => {
    expect(markdownToPlainText('- item')).toBe('item');
    expect(markdownToPlainText('* item')).toBe('item');
    expect(markdownToPlainText('+ item')).toBe('item');
  });

  it('strips ordered list markers', () => {
    expect(markdownToPlainText('1. first')).toBe('first');
    expect(markdownToPlainText('10. tenth')).toBe('tenth');
  });

  it('handles complex mixed content', () => {
    const md = '# **Bold Title**\n\n> A *quote* with `code`';
    const plain = markdownToPlainText(md);
    expect(plain).toContain('Bold Title');
    expect(plain).toContain('A quote with code');
    expect(plain).not.toContain('#');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('*');
    expect(plain).not.toContain('`');
    expect(plain).not.toContain('>');
  });
});
