import { describe, expect, it, vi } from 'vitest';
import supportedAstRaw from '../../../fixtures/styled-copy/supported.ast.json?raw';
import targetGoldensRaw from '../../../fixtures/styled-copy/targets.golden.json?raw';
import wideTableAstRaw from '../../../fixtures/styled-copy/wide-table.ast.json?raw';
import {
  renderStyledCopyTarget,
  WECHAT_TARGET_ADAPTER,
  ZHIHU_TARGET_ADAPTER,
} from '$lib/utils/styled-copy/targets';
import type {
  LinkMode,
  SemanticDocument,
  StyledCopyTarget,
  StyledCopyWarning,
  WechatTheme,
} from '$lib/utils/styled-copy/types';

interface TargetGolden {
  target: StyledCopyTarget;
  wechatTheme: WechatTheme;
  linkMode?: LinkMode;
  html: string;
  plainText: string;
  warnings: StyledCopyWarning[];
}

const SUPPORTED_AST = JSON.parse(supportedAstRaw) as SemanticDocument;
const WIDE_TABLE_AST = JSON.parse(wideTableAstRaw) as SemanticDocument;
const TARGET_GOLDENS = JSON.parse(targetGoldensRaw) as Record<string, TargetGolden>;
const FINAL_ASSETS = {
  'image-1': { kind: 'final' as const, url: 'https://assets.novelist.test/cover.png' },
  'mermaid-1': { kind: 'final' as const, url: 'https://assets.novelist.test/diagram.png' },
};

