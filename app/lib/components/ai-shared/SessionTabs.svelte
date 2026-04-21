<script lang="ts">
  /**
   * Shared session-tab bar used by both AI Talk and AI Agent panels.
   * Horizontally scrollable list of session tabs + a "+" new button.
   * Each tab shows the title, highlights when active, and has a hover
   * × to delete. Double-click a tab to rename inline.
   */

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
  }: Props = $props();

  let editingId = $state<string | null>(null);
  let editInput = $state('');
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
            class="title-edit"
            type="text"
            autofocus
            value={editInput}
            oninput={(e) => (editInput = e.currentTarget.value)}
            onblur={() => {
              if (editingId) onRename(editingId, editInput);
              editingId = null;
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
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
            ondblclick={() => {
              editingId = item.id;
              editInput = item.title;
            }}
          >{item.title}</button>
        {/if}
        <button
          type="button"
          class="close"
          title="Delete session"
          aria-label="Delete session {item.title}"
          data-testid="{testidPrefix}-tab-close-{item.id}"
          onclick={(e) => { e.stopPropagation(); onDelete(item.id); }}
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
  .session-tabs {
    display: flex;
    align-items: stretch;
    border-bottom: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
    min-height: 28px;
  }
  .scroll {
    flex: 1;
    display: flex;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .scroll::-webkit-scrollbar {
    height: 4px;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 2px 0 8px;
    border-right: 1px solid var(--novelist-border);
    font-size: 11px;
    color: var(--novelist-text-secondary);
    background: transparent;
    transition: background 80ms, color 80ms;
    max-width: 180px;
  }
  .tab.active {
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }
  .tab:hover { background: var(--novelist-bg); }
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
    border-radius: 3px;
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
  .new-btn {
    margin: 2px 4px;
    height: 22px;
    width: 22px;
    min-height: 22px;
    font-size: 14px;
    border-radius: 3px;
  }
</style>
