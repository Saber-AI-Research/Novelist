<script lang="ts">
  import { onDestroy } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';
  import { IconClose } from '../icons';

  let { paneId = 'pane-1' }: { paneId?: string } = $props();

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));

  interface Card { id: string; text: string }
  interface Column { id: string; name: string; cards: Card[] }
  interface Board { columns: Column[] }

  let board = $state<Board>({ columns: defaultColumns() });
  let editingColumnId = $state<string | null>(null);
  let addingCardColumnId = $state<string | null>(null);
  let newCardText = $state('');
  let loadedKey = $state<string | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function defaultColumns(): Column[] {
    return [
      { id: cid(), name: t('kanban.column.todo'), cards: [] },
      { id: cid(), name: t('kanban.column.doing'), cards: [] },
      { id: cid(), name: t('kanban.column.done'), cards: [] },
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

  // Load from tab.content whenever active tab changes.
  $effect(() => {
    const key = tab ? `${tab.id}:${tab.filePath ?? ''}` : null;
    if (key === loadedKey) return;
    loadedKey = key;
    if (!tab) { board = { columns: defaultColumns() }; return; }
    board = parseBoard(tab.content ?? '');
  });

  function markDirtyAndSave() {
    if (tab) tabsStore.markDirty(tab.id);
    scheduleSave();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    const activeTab = tab;
    if (!activeTab || !activeTab.filePath) return;
    const snapshot = JSON.stringify(board, null, 2);
    const snapTabId = activeTab.id;
    const snapPath = activeTab.filePath;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await commands.registerWriteIgnore(snapPath);
      const r = await commands.writeFile(snapPath, snapshot);
      if (r.status === 'ok') {
        tabsStore.updateContent(snapTabId, snapshot);
        tabsStore.markSaved(snapTabId);
      }
    }, 400);
  }

  function handleColumnCardsConsider(colId: string, e: CustomEvent<DndEvent<Card>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
  }
  function handleColumnCardsFinalize(colId: string, e: CustomEvent<DndEvent<Card>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
    markDirtyAndSave();
  }
  function handleColumnsConsider(e: CustomEvent<DndEvent<Column>>) {
    board.columns = e.detail.items;
  }
  function handleColumnsFinalize(e: CustomEvent<DndEvent<Column>>) {
    board.columns = e.detail.items;
    markDirtyAndSave();
  }

  function addCard(colId: string) {
    const text = newCardText.trim();
    if (!text) { addingCardColumnId = null; return; }
    const col = board.columns.find(c => c.id === colId);
    if (col) {
      col.cards.push({ id: cid(), text });
      markDirtyAndSave();
    }
    newCardText = '';
    addingCardColumnId = null;
  }

  function deleteCard(colId: string, cardId: string) {
    const col = board.columns.find(c => c.id === colId);
    if (!col) return;
    col.cards = col.cards.filter(c => c.id !== cardId);
    markDirtyAndSave();
  }

  function addColumn() {
    board.columns.push({ id: cid(), name: t('kanban.newColumn'), cards: [] });
    markDirtyAndSave();
  }

  function deleteColumn(colId: string) {
    board.columns = board.columns.filter(c => c.id !== colId);
    markDirtyAndSave();
  }

  function renameColumn(colId: string, name: string) {
    const col = board.columns.find(c => c.id === colId);
    if (col && col.name !== name) {
      col.name = name || 'Column';
      markDirtyAndSave();
    }
    editingColumnId = null;
  }

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });
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
            <!-- svelte-ignore a11y_autofocus -->
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
          <button class="col-del" title={t('kanban.deleteColumn')} onclick={() => deleteColumn(col.id)}><IconClose size={12} /></button>
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
              <button class="card-del" title={t('kanban.deleteCard')} onclick={() => deleteCard(col.id, card.id)}><IconClose size={12} /></button>
            </div>
          {/each}
        </div>

        <footer class="col-footer">
          {#if addingCardColumnId === col.id}
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="card-input"
              bind:value={newCardText}
              placeholder={t('kanban.cardPlaceholder')}
              autofocus
              onblur={() => addCard(col.id)}
              onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addCard(col.id); } if (e.key === 'Escape') { addingCardColumnId = null; newCardText = ''; } }}
            ></textarea>
          {:else}
            <button class="add-card" onclick={() => { addingCardColumnId = col.id; newCardText = ''; }}>{t('kanban.addCard')}</button>
          {/if}
        </footer>
      </div>
    {/each}

    <button class="add-column" onclick={addColumn}>{t('kanban.addColumn')}</button>
  </section>
</div>

<style>
  .board {
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 14px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
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
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .col-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--novelist-border);
  }
  .col-name, .col-name-input {
    flex: 1;
    font-size: 12.5px;
    font-weight: 600;
    margin: 0;
    color: var(--novelist-text);
    background: transparent;
    border: none;
    outline: none;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .col-name-input:focus {
    background: var(--novelist-bg);
    box-shadow: 0 0 0 1px var(--novelist-accent);
  }
  .col-count {
    font-size: 11px;
    color: var(--novelist-text-secondary);
    padding: 1px 6px;
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    border-radius: 10px;
  }
  .col-del {
    border: none; background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer; font-size: 12px;
    padding: 2px 4px; border-radius: 3px;
  }
  .col-del:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
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
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    box-shadow: 0 1px 2px color-mix(in srgb, var(--novelist-text) 6%, transparent);
    cursor: grab;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--novelist-text);
  }
  .card:active { cursor: grabbing; }
  .card-text { flex: 1; }
  .card-del {
    visibility: hidden;
    border: none; background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer; font-size: 11px;
    padding: 0 2px; border-radius: 3px;
  }
  .card:hover .card-del { visibility: visible; }
  .card-del:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
  .col-footer {
    padding: 6px 8px 8px 8px;
    border-top: 1px solid var(--novelist-border);
  }
  .add-card {
    width: 100%;
    background: transparent;
    border: none;
    text-align: left;
    padding: 6px 8px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
  }
  .add-card:hover {
    background: color-mix(in srgb, var(--novelist-text) 6%, transparent);
    color: var(--novelist-text);
  }
  .card-input {
    width: 100%;
    min-height: 60px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-accent);
    border-radius: 4px;
    resize: vertical;
    outline: none;
    color: var(--novelist-text);
  }
  .add-column {
    flex: 0 0 272px;
    padding: 10px 12px;
    background: transparent;
    border: 1px dashed var(--novelist-border);
    border-radius: 6px;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    text-align: left;
    font-size: 12.5px;
  }
  .add-column:hover {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
  }
</style>
