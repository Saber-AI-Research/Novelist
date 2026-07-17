import { describe, expect, it } from 'vitest';
import { validateSemanticComplexity } from '$lib/utils/styled-copy/limits';
import type {
  CopyScope,
  LinkMode,
  SemanticDocument,
  StyledCopyTarget,
  WechatTheme,
} from '$lib/utils/styled-copy/types';
import { createWarningCollector } from '$lib/utils/styled-copy/warnings';

describe('[precision] styled-copy domain contract', () => {
  it('exposes the target, theme, link, scope, and semantic document unions', () => {
    const target: StyledCopyTarget = 'wechat';
    const theme: WechatTheme = 'technical';
    const linkMode: LinkMode = 'end-references';
    const scope: CopyScope = 'full-document';
    const document: SemanticDocument = { type: 'document', children: [] };

    expect({ target, theme, linkMode, scope, document }).toEqual({
      target: 'wechat',
      theme: 'technical',
      linkMode: 'end-references',
      scope: 'full-document',
      document: { type: 'document', children: [] },
    });
  });
});

describe('[precision] styled-copy warning deduplication', () => {
  it('keeps the first occurrence of each stable code and payload pair', () => {
    const warnings = createWarningCollector();

    warnings.add({ code: 'unsafe_link_removed', payload: 'javascript:alert(1)' });
    warnings.add({ code: 'unsafe_link_removed', payload: 'javascript:alert(1)' });
    warnings.add({ code: 'unsafe_link_removed', payload: 'file:///tmp/private' });
    warnings.add({ code: 'relative_link_removed', payload: './chapter-2' });

    expect(warnings.values()).toEqual([
      { code: 'unsafe_link_removed', payload: 'javascript:alert(1)' },
      { code: 'unsafe_link_removed', payload: 'file:///tmp/private' },
      { code: 'relative_link_removed', payload: './chapter-2' },
    ]);
  });

  it('deduplicates payload-free warnings without changing insertion order', () => {
    const warnings = createWarningCollector();

    warnings.add({ code: 'malformed_footnote' });
    warnings.add({ code: 'malformed_footnote' });
    warnings.add({ code: 'malformed_image' });

    expect(warnings.values()).toEqual([
      { code: 'malformed_footnote' },
      { code: 'malformed_image' },
    ]);
  });
});

describe('[precision] styled-copy complexity limits', () => {
  it('accepts metrics exactly at every limit', () => {
    expect(validateSemanticComplexity({
      nodeCount: 50_000,
      maxDepth: 128,
      tables: [{ rows: 500, columns: 100 }],
    })).toEqual({ kind: 'ok', value: undefined, warnings: [] });
  });

  it.each([
    ['nodes', { nodeCount: 50_001, maxDepth: 1, tables: [] }, 50_000, 50_001],
    ['depth', { nodeCount: 1, maxDepth: 129, tables: [] }, 128, 129],
    ['table_rows', { nodeCount: 1, maxDepth: 1, tables: [{ rows: 501, columns: 1 }] }, 500, 501],
    ['table_columns', { nodeCount: 1, maxDepth: 1, tables: [{ rows: 1, columns: 101 }] }, 100, 101],
  ] as const)('blocks %s overflow without a partial value', (dimension, metrics, maximum, actual) => {
    expect(validateSemanticComplexity(metrics)).toEqual({
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension,
        maximum,
        actual,
        ...(dimension.startsWith('table_') ? { tableIndex: 0 } : {}),
      },
    });
  });
});
