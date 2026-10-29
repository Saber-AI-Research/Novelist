<script lang="ts">
  import { flushSync, onDestroy, untrack } from 'svelte';
  import { dndzone, type DndEvent } from 'svelte-dnd-action';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { t } from '$lib/i18n';
  import { isImeComposing } from '$lib/utils/ime';
  import { IconClose } from '../icons';
  import { createTabReloadGate } from '../structured-file';
  import { createTabsStructuredSaver } from '../structured-file-tab-saver';
  import {
    kanbanId,
    parseKanbanBoard,
    serializeKanbanBoard,
    type KanbanBoard,
    type KanbanCard,
    type KanbanColumn,
  } from './board';

  let { paneId = 'pane-1' }: { paneId?: string } = $props();

  /**
   * Hold time before a touch press turns into a card/column drag. Moving the
   * finger sooner cancels the drag and scrolls the board or column natively.
   * Mouse drags still start immediately.
   */
  const TOUCH_DRAG_DELAY_MS = 200;

  let boardEl = $state<HTMLDivElement | undefined>(undefined);
  /** Pointer that last pressed a column title: dblclick only exists for mice. */
  let titlePointerType = 'mouse';

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));

  let board = $state<KanbanBoard>({ columns: [] });
  /** Set when the file is not a board: shown read-only, never saved. */
  let parseError = $state<string | null>(null);
  let editingColumnId = $state<string | null>(null);
  let addingCardColumnId = $state<string | null>(null);
  let newCardText = $state('');
  const shouldReload = createTabReloadGate();
  const saver = createTabsStructuredSaver();

  $effect(() => {
    const current = tab;
    if (!shouldReload(current)) return;
    editingColumnId = null;
    addingCardColumnId = null;
    if (!current) {
      board = { columns: [] };
      parseError = null;
      return;
    }
    // Content is read untracked: our own edits update it and must not reload.
    const content = untrack(() => current.content ?? '');
    const parsed = parseKanbanBoard(content, [
      t('kanban.column.todo'),
      t('kanban.column.doing'),
      t('kanban.column.done'),
    ]);
    if (parsed.ok) {
      board = parsed.board;
      parseError = null;
    } else {
      board = { columns: [] };
      parseError = parsed.error;
    }
  });

  /** Copy the board into the tab right away; the disk write is debounced. */
  function commitEdit() {
    const current = tab;
    if (!current || parseError !== null) return;
    tabsStore.updateContent(current.id, serializeKanbanBoard(board));
    if (current.filePath) saver.schedule(current.id);
  }

  function handleColumnCardsConsider(colId: string, e: CustomEvent<DndEvent<KanbanCard>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
  }
  function handleColumnCardsFinalize(colId: string, e: CustomEvent<DndEvent<KanbanCard>>) {
    const idx = board.columns.findIndex(c => c.id === colId);
    if (idx < 0) return;
    board.columns[idx].cards = e.detail.items;
    commitEdit();
  }
  function handleColumnsConsider(e: CustomEvent<DndEvent<KanbanColumn>>) {
    board.columns = e.detail.items;
  }
  function handleColumnsFinalize(e: CustomEvent<DndEvent<KanbanColumn>>) {
    board.columns = e.detail.items;
    commitEdit();
  }

  function addCard(colId: string) {
    const text = newCardText.trim();
    if (!text) { addingCardColumnId = null; return; }
    const col = board.columns.find(c => c.id === colId);
    if (col) {
      col.cards.push({ id: kanbanId(), text });
      commitEdit();
    }
    newCardText = '';
    addingCardColumnId = null;
  }

  function deleteCard(colId: string, cardId: string) {
    const col = board.columns.find(c => c.id === colId);
    if (!col) return;
    col.cards = col.cards.filter(c => c.id !== cardId);
    commitEdit();
  }

  function addColumn() {
    board.columns.push({ id: kanbanId(), name: t('kanban.newColumn'), cards: [] });
    commitEdit();
  }

  function deleteColumn(colId: string) {
    board.columns = board.columns.filter(c => c.id !== colId);
    commitEdit();
  }

  function renameColumn(colId: string, name: string) {
    const col = board.columns.find(c => c.id === colId);
    if (col && col.name !== name) {
      col.name = name || 'Column';
      commitEdit();
    }
    editingColumnId = null;
  }

  function onColumnNameKeydown(e: KeyboardEvent) {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    else if (e.key === 'Escape') editingColumnId = null;
  }

  function onCardInputKeydown(e: KeyboardEvent, colId: string) {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addCard(colId);
      focusAfterRender('data-add-card', colId);
    } else if (e.key === 'Escape') {
      addingCardColumnId = null;
      newCardText = '';
      focusAfterRender('data-add-card', colId);
    }
  }

  /**
   * Render pending state now and focus the element for `colId` inside the
   * current event: mobile browsers only raise the soft keyboard for a focus
   * made during the tap itself, not in a later microtask. Scoped to this
   * board because split panes can show the same file (same ids) twice.
   */
  function focusAfterRender(attr: string, colId: string, select = false) {
    flushSync();
    const el = boardEl?.querySelector<HTMLElement>(`[${attr}="${CSS.escape(colId)}"]`);
    if (!el) return;
    el.focus();
    if (select && el instanceof HTMLInputElement) el.select();
  }

  function startRename(colId: string) {
    editingColumnId = colId;
    focusAfterRender('data-col-input', colId, true);
  }

  function onColumnTitleClick(colId: string) {
    // A mouse renames on dblclick; touch and pen have no reliable dblclick.
    if (titlePointerType !== 'mouse') startRename(colId);
  }

  function startAddCard(colId: string) {
    addingCardColumnId = colId;
    newCardText = '';
    focusAfterRender('data-card-input', colId);
  }

  // Unmounting (tab switch to a non-kanban file, pane close) must write the
  // pending edit, not cancel it.
  onDestroy(() => {
    void saver.flush();
  });
