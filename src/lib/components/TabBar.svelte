<script lang="ts">
  import { tabsStore } from '$lib/stores/tabs.svelte';

  interface Props {
    paneId?: string;
  }

  let { paneId }: Props = $props();

  // Derive the effective pane id - fall back to active pane
  let effectivePaneId = $derived(paneId ?? tabsStore.activePaneId);
  let paneTabs = $derived(tabsStore.getPaneTabs(effectivePaneId));
  let paneActiveTabId = $derived(tabsStore.getPaneActiveTabId(effectivePaneId));

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
  }

  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes('novelist/tab-id')) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const tabId = e.dataTransfer?.getData('novelist/tab-id');
    const sourcePaneId = e.dataTransfer?.getData('novelist/source-pane');
    if (tabId && sourcePaneId && sourcePaneId !== effectivePaneId) {
      tabsStore.moveTabToPane(tabId, effectivePaneId);
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tab-bar flex items-center overflow-x-auto"
  data-tauri-drag-region
  ondragover={handleDragOver}
  ondrop={handleDrop}
  style="
    height: 2rem;
    background: transparent;
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    padding-left: env(titlebar-area-x, 78px);
  "
>
  {#each paneTabs as tab (tab.id)}
    <button
      class="tab-item group relative flex items-center h-full shrink-0 cursor-pointer"
      class:tab-active={tab.id === paneActiveTabId}
      draggable="true"
      ondragstart={(e) => handleDragStart(e, tab.id)}
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
          title="Unsaved changes"
        ></span>
      {/if}
      <span>{tab.fileName}</span>
      <span
        role="button"
        tabindex="-1"
        class="close-btn flex items-center justify-center rounded-sm cursor-pointer"
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
        title="Close tab"
      >
        &#x2715;
      </span>
    </button>
  {/each}
</div>

<style>
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
</style>