const LINK_MODE_DOCUMENT: SemanticDocument = {
  type: 'document',
  children: [
    { type: 'heading', level: 1, children: [{ type: 'text', value: '标题' }] },
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: '正文 ' },
        {
          type: 'link',
          href: 'https://example.com/a',
          title: null,
          children: [{ type: 'text', value: '资料' }],
        },
        { type: 'text', value: ' 与 ' },
        { type: 'math', display: false, expression: 'x+y' },
      ],
    },
  ],
};

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe('[contract] WeChat and Zhihu styled-copy target adapters', () => {
  it('defines exact default and explicit override golden cases', () => {
    expect(Object.keys(TARGET_GOLDENS)).toEqual([
      'wechat-minimal',
      'wechat-magazine',
      'wechat-technical',
      'zhihu',
      'wechat-minimal-anchors',
      'zhihu-end-references',
    ]);
  });

  it.each(Object.entries(TARGET_GOLDENS))('matches the %s HTML/plain/warning golden', (_, golden) => {
    const result = renderStyledCopyTarget({
      document: SUPPORTED_AST,
      target: golden.target,
      wechatTheme: golden.wechatTheme,
      linkMode: golden.linkMode,
      resolvedAssets: FINAL_ASSETS,
    });

    expect(result).toEqual({
      kind: 'ok',
      html: golden.html,
      plainText: golden.plainText,
      warnings: golden.warnings,
    });
  });

  it('exposes WeChat references and Zhihu anchors as target defaults', () => {
    expect(WECHAT_TARGET_ADAPTER.defaultLinkMode).toBe('end-references');
    expect(ZHIHU_TARGET_ADAPTER.defaultLinkMode).toBe('anchors');

    const wechat = renderStyledCopyTarget({
      document: LINK_MODE_DOCUMENT,
      target: 'wechat',
      wechatTheme: 'minimal',
      resolvedAssets: {},
    });
    const zhihu = renderStyledCopyTarget({
      document: LINK_MODE_DOCUMENT,
      target: 'zhihu',
      wechatTheme: 'technical',
      resolvedAssets: {},
    });

    expect(wechat.kind === 'ok' && wechat.html).toContain('引用链接');
    expect(zhihu.kind === 'ok' && zhihu.html).toContain('<a ');
    expect(zhihu.kind === 'ok' && zhihu.html).not.toContain('引用链接');
  });

  it('accepts explicit link-mode overrides in both directions', () => {
    const wechatAnchors = renderStyledCopyTarget({
      document: LINK_MODE_DOCUMENT,
      target: 'wechat',
      wechatTheme: 'minimal',
      linkMode: 'anchors',
      resolvedAssets: {},
    });
    const zhihuReferences = renderStyledCopyTarget({
      document: LINK_MODE_DOCUMENT,
      target: 'zhihu',
      wechatTheme: 'minimal',
      linkMode: 'end-references',
      resolvedAssets: {},
    });

    expect(wechatAnchors.kind === 'ok' && wechatAnchors.html).toContain('href="https://example.com/a"');
    expect(wechatAnchors.kind === 'ok' && wechatAnchors.html).not.toContain('引用链接');
    expect(zhihuReferences.kind === 'ok' && zhihuReferences.html).toContain('引用链接');
  });

  it('deduplicates exact external references by first occurrence and excludes endnotes', () => {
    const document: SemanticDocument = {
      type: 'document',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'link', href: 'https://a.example/path', title: null, children: [{ type: 'text', value: 'A1' }] },
            { type: 'text', value: ' ' },
            { type: 'link', href: 'https://a.example/path', title: null, children: [{ type: 'text', value: 'A2' }] },
            { type: 'text', value: ' ' },
            { type: 'link', href: 'https://b.example/path', title: null, children: [{ type: 'text', value: 'B' }] },
          ],
        },
        {
          type: 'endnotes',
          children: [{
            type: 'endnote',
            number: 1,
            children: [{
              type: 'paragraph',
              children: [{
                type: 'link',
                href: 'https://footnote.example/source',
                title: null,
                children: [{ type: 'text', value: '脚注资料' }],
              }],
            }],
          }],
        },
      ],
    };

    const result = renderStyledCopyTarget({
      document,
      target: 'wechat',
      wechatTheme: 'minimal',
      resolvedAssets: {},
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countOccurrences(result.html, '[1]')).toBe(2);
    expect(countOccurrences(result.html, '[2]')).toBe(1);
    expect(countOccurrences(result.html, '>https://a.example/path</a>')).toBe(1);
    expect(countOccurrences(result.html, '>https://b.example/path</a>')).toBe(1);
    expect(result.html).toContain('href="https://footnote.example/source"');
    expect(result.html).not.toContain('>https://footnote.example/source</a></li>');
  });

  it('preserves the complete semantic structure, safe tokens, spans, and code whitespace', () => {
    const result = renderStyledCopyTarget({
      document: SUPPORTED_AST,
      target: 'wechat',
      wechatTheme: 'technical',
      linkMode: 'anchors',
      resolvedAssets: FINAL_ASSETS,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.html).toContain('<th style=');
    expect(result.html).toContain('colspan="2"');
    expect(result.html).toContain('rowspan="2"');
    expect(result.html).not.toContain('<tfoot');
    expect(result.html).toContain('<pre style=');
    expect(result.html).toContain('const</span> <span');
    expect(result.html).toContain('unknown()\n</code></pre>');
    expect(result.html).toContain('src="https://assets.novelist.test/cover.png"');
    expect(result.html).toContain('src="https://assets.novelist.test/diagram.png"');
    expect(result.html).toContain('\\(E=mc^2\\)');
    expect(result.html).toContain('\\[x = y + 1\\]');
    expect(result.html).toContain('<sub style="color:#20252b;font-size:12px;vertical-align:sub">2</sub>');
    expect(result.html).toContain('<sup style="color:#20252b;font-size:12px;vertical-align:super">2</sup>');
    expect(result.plainText).toContain('const 章节 = "一";\n');
    expect(result.warnings).toEqual([
      { code: 'table_structure_degraded', payload: 'wechat:table-foot-to-body' },
      { code: 'math_visual_degraded' },
    ]);
  });

  it('flattens a wide table foot into tbody with one ordered target warning', () => {
    const wechat = renderStyledCopyTarget({
      document: WIDE_TABLE_AST,
      target: 'wechat',
      wechatTheme: 'technical',
      resolvedAssets: {},
    });
    const zhihu = renderStyledCopyTarget({
      document: WIDE_TABLE_AST,
      target: 'zhihu',
      wechatTheme: 'minimal',
      resolvedAssets: {},
    });

    expect(wechat.kind).toBe('ok');
    expect(zhihu.kind).toBe('ok');
    if (wechat.kind !== 'ok' || zhihu.kind !== 'ok') return;

    const template = document.createElement('template');
    template.innerHTML = wechat.html;
    const table = template.content.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('tfoot')).toBeNull();
    expect(table?.querySelectorAll('thead th')).toHaveLength(8);
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(4);
    expect(table?.querySelector('[rowspan="2"]')?.textContent).toBe('分组A');
    expect(table?.querySelector('[colspan="7"]')?.textContent).toBe('合计');
    expect(table?.querySelector('[colspan="8"]')?.textContent).toBe('脚注汇总');
    expect(wechat.plainText).toBe(
      '\\(a+b\\)\n\n'
      + '列1\t列2\t列3\t列4\t列5\t列6\t列7\t列8\n'
      + '分组A\tA1\tA2\tA3\tA4\tA5\tA6\tA7\n'
      + 'B1\tB2\tB3\tB4\tB5\tB6\tB7\n'
      + '合计\t100\n'
      + '脚注汇总\n\n'
      + '\\[sum=100\\]\n',
    );
    expect(wechat.warnings).toEqual([
      { code: 'math_visual_degraded' },
      { code: 'table_structure_degraded', payload: 'wechat:table-foot-to-body' },
    ]);
    expect(zhihu.warnings).toEqual([
      { code: 'math_visual_degraded' },
      { code: 'table_structure_degraded', payload: 'zhihu:table-foot-to-body' },
    ]);
  });

  it('requires every logical asset and the matching branded resolver mode', () => {
    const mermaidDocument: SemanticDocument = {
      type: 'document',
      children: [{
        type: 'mermaid',
        asset: { kind: 'mermaid', id: 'mermaid-1', source: 'graph TD; A-->B' },
      }],
    };

    expect(renderStyledCopyTarget({
      document: mermaidDocument,
      target: 'zhihu',
      wechatTheme: 'minimal',
      resolvedAssets: {},
    })).toEqual({
      kind: 'error',
      error: { code: 'unresolved_asset', assetId: 'mermaid-1', assetKind: 'mermaid' },
    });

    expect(renderStyledCopyTarget({
      document: mermaidDocument,
      target: 'zhihu',
      wechatTheme: 'minimal',
      assetMode: 'final',
      resolvedAssets: {
        'mermaid-1': { kind: 'preview', url: 'data:image/png;base64,AAAA' },
      },
    })).toEqual({
      kind: 'error',
      error: {
        code: 'resolved_asset_mode_mismatch',
        assetId: 'mermaid-1',
        expected: 'final',
        actual: 'preview',
      },
    });
  });

  it('permits preview-branded data/blob assets without allowing final serialization', () => {
    const imageDocument: SemanticDocument = {
      type: 'document',
      children: [{
        type: 'image',
        asset: { kind: 'image', id: 'image-1', source: './cover.png', alt: '封面', title: null },
      }],
    };
    const preview = renderStyledCopyTarget({
      document: imageDocument,
      target: 'wechat',
      wechatTheme: 'minimal',
      assetMode: 'preview',
      resolvedAssets: {
        'image-1': { kind: 'preview', url: 'data:image/png;base64,AAAA' },
      },
    });
    const final = renderStyledCopyTarget({
      document: imageDocument,
      target: 'wechat',
      wechatTheme: 'minimal',
      assetMode: 'final',
      resolvedAssets: {
        'image-1': { kind: 'final', url: 'data:image/png;base64,AAAA' },
      },
    });

    expect(preview.kind === 'ok' && preview.html).toContain('data:image/png;base64,AAAA');
    expect(final).toEqual({
      kind: 'error',
      error: { code: 'sanitizer_failure', reason: 'unsafe_image_url' },
    });
  });

  it('builds from semantic values without cloning a DOM node', () => {
    const cloneSpy = vi.spyOn(Node.prototype, 'cloneNode');
    try {
      const result = renderStyledCopyTarget({
        document: SUPPORTED_AST,
        target: 'zhihu',
        wechatTheme: 'minimal',
        resolvedAssets: FINAL_ASSETS,
      });

      expect(result.kind).toBe('ok');
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });
});
