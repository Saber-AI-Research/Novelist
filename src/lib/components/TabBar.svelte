<script lang="ts">
  import { tabsStore } from '$lib/stores/tabs.svelte';

  function handleAuxClick(e: MouseEvent, id: string) {
    if (e.button === 1) {
      e.preventDefault();
      tabsStore.closeTab(id);
    }
  }
</script>

<div
  class="h-9 flex items-center overflow-x-auto"
  style="background: var(--novelist-bg-secondary); border-bottom: 1px solid var(--novelist-border);"
>
  {#each tabsStore.tabs as tab (tab.id)}
    <button
      class="group relative flex items-center h-full px-3 text-xs whitespace-nowrap shrink-0 cursor-pointer"
      style="
        background: {tab.id === tabsStore.activeTabId ? 'var(--novelist-bg)' : 'transparent'};
        color: {tab.id === tabsStore.activeTabId ? 'var(--novelist-text)' : 'var(--novelist-text-secondary)'};
        border-right: 1px solid var(--novelist-border);
      "
      onclick={() => tabsStore.activateTab(tab.id)}
      onauxclick={(e) => handleAuxClick(e, tab.id)}
    >
      <span class="mr-1">
        {#if tab.isDirty}
          <span style="color: var(--novelist-accent);" title="Unsaved changes">&#x25CF;</span>
        {/if}
      </span>
      <span>{tab.fileName}</span>
      <span
        role="button"
        tabindex="-1"
        class="ml-2 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:opacity-100 cursor-pointer"
        style="color: var(--novelist-text-secondary);"
        onclick={(e: MouseEvent) => { e.stopPropagation(); tabsStore.closeTab(tab.id); }}
        onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.stopPropagation(); tabsStore.closeTab(tab.id); } }}
        title="Close tab"
      >
        &#x2715;
      </span>
    </button>
  {/each}
</div>
