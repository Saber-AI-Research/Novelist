<script lang="ts">
  import { onMount } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';

  interface Card { id: string; text: string }
  interface Column { id: string; name: string; cards: Card[] }
  interface Board { columns: Column[] }

  let filePath = $state<string | null>(null);
  let board = $state<Board>({ columns: defaultColumns() });
  let editingColumnId = $state<string | null>(null);
  let addingCardColumnId = $state<string | null>(null);
  let newCardText = $state('');
  let dirty = $state(false);

  function defaultColumns(): Column[] {
    return [
      { id: cid(), name: 'To Do', cards: [] },
      { id: cid(), name: 'Doing', cards: [] },
      { id: cid(), name: 'Done', cards: [] },
    ];
  }

  function cid() { return Math.random().toString(36).slice(2, 10); }

  function parseBoard(content: string): Board {
    try {
      const data = JSON.parse(content);
      if (!data || !Array.isArray(data.columns)) return { columns: defaultColumns() };
      return {
        columns: data.columns.map((c: Record<string, unknown>) => ({
          id: typeof c.id === 'string' ? c.id : cid(),
          name: typeof c.name === 'string' ? c.name : 'Column',
          cards: Array.isArray(c.cards)
            ? c.cards.map((card: Record<string, unknown>) => ({
                id: typeof card.id === 'string' ? card.id : cid(),
                text: typeof card.text === 'string' ? card.text : '',
              }))
            : [],
        })),
      };
    } catch {
      return { columns: defaultColumns() };
    }
  }

  function markDirty() {
    if (!dirty) {
      dirty = true;
      window.parent.postMessage({ type: 'mark-dirty' }, '*');
    }
  }

  function save() {
    if (!filePath) return;
    const content = JSON.stringify(board, null, 2);
    window.parent.postMessage({ type: 'file-save', filePath, content }, '*');
    dirty = false;
  }

  function applyTheme(vars: Record<string, string>) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }

  onMount(() => {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'file-open') {
        filePath = d.filePath ?? null;
        board = parseBoard(d.content ?? '');
        dirty = false;
      } else if (d.type === 'theme-update' && d.theme) {
        applyTheme(d.theme);
      }
    });
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    });
    window.parent.postMessage({ type: 'plugin-ready' }, '*');
  });

  // svelte-dnd-action handlers
  function handleColumnCardsConsider(colId: string, e: CustomEvent<DndEvent<Card>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
  }
  function handleColumnCardsFinalize(colId: string, e: CustomEvent<DndEvent<Card>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
    markDirty();
    save();
  }
  function handleColumnsConsider(e: CustomEvent<DndEvent<Column>>) {
    board.columns = e.detail.items;
  }
  function handleColumnsFinalize(e: CustomEvent<DndEvent<Column>>) {
    board.columns = e.detail.items;
    markDirty();
    save();
  }

  function addCard(colId: string) {
    const text = newCardText.trim();
    if (!text) { addingCardColumnId = null; return; }
    const col = board.columns.find(c => c.id === colId);
    if (col) {
      col.cards.push({ id: cid(), text });
      markDirty();
      save();
    }
    newCardText = '';
    addingCardColumnId = null;
  }

  function deleteCard(colId: string, cardId: string) {
    const col = board.columns.find(c => c.id === colId);
    if (!col) return;
    col.cards = col.cards.filter(c => c.id !== cardId);
    markDirty();
    save();
  }

  function addColumn() {
    board.columns.push({ id: cid(), name: 'New Column', cards: [] });
    markDirty();
    save();
  }

  function deleteColumn(colId: string) {
    board.columns = board.columns.filter(c => c.id !== colId);
    markDirty();
    save();
  }

  function renameColumn(colId: string, name: string) {
    const col = board.columns.find(c => c.id === colId);
    if (col && col.name !== name) {
      col.name = name || 'Column';
      markDirty();
      save();
    }
    editingColumnId = null;
  }
</script>

