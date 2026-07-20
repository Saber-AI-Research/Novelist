<script lang="ts">
  /**
   * Shared session-tab bar used by both AI Talk and AI Agent panels.
   * Horizontally scrollable list of session tabs + a "+" new button.
   * Each tab shows the title and highlights when active. Panels can opt into
   * a compact keyboard menu for active-session actions; legacy callers retain
   * the hover delete and double-click rename affordances.
   */

  type Item = { id: string; title: string };

  type SessionMenuAction = {
    id: string;
    label: string;
    disabled?: boolean;
    danger?: boolean;
    confirmation?: string;
    onSelect: (id: string) => void | Promise<void>;
  };

  type Props = {
    items: readonly Item[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onDelete: (id: string) => void | Promise<void>;
    onRename: (id: string, title: string) => void | Promise<void>;
    /** Receives owned callback failures, or null after a later successful action. */
    onActionError?: (error: unknown | null) => void;
    /** When supplied, replaces hover/double-click actions with one menu. */
    menuActions?: readonly SessionMenuAction[];
    /** Prevent deleting the active session while its owner is busy or loading. */
    disableDelete?: boolean;
    /** Prevent every session mutation while the owner is changing context. */
    disableActions?: boolean;
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
    onActionError,
    menuActions,
    disableDelete = false,
    disableActions = false,
    testidPrefix = 'session',
    newLabel = 'New session',
  }: Props = $props();

  let editingId = $state<string | null>(null);
  let editInput = $state('');
  let renameInput = $state<HTMLInputElement | undefined>(undefined);
  let menuOpen = $state(false);
  let menuWrap = $state<HTMLDivElement | undefined>(undefined);
  let menuEl = $state<HTMLDivElement | undefined>(undefined);
  let menuButton = $state<HTMLButtonElement | undefined>(undefined);
  let activeItem = $derived(items.find((item) => item.id === activeId) ?? null);

  function focusMenuButton() {
    requestAnimationFrame(() => menuButton?.focus());
  }

  function menuItems(): HTMLButtonElement[] {
    if (!menuEl) return [];
    return Array.from(menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
  }

  function openMenu() {
    if (!activeItem || disableActions) return;
    menuOpen = true;
    requestAnimationFrame(() => menuItems()[0]?.focus());
  }

  function closeMenu(restoreFocus = true) {
    menuOpen = false;
    if (restoreFocus) focusMenuButton();
  }

  function toggleMenu() {
    if (menuOpen) closeMenu();
    else openMenu();
  }

  function beginRename(item: Item) {
    menuOpen = false;
    editingId = item.id;
    editInput = item.title;
    requestAnimationFrame(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  }

  function beginActiveRename() {
    if (activeItem && !disableActions) beginRename(activeItem);
  }

  async function runOwnedAction(action: () => void | Promise<void>) {
    try {
      await action();
      onActionError?.(null);
    } catch (error) {
      onActionError?.(error);
    }
  }

  async function commitRename() {
    const id = editingId;
    if (!id) return;
    editingId = null;
    try {
      await runOwnedAction(() => onRename(id, editInput));
    } finally {
      focusMenuButton();
    }
  }

  function cancelRename() {
    editingId = null;
    focusMenuButton();
  }

  async function runMenuAction(action: SessionMenuAction) {
    const item = activeItem;
    if (!item || disableActions || action.disabled) return;
    if (action.confirmation && !window.confirm(action.confirmation)) {
      closeMenu();
      return;
    }
    menuOpen = false;
    try {
      await runOwnedAction(() => action.onSelect(item.id));
    } finally {
      focusMenuButton();
    }
  }

  async function deleteActiveSession() {
    const item = activeItem;
    if (!item || disableActions || disableDelete) return;
    if (!window.confirm(`Delete session "${item.title}"? This cannot be undone.`)) {
      closeMenu();
      return;
    }
    menuOpen = false;
    try {
      await runOwnedAction(() => onDelete(item.id));
    } finally {
      focusMenuButton();
    }
  }

  function handleMenuKeydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (e.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
    else if (e.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      closeMenu();
      return;
    } else {
      return;
    }
    e.preventDefault();
    items[next]?.focus();
  }

  function handleWindowMouseDown(e: MouseEvent) {
    if (menuOpen && menuWrap && !menuWrap.contains(e.target as Node)) {
      closeMenu(false);
    }
  }
</script>

<svelte:window onmousedown={handleWindowMouseDown} />

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
                cancelRename();
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
              if (!menuActions) beginRename(item);
            }}
          >{item.title}</button>
        {/if}
        {#if !menuActions}
          <button
            type="button"
            class="close"
            title="Delete session"
            aria-label="Delete session {item.title}"
            data-testid="{testidPrefix}-close-{item.id}"
            onclick={(e) => {
              e.stopPropagation();
              void runOwnedAction(() => onDelete(item.id));
            }}
          >×</button>
        {/if}
      </div>
    {/each}
  </div>
  {#if menuActions && activeItem}
    <div class="menu-wrap" bind:this={menuWrap}>
      <button
        bind:this={menuButton}
        type="button"
        class="novelist-btn novelist-btn-quiet icon-btn menu-btn"
        title="Session actions for {activeItem.title}"
        aria-label="Session actions for {activeItem.title}"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="{testidPrefix}-menu-trigger"
        disabled={disableActions}
        onclick={toggleMenu}
      >...</button>
      {#if menuOpen}
        <div
          bind:this={menuEl}
          class="session-menu"
          role="menu"
          tabindex="-1"
          aria-label="Session actions"
          data-testid="{testidPrefix}-menu"
          onkeydown={handleMenuKeydown}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="{testidPrefix}-menu-rename"
            disabled={disableActions}
            onclick={beginActiveRename}
          >Rename session</button>
          {#each menuActions as action (action.id)}
            <button
              type="button"
              role="menuitem"
              class:danger={action.danger}
              data-testid="{testidPrefix}-menu-{action.id}"
              disabled={action.disabled}
              onclick={() => runMenuAction(action)}
            >{action.label}</button>
          {/each}
          <div class="menu-separator" role="separator"></div>
          <button
            type="button"
            role="menuitem"
            class="danger"
            data-testid="{testidPrefix}-menu-delete"
            disabled={disableDelete}
            onclick={deleteActiveSession}
          >Delete session</button>
        </div>
      {/if}
    </div>
  {/if}
  <button
    type="button"
    class="novelist-btn novelist-btn-quiet icon-btn new-btn"
    title={newLabel}
    aria-label={newLabel}
    data-testid="{testidPrefix}-new"
    disabled={disableActions}
    onclick={onNew}
  >+</button>
</div>

<style>
  .session-tabs {
    position: relative;
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
  .menu-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .menu-btn {
    margin: 2px 0 2px 4px;
    width: 24px;
    min-height: 22px;
    height: 22px;
    font-size: 11px;
    letter-spacing: 0;
  }
  .session-menu {
    position: absolute;
    z-index: 40;
    top: calc(100% + 2px);
    right: 0;
    min-width: 150px;
    padding: 4px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--novelist-text) 18%, transparent);
  }
  .session-menu button {
    display: block;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--novelist-text);
    font: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .session-menu button:hover:not(:disabled),
  .session-menu button:focus-visible {
    background: var(--novelist-bg-secondary);
    outline: none;
  }
  .session-menu button:disabled {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    cursor: not-allowed;
  }
  .session-menu .danger:not(:disabled) {
    font-weight: 500;
  }
  .menu-separator {
    height: 1px;
    margin: 4px;
    background: var(--novelist-border);
  }
</style>
