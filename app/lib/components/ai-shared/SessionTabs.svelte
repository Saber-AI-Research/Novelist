<script lang="ts">
  /**
   * Session-tab bar used by the AI Talk panel.
   * Horizontally scrollable list of session tabs + a "+" new button.
   * Each tab shows the title and highlights when active; hover reveals the
   * delete button and double-click renames. Without hover (touch), the
   * delete button stays visible and the active tab shows a rename button.
   */
  import { flushSync } from 'svelte';
  import Pencil from '@lucide/svelte/icons/pencil';

  type Item = { id: string; title: string };

  type Props = {
    items: readonly Item[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, title: string) => void;
    /** Prefix for data-testid attributes so tests can scope correctly. */
    testidPrefix?: string;
    /** Label for the "+" button tooltip. */
    newLabel?: string;
    /** Label for the touch rename button. */
    renameLabel?: string;
  };

  let {
    items,
    activeId,
    onSelect,
    onNew,
    onDelete,
    onRename,
    testidPrefix = 'session',
    newLabel = 'New session',
    renameLabel = 'Rename',
  }: Props = $props();

  let editingId = $state<string | null>(null);
  let editInput = $state('');
  let renameInput = $state<HTMLInputElement | undefined>(undefined);

  function beginRename(item: Item) {
    editingId = item.id;
    editInput = item.title;
    // Render and focus inside the click/tap itself: iOS only raises the
    // on-screen keyboard for focus() calls made during a user gesture.
    flushSync();
    renameInput?.focus();
    renameInput?.select();
  }

  function commitRename() {
    const id = editingId;
    if (!id) return;
    editingId = null;
    onRename(id, editInput);
  }
</script>

<div class="session-tabs" data-testid="{testidPrefix}-tabs">
  <div class="scroll">
    {#each items as item (item.id)}
      <div
        class="tab"
        class:active={item.id === activeId}
        data-testid="{testidPrefix}-tab-{item.id}"
      >
        {#if editingId === item.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            bind:this={renameInput}
            class="title-edit"
            type="text"
            autofocus
            data-testid="{testidPrefix}-rename-input"
            value={editInput}
            oninput={(e) => (editInput = e.currentTarget.value)}
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.isComposing) return;
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                editingId = null;
              }
            }}
          />
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <button
            type="button"
            class="title"
            title={item.title}
            onclick={() => onSelect(item.id)}
            ondblclick={() => beginRename(item)}
          >{item.title}</button>
          {#if item.id === activeId}
            <button
              type="button"
              class="rename"
              title={renameLabel}
              aria-label="{renameLabel} {item.title}"
              data-testid="{testidPrefix}-edit-{item.id}"
              onclick={(e) => {
                e.stopPropagation();
                beginRename(item);
              }}
            ><Pencil size={12} /></button>
          {/if}
        {/if}
        <button
          type="button"
          class="close"
          title="Delete session"
          aria-label="Delete session {item.title}"
          data-testid="{testidPrefix}-close-{item.id}"
          onclick={(e) => {
            e.stopPropagation();
            onDelete(item.id);
          }}
        >×</button>
      </div>
    {/each}
  </div>
  <button
    type="button"
    class="novelist-btn novelist-btn-quiet icon-btn new-btn"
    title={newLabel}
    aria-label={newLabel}
    data-testid="{testidPrefix}-new"
    onclick={onNew}
  >+</button>
</div>

<style>
  /* OpenFic-style tab strip: tinted bar, tabs sit on its bottom edge and
     the active one opens into the panel below. */
  .session-tabs {
    position: relative;
    display: flex;
    align-items: flex-end;
    padding: 0 4px 0 6px;
    border-bottom: 1px solid var(--novelist-border);
    background: color-mix(in srgb, var(--novelist-bg-secondary) 70%, var(--novelist-bg));
    min-height: 32px;
  }
  .scroll {
    flex: 1;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    margin-bottom: -1px;
  }
  .scroll::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 27px;
    padding: 0 3px 0 8px;
    min-width: 72px;
    max-width: 160px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 7px 7px 0 0;
    font-size: 11.5px;
    color: var(--novelist-text-secondary);
    background: transparent;
    transition: background 80ms, color 80ms;
  }
  .tab.active {
    height: 29px;
    background: var(--novelist-bg);
    border-color: var(--novelist-border);
    color: var(--novelist-text);
    font-weight: 500;
  }
  .tab:not(.active):hover {
    background: color-mix(in srgb, var(--novelist-text) 5%, transparent);
    color: var(--novelist-text);
  }
  .title {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 4px 4px;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title-edit {
    flex: 1;
    min-width: 60px;
    max-width: 140px;
    border: 1px solid var(--novelist-accent);
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font: inherit;
    padding: 2px 4px;
    border-radius: 2px;
    outline: none;
  }
  .close {
    width: 18px;
    height: 18px;
    border: none;
    background: transparent;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    cursor: pointer;
    border-radius: 5px;
    font-size: 12px;
    line-height: 1;
    opacity: 0;
    flex-shrink: 0;
  }
  .tab:hover .close,
  .tab.active .close { opacity: 1; }
  .close:hover {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
  }
  /* Touch-only rename affordance; desktop renames via double-click. */
  .rename {
    display: none;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    cursor: pointer;
    flex-shrink: 0;
  }
  .new-btn {
    align-self: center;
    margin: 0 2px;
    height: 22px;
    width: 22px;
    min-height: 22px;
    font-size: 14px;
    border-radius: 3px;
  }
  @media (hover: none) {
    .close { opacity: 1; }
    .rename { display: inline-flex; }
  }
  @media (pointer: coarse) {
    .session-tabs { min-height: 44px; }
    .tab,
    .tab.active {
      height: 44px;
      max-width: 220px;
    }
    .title { align-self: stretch; }
    .close,
    .rename {
      align-self: stretch;
      width: 44px;
      height: auto;
      font-size: 16px;
    }
    .new-btn {
      width: 44px;
      height: 44px;
      min-height: 44px;
      font-size: 18px;
    }
  }
  /* iOS zooms the page when focusing a field under 16px. */
  :global(html[data-mobile='true']) .title-edit { font-size: 16px; }
</style>
