<script lang="ts">
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { t } from '$lib/i18n';
  import EditorShareMenu from './EditorShareMenu.svelte';
  import { SIDEBAR_PATH_MIME, hasSidebarPath, openPathInPane } from '$lib/services/pane-drop';

  interface Props {
    paneId?: string;
  }

  let { paneId }: Props = $props();

  // Derive the effective pane id - fall back to active pane
  let effectivePaneId = $derived(paneId ?? tabsStore.activePaneId);
  let paneTabs = $derived(tabsStore.getPaneTabs(effectivePaneId));
  let paneActiveTabId = $derived(tabsStore.getPaneActiveTabId(effectivePaneId));

  let barEl = $state<HTMLDivElement>();
  // Insertion index for a tab drop (null = no tab drag over this bar).
  let dropIndex = $state<number | null>(null);

  function handleTabClick(id: string) {
    tabsStore.setActivePane(effectivePaneId);
    tabsStore.activateTab(id);
  }

  function handleCloseTab(e: MouseEvent, id: string) {
    e.stopPropagation();
    tabsStore.closeTab(id);
  }

  function handleAuxClick(e: MouseEvent, id: string) {
    if (e.button === 1) {
      e.preventDefault();
      tabsStore.closeTab(id);
    }
  }

  function handleDragStart(e: DragEvent, id: string) {
    e.dataTransfer?.setData('novelist/tab-id', id);
    e.dataTransfer?.setData('novelist/source-pane', effectivePaneId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    uiStore.tabDragActive = true;
  }

  function handleDragEnd() {
    uiStore.tabDragActive = false;
    dropIndex = null;
  }

  /** Index where a drop would insert, based on cursor X vs each tab midpoint. */
  function computeInsertIndex(clientX: number): number {
    if (!barEl) return paneTabs.length;
    const items = Array.from(barEl.querySelectorAll('.tab-item')) as HTMLElement[];
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return items.length;
  }

  function handleDragOver(e: DragEvent) {
    const types = e.dataTransfer?.types;
    if (types?.includes('novelist/tab-id') || hasSidebarPath(types)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (types?.includes('novelist/tab-id')) dropIndex = computeInsertIndex(e.clientX);
    }
  }

  function handleDragLeave() {
    dropIndex = null;
  }

  function handleDrop(e: DragEvent) {
    if (!e.dataTransfer) return;
    const types = e.dataTransfer.types;
    const index = dropIndex ?? computeInsertIndex(e.clientX);
    dropIndex = null;
    uiStore.tabDragActive = false;

    if (hasSidebarPath(types)) {
      e.preventDefault();
      const path = e.dataTransfer.getData(SIDEBAR_PATH_MIME);
      if (path) void openPathInPane(effectivePaneId, path);
      return;
    }
    if (types.includes('novelist/tab-id')) {
      e.preventDefault();
      const tabId = e.dataTransfer.getData('novelist/tab-id');
      const sourcePaneId = e.dataTransfer.getData('novelist/source-pane');
      if (!tabId) return;
      if (sourcePaneId === effectivePaneId) {
        // Reorder within this pane. The computed index is visual (includes the
        // dragged tab), so shift left when moving a tab rightward.
        const from = paneTabs.findIndex(tb => tb.id === tabId);
        if (from === -1) return;
        tabsStore.reorderTabInPane(effectivePaneId, tabId, from < index ? index - 1 : index);
      } else {
        tabsStore.moveTabToPaneAt(tabId, effectivePaneId, index);
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tab-bar-row flex items-center"
  style="
    height: 2.35rem;
    background: transparent;
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    padding-left: env(titlebar-area-x, 78px);
  "
>
<div
  bind:this={barEl}
  class="tab-bar flex items-center overflow-x-auto"
  data-testid="tab-bar"
  data-tauri-drag-region
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
  style="flex: 1 1 auto; min-width: 0; height: 100%;"
>
  {#each paneTabs as tab, i (tab.id)}
    <button
      class="tab-item group relative flex items-center h-full shrink-0 cursor-pointer"
      class:tab-active={tab.id === paneActiveTabId}
      class:drop-before={dropIndex === i}
      class:drop-after={dropIndex === paneTabs.length && i === paneTabs.length - 1}
      data-testid="tab-{tab.fileName}"
      draggable="true"
      ondragstart={(e) => handleDragStart(e, tab.id)}
      ondragend={handleDragEnd}
      style="
        padding: 0 0.75rem;
        background: transparent;
        color: {tab.id === paneActiveTabId ? 'var(--novelist-text)' : 'var(--novelist-text-tertiary)'};
        font-size: 0.78rem;
        letter-spacing: 0.01em;
        border: none;
        border-bottom: 2px solid {tab.id === paneActiveTabId ? 'var(--novelist-accent)' : 'transparent'};
        margin-bottom: -1px;
        transition: color 0.15s ease, border-color 0.15s ease;
        white-space: nowrap;
      "
      onclick={() => handleTabClick(tab.id)}
      onauxclick={(e) => handleAuxClick(e, tab.id)}
    >
      {#if tab.isDirty}
        <span
          class="dirty-dot"
          style="
            display: inline-block;
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: var(--novelist-accent);
            margin-right: 0.35rem;
            opacity: 0.7;
            flex-shrink: 0;
          "
          title={t('tab.unsaved')}
        ></span>
      {/if}
      <span>{tab.fileName}</span>
      <span
        role="button"
        tabindex="-1"
        class="close-btn flex items-center justify-center rounded-sm cursor-pointer"
        data-testid="tab-close-{tab.fileName}"
        style="
          margin-left: 0.4rem;
          width: 14px;
          height: 14px;
          font-size: 0.6rem;
          line-height: 1;
          color: var(--novelist-text-tertiary);
          opacity: 0;
          transition: opacity 0.12s ease, background 0.12s ease;
        "
        onclick={(e: MouseEvent) => handleCloseTab(e, tab.id)}
        onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.stopPropagation(); tabsStore.closeTab(tab.id); } }}
        title={t('tab.close')}
      >
        &#x2715;
      </span>
    </button>
  {/each}
</div>
  {#if paneTabs.length > 0}
    <div class="share-slot">
      <EditorShareMenu paneId={effectivePaneId} />
    </div>
  {/if}
</div>

<style>
  .tab-bar-row { position: relative; }
  .share-slot {
    flex-shrink: 0;
    padding: 0 8px;
    position: relative;
  }
  /* Hide scrollbar but keep horizontal scroll functionality */
  .tab-bar {
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE/Edge */
  }
  .tab-bar::-webkit-scrollbar {
    display: none; /* Chrome/Safari/WebKit */
  }
  .tab-item:hover {
    color: var(--novelist-text-secondary) !important;
  }
  .tab-item:hover .close-btn {
    opacity: 0.5 !important;
  }
  .tab-item .close-btn:hover {
    opacity: 1 !important;
    background: var(--novelist-bg-tertiary);
  }
  .tab-active:hover {
    color: var(--novelist-text) !important;
  }
  /* Tab drag insertion caret. */
  .tab-item.drop-before {
    box-shadow: inset 2px 0 0 0 var(--novelist-accent);
  }
  .tab-item.drop-after {
    box-shadow: inset -2px 0 0 0 var(--novelist-accent);
  }
</style>