<div class="board">
  <section
    class="columns"
    use:dndzone={{ items: board.columns, type: 'column', flipDurationMs: 180 }}
    onconsider={handleColumnsConsider}
    onfinalize={handleColumnsFinalize}
  >
    {#each board.columns as col (col.id)}
      <div class="column">
        <header class="col-header">
          {#if editingColumnId === col.id}
            <input
              class="col-name-input"
              value={col.name}
              autofocus
              onblur={(e) => renameColumn(col.id, (e.target as HTMLInputElement).value)}
              onkeydown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { editingColumnId = null; } }}
            />
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <h3 class="col-name" ondblclick={() => { editingColumnId = col.id; }}>{col.name}</h3>
          {/if}
          <span class="col-count">{col.cards.length}</span>
          <button class="col-del" title="Delete column" onclick={() => deleteColumn(col.id)}>✕</button>
        </header>

        <div
          class="cards"
          use:dndzone={{ items: col.cards, type: 'card', flipDurationMs: 180, dropTargetStyle: {} }}
          onconsider={(e) => handleColumnCardsConsider(col.id, e)}
          onfinalize={(e) => handleColumnCardsFinalize(col.id, e)}
        >
          {#each col.cards as card (card.id)}
            <div class="card">
              <span class="card-text">{card.text}</span>
              <button class="card-del" title="Delete" onclick={() => deleteCard(col.id, card.id)}>✕</button>
            </div>
          {/each}
        </div>

        <footer class="col-footer">
          {#if addingCardColumnId === col.id}
            <textarea
              class="card-input"
              bind:value={newCardText}
              placeholder="Card text…"
              autofocus
              onblur={() => addCard(col.id)}
              onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(col.id); } if (e.key === 'Escape') { addingCardColumnId = null; newCardText = ''; } }}
            ></textarea>
          {:else}
            <button class="add-card" onclick={() => { addingCardColumnId = col.id; newCardText = ''; }}>+ Add card</button>
          {/if}
        </footer>
      </div>
    {/each}

    <button class="add-column" onclick={addColumn}>+ Add column</button>
  </section>
</div>

<style>
  :global(html), :global(body) {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: var(--novelist-bg, #fcfcfa);
    color: var(--novelist-text, #2c2c2c);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
  }
  .board {
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 14px;
  }
  .columns {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    height: 100%;
    min-width: fit-content;
  }
  .column {
    flex: 0 0 272px;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--novelist-bg-secondary, #f4f3ef);
    border: 1px solid var(--novelist-border, #e8e6e1);
    border-radius: 6px;
    overflow: hidden;
  }
  .col-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--novelist-border, #e8e6e1);
  }
  .col-name, .col-name-input {
    flex: 1;
    font-size: 12.5px;
    font-weight: 600;
    margin: 0;
    color: var(--novelist-text, #2c2c2c);
    background: transparent;
    border: none;
    outline: none;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .col-name-input:focus { background: var(--novelist-bg, #fff); box-shadow: 0 0 0 1px var(--novelist-accent, #4a90e2); }
  .col-count {
    font-size: 11px;
    color: var(--novelist-text-secondary, #8a8a8a);
    padding: 1px 6px;
    background: var(--novelist-bg-tertiary, rgba(0,0,0,0.05));
    border-radius: 10px;
  }
  .col-del {
    border: none; background: transparent;
    color: var(--novelist-text-secondary, #8a8a8a);
    cursor: pointer; font-size: 12px;
    padding: 2px 4px; border-radius: 3px;
  }
  .col-del:hover { background: var(--novelist-bg-tertiary, rgba(0,0,0,0.08)); color: var(--novelist-text); }
  .cards {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 40px;
  }
  .card {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 10px;
    background: var(--novelist-bg, #fff);
    border: 1px solid var(--novelist-border, #e8e6e1);
    border-radius: 4px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    cursor: grab;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .card:active { cursor: grabbing; }
  .card-text { flex: 1; }
  .card-del {
    visibility: hidden;
    border: none; background: transparent;
    color: var(--novelist-text-secondary, #8a8a8a);
    cursor: pointer; font-size: 11px;
    padding: 0 2px; border-radius: 3px;
  }
  .card:hover .card-del { visibility: visible; }
  .card-del:hover { background: var(--novelist-bg-tertiary, rgba(0,0,0,0.08)); color: var(--novelist-text); }
  .col-footer {
    padding: 6px 8px 8px 8px;
    border-top: 1px solid var(--novelist-border, #e8e6e1);
  }
  .add-card {
    width: 100%;
    background: transparent;
    border: none;
    text-align: left;
    padding: 6px 8px;
    color: var(--novelist-text-secondary, #8a8a8a);
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .add-card:hover { background: var(--novelist-bg-tertiary, rgba(0,0,0,0.06)); color: var(--novelist-text); }
  .card-input {
    width: 100%;
    min-height: 60px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    background: var(--novelist-bg, #fff);
    border: 1px solid var(--novelist-accent, #4a90e2);
    border-radius: 4px;
    resize: vertical;
    outline: none;
    color: var(--novelist-text);
  }
  .add-column {
    flex: 0 0 272px;
    padding: 10px 12px;
    background: transparent;
    border: 1px dashed var(--novelist-border, #e8e6e1);
    border-radius: 6px;
    color: var(--novelist-text-secondary, #8a8a8a);
    cursor: pointer;
    text-align: left;
    font-size: 12.5px;
    margin-top: 0;
  }
  .add-column:hover {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
  }
</style>
