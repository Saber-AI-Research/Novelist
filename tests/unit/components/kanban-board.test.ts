import { describe, expect, it } from 'vitest';
import { parseKanbanBoard, serializeKanbanBoard } from '$lib/components/kanban/board';

const DEFAULTS = ['To Do', 'Doing', 'Done'];

describe('parseKanbanBoard', () => {
  it('gives an empty file the default columns', () => {
    const result = parseKanbanBoard('  \n', DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.board.columns.map((c) => c.name)).toEqual(DEFAULTS);
  });

  it('rejects a file with git conflict markers instead of returning an empty board', () => {
    const conflicted = [
      '<<<<<<< HEAD',
      '{"columns":[{"id":"a","name":"Mine","cards":[]}]}',
      '=======',
      '{"columns":[{"id":"a","name":"Theirs","cards":[]}]}',
      '>>>>>>> origin/main',
    ].join('\n');
    expect(parseKanbanBoard(conflicted, DEFAULTS).ok).toBe(false);
  });

  it('rejects a truncated (half-synced) file', () => {
    expect(parseKanbanBoard('{"columns":[{"id":"a","name":"T', DEFAULTS).ok).toBe(false);
  });

  it('rejects JSON that is not a board', () => {
    expect(parseKanbanBoard('{"nodes":[]}', DEFAULTS).ok).toBe(false);
    expect(parseKanbanBoard('[1,2]', DEFAULTS).ok).toBe(false);
    expect(parseKanbanBoard('{"columns":[{"cards":"nope"}]}', DEFAULTS).ok).toBe(false);
  });

  it('round-trips a board and drops drag-and-drop shadow fields', () => {
    const raw = JSON.stringify({
      columns: [{ id: 'c1', name: '待办', cards: [{ id: 'k1', text: '第一章' }] }],
    });
    const result = parseKanbanBoard(raw, DEFAULTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const card = result.board.columns[0].cards[0] as { id: string; text: string; isDndShadowItem?: boolean };
    card.isDndShadowItem = true;
    expect(JSON.parse(serializeKanbanBoard(result.board))).toEqual({
      columns: [{ id: 'c1', name: '待办', cards: [{ id: 'k1', text: '第一章' }] }],
    });
  });
});
