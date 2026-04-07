<script lang="ts">
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';

  let wordCount = $state(0);
  let cursorLine = $state(1);
  let cursorCol = $state(1);

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      uiStore.toggleSidebar();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-full w-full">
  {#if uiStore.sidebarVisible}
    <div class="shrink-0" style="width: {uiStore.sidebarWidth}px; border-right: 1px solid var(--novelist-border);">
      <Sidebar />
    </div>
  {/if}

  <div class="flex flex-col flex-1 min-w-0">
    <TabBar />

    <div class="flex-1 min-h-0 overflow-hidden">
      {#if tabsStore.activeTab}
        <Editor bind:wordCount bind:cursorLine bind:cursorCol />
      {:else}
        <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-secondary);">
          <div class="text-center">
            <p class="text-lg mb-2">Novelist</p>
            <p class="text-sm">Open a folder to get started (Ctrl+B to toggle sidebar)</p>
          </div>
        </div>
      {/if}
    </div>

    <StatusBar {wordCount} {cursorLine} {cursorCol} />
  </div>
</div>
