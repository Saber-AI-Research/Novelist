export interface KanbanCard { id: string; text: string }
export interface KanbanColumn { id: string; name: string; cards: KanbanCard[] }
export interface KanbanBoard { columns: KanbanColumn[] }

export type KanbanParseResult =
  | { ok: true; board: KanbanBoard }
  | { ok: false; error: string };

export function kanbanId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defaultKanbanBoard(columnNames: readonly string[]): KanbanBoard {
  return { columns: columnNames.map((name) => ({ id: kanbanId(), name, cards: [] })) };
}

function parseCard(card: unknown): KanbanCard | null {
  if (typeof card !== 'object' || card === null || Array.isArray(card)) return null;
  const id = 'id' in card ? card.id : undefined;
  const text = 'text' in card ? card.text : undefined;
  return {
    id: typeof id === 'string' ? id : kanbanId(),
    text: typeof text === 'string' ? text : '',
  };
}

function parseColumn(column: unknown): KanbanColumn | string {
  if (typeof column !== 'object' || column === null || Array.isArray(column)) {
    return 'Every column must be a JSON object.';
  }
  const id = 'id' in column ? column.id : undefined;
  const name = 'name' in column ? column.name : undefined;
  const rawCards = 'cards' in column ? column.cards : undefined;
  if (rawCards !== undefined && !Array.isArray(rawCards)) return 'Column "cards" must be an array.';
  const cards: KanbanCard[] = [];
  for (const raw of rawCards ?? []) {
    const card = parseCard(raw);
    if (!card) return 'Every card must be a JSON object.';
    cards.push(card);
  }
  return {
    id: typeof id === 'string' ? id : kanbanId(),
    name: typeof name === 'string' ? name : 'Column',
    cards,
  };
}

/**
 * Parse a `.kanban` file. An empty file is a new board and gets the default
 * columns. Anything else that is not a board (invalid JSON, git conflict
 * markers, a half-synced file) is reported as an error so the caller can show
 * it read-only instead of overwriting the file with an empty board.
 */
export function parseKanbanBoard(content: string, defaultColumnNames: readonly string[]): KanbanParseResult {
  if (content.trim() === '') return { ok: true, board: defaultKanbanBoard(defaultColumnNames) };
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const rawColumns = typeof data === 'object' && data !== null && 'columns' in data ? data.columns : undefined;
  if (!Array.isArray(rawColumns)) {
    return { ok: false, error: 'Expected a JSON object with a "columns" array.' };
  }
  const columns: KanbanColumn[] = [];
  for (const raw of rawColumns) {
    const column = parseColumn(raw);
    if (typeof column === 'string') return { ok: false, error: column };
    columns.push(column);
  }
  return { ok: true, board: { columns } };
}

export function serializeKanbanBoard(board: KanbanBoard): string {
  return JSON.stringify(
    {
      columns: board.columns.map((column) => ({
        id: column.id,
        name: column.name,
        cards: column.cards.map((card) => ({ id: card.id, text: card.text })),
      })),
    },
    null,
    2,
  );
}
