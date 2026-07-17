import type { StyledCopyResult } from './types';

export const MAX_SEMANTIC_NODES = 50_000;
export const MAX_SEMANTIC_DEPTH = 128;
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLUMNS = 100;

export interface SemanticComplexityMetrics {
  nodeCount: number;
  maxDepth: number;
  tables: ReadonlyArray<{ readonly rows: number; readonly columns: number }>;
}

export function validateSemanticComplexity(
  metrics: SemanticComplexityMetrics,
): StyledCopyResult<void> {
  if (metrics.nodeCount > MAX_SEMANTIC_NODES) {
    return {
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'nodes',
        maximum: MAX_SEMANTIC_NODES,
        actual: metrics.nodeCount,
      },
    };
  }

  if (metrics.maxDepth > MAX_SEMANTIC_DEPTH) {
    return {
      kind: 'error',
      error: {
        code: 'document_too_complex',
        dimension: 'depth',
        maximum: MAX_SEMANTIC_DEPTH,
        actual: metrics.maxDepth,
      },
    };
  }

  for (let tableIndex = 0; tableIndex < metrics.tables.length; tableIndex += 1) {
    const table = metrics.tables[tableIndex];
    if (table.rows > MAX_TABLE_ROWS) {
      return {
        kind: 'error',
        error: {
          code: 'document_too_complex',
          dimension: 'table_rows',
          maximum: MAX_TABLE_ROWS,
          actual: table.rows,
          tableIndex,
        },
      };
    }
    if (table.columns > MAX_TABLE_COLUMNS) {
      return {
        kind: 'error',
        error: {
          code: 'document_too_complex',
          dimension: 'table_columns',
          maximum: MAX_TABLE_COLUMNS,
          actual: table.columns,
          tableIndex,
        },
      };
    }
  }

  return { kind: 'ok', value: undefined, warnings: [] };
}
