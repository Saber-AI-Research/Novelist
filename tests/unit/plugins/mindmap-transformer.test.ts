import { describe, expect, it } from 'vitest';
import { createMindmapTransformer } from '../../../plugins/mindmap/src/transformer';

interface MindmapNode {
  content: string;
  children: MindmapNode[];
}

function contents(node: MindmapNode): string[] {
  return [node.content, ...node.children.flatMap(contents)];
}

/**
 * [regression] markmap-view writes node content with innerHTML, and markmap-lib
 * enables raw HTML in markdown-it by default. Manuscript HTML must stay text.
 */
describe('mindmap plugin transformer', () => {
  it('renders raw HTML from headings and paragraphs as escaped text', () => {
    const { root } = createMindmapTransformer().transform(
      '# Chapter <img src=x onerror="parent.postMessage(1, \'*\')">\n\n'
      + '## Scene <script>alert(1)</script>\n\n'
      + '<iframe src="https://example.invalid"></iframe>\n',
    );
    const rendered = contents(root as MindmapNode).join('\n');

    expect(rendered).toContain('Chapter &lt;img src=x onerror=');
    expect(rendered).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).not.toMatch(/<(img|script|iframe)\b/i);
  });

  it('keeps markdown formatting markup', () => {
    const { root } = createMindmapTransformer().transform('# **Snow** and `code`\n');
    const rendered = contents(root as MindmapNode).join('\n');
    expect(rendered).toContain('<strong>Snow</strong>');
    expect(rendered).toContain('<code>code</code>');
  });
});