</script>

{#if parseError !== null}
  <div class="parse-error" role="alert" data-testid="kanban-parse-error">
    <p class="parse-error-title">{t('kanban.parseErrorTitle')}</p>
    <p class="parse-error-hint">{t('kanban.parseErrorHint')}</p>
    <code class="parse-error-detail">{parseError}</code>
  </div>
{:else}
<div class="board" bind:this={boardEl}>
  <section
    class="columns"
    use:dndzone={{ items: board.columns, type: 'column', flipDurationMs: 180, delayTouchStart: TOUCH_DRAG_DELAY_MS }}
    onconsider={handleColumnsConsider}
    onfinalize={handleColumnsFinalize}
  >
    {#each board.columns as col (col.id)}
      <div class="column">
        <header class="col-header">
          {#if editingColumnId === col.id}
            <input
              class="col-name-input"
              data-col-input={col.id}
              value={col.name}
              enterkeyhint="done"
              onblur={(e) => renameColumn(col.id, (e.target as HTMLInputElement).value)}
              onkeydown={onColumnNameKeydown}
            />
          {:else}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <h3
              class="col-name"
              onpointerdown={(e) => { titlePointerType = e.pointerType; }}
              onclick={() => onColumnTitleClick(col.id)}
              ondblclick={() => startRename(col.id)}
            >{col.name}</h3>
          {/if}
          <span class="col-count">{col.cards.length}</span>
          <button class="col-del" title={t('kanban.deleteColumn')} onclick={() => deleteColumn(col.id)}><IconClose size={12} /></button>
        </header>

        <div
          class="cards"
          use:dndzone={{ items: col.cards, type: 'card', flipDurationMs: 180, dropTargetStyle: {}, delayTouchStart: TOUCH_DRAG_DELAY_MS }}
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
            <textarea
              class="card-input"
              data-card-input={col.id}
              bind:value={newCardText}
              placeholder={t('kanban.cardPlaceholder')}
              enterkeyhint="done"
              onblur={() => addCard(col.id)}
              onkeydown={(e) => onCardInputKeydown(e, col.id)}
            ></textarea>
          {:else}
            <button class="add-card" data-add-card={col.id} onclick={() => startAddCard(col.id)}>{t('kanban.addCard')}</button>
          {/if}
        </footer>
      </div>
    {/each}

    <button class="add-column" onclick={addColumn}>{t('kanban.addColumn')}</button>
  </section>
</div>
{/if}

<style>
  .board {
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    /* A horizontal swipe past the last column must not drag the app body or
       trigger browser back-swipe. */
    overscroll-behavior-x: contain;
    padding: 14px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }
  .parse-error {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
    color: var(--novelist-text-secondary);
  }
  .parse-error-title { margin: 0; font-size: 0.95rem; font-weight: 500; color: var(--novelist-text); }
  .parse-error-hint { margin: 0; font-size: 0.8rem; max-width: 460px; }
  .parse-error-detail {
    font-size: 0.75rem;
    max-width: 460px;
    overflow-wrap: anywhere;
    opacity: 0.8;
  }
  .columns {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    height: 100%;
    min-width: fit-content;
  }
  .column {
    flex: 0 0 min(272px, calc(100vw - 48px));
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
  /* The icon must not be the event target: svelte-dnd-action skips drag
     detection only when the press lands on the button itself. */
  .col-del :global(svg), .card-del :global(svg) { pointer-events: none; }
  .col-del:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
  .cards {
    flex: 1;
    overflow-y: auto;
    overscroll-behavior-y: contain;
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
  /* Cards are drag sources, not editable text: a long press lifts the card
     instead of opening the iOS selection callout. */
  .card, .col-name {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .card:active { cursor: grabbing; }
  .card-text { flex: 1; }
  .card-del {
    opacity: 0;
    border: none; background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer; font-size: 11px;
    padding: 0 2px; border-radius: 3px;
  }
  .card:hover .card-del, .card-del:focus-visible { opacity: 1; }
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
    font-size: 14px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-accent);
    border-radius: 4px;
    resize: vertical;
    outline: none;
    color: var(--novelist-text);
  }
  .add-column {
    flex: 0 0 min(272px, calc(100vw - 48px));
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

  /* Touch: no hover to reveal delete, 44px targets (negative margins keep
     header and card heights compact), 16px fields so iOS does not zoom. */
  @media (hover: none), (pointer: coarse) {
    .card-del { opacity: 1; }
    .col-del, .card-del {
      min-width: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      touch-action: manipulation;
    }
    .col-del { margin: -8px -10px -8px 0; }
    .card-del { margin: -8px -10px -8px 0; }
    .col-name {
      align-self: stretch;
      display: flex;
      align-items: center;
    }
    .add-card, .add-column {
      min-height: 44px;
      touch-action: manipulation;
    }
    .col-name-input, .card-input { font-size: 16px; }
  }
</style>
