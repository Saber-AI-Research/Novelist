<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import ConflictDialog from '$lib/components/ConflictDialog.svelte';
  import Outline from '$lib/components/Outline.svelte';
  import ZenMode from '$lib/components/ZenMode.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import type { HeadingItem } from '$lib/editor/outline';

  let wordCount = $state(0);
  let cursorLine = $state(1);
  let cursorCol = $state(1);
  let headings = $state<HeadingItem[]>([]);
  let editorRef = $state<{ scrollToPosition: (from: number) => void } | undefined>(undefined);
  let paletteOpen = $state(false);

  // Conflict dialog state
  let conflictFilePath = $state<string | null>(null);

  function handleKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
      e.preventDefault();
      uiStore.toggleSidebar();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      uiStore.toggleOutline();
    }
    if (e.key === 'F11' || ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Z')) {
      e.preventDefault();
      uiStore.toggleZen();
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      paletteOpen = !paletteOpen;
    }
    if (e.key === 'Escape' && uiStore.zenMode) {
      e.preventDefault();
      uiStore.toggleZen();
    }
  }

  async function handleKeepMine(filePath: string) {
    const tab = tabsStore.findByPath(filePath);
    if (!tab) return;
    await commands.registerWriteIgnore(filePath);
    const result = await commands.writeFile(filePath, tab.content);
    if (result.status === 'ok') {
      tabsStore.markSaved(tab.id);
    } else {
      console.error('Failed to save (keep mine):', result.error);
    }
  }

  async function handleLoadTheirs(filePath: string) {
    const tab = tabsStore.findByPath(filePath);
    if (!tab) return;
    const result = await commands.readFile(filePath);
    if (result.status === 'ok') {
      tabsStore.reloadContent(tab.id, result.data);
    } else {
      console.error('Failed to read file (load theirs):', result.error);
    }
  }

  onMount(async () => {
    commandRegistry.register({ id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: 'Ctrl+B', handler: () => uiStore.toggleSidebar() });
    commandRegistry.register({ id: 'toggle-outline', label: 'Toggle Outline', shortcut: 'Ctrl+Shift+O', handler: () => uiStore.toggleOutline() });
    commandRegistry.register({ id: 'toggle-zen', label: 'Toggle Zen Mode', shortcut: 'F11', handler: () => uiStore.toggleZen() });
    commandRegistry.register({ id: 'command-palette', label: 'Command Palette', shortcut: 'Ctrl+Shift+P', handler: () => { paletteOpen = !paletteOpen; } });

    const unlisten = await listen<{ path: string }>('file-changed', async (event) => {
      const { path } = event.payload;
      const tab = tabsStore.findByPath(path);
      if (!tab) return;

      if (!tab.isDirty) {
        // Silently reload
        const result = await commands.readFile(path);
        if (result.status === 'ok') {
          tabsStore.reloadContent(tab.id, result.data);
        }
      } else {
        // Show conflict dialog
        conflictFilePath = path;
      }
    });

    return () => {
      unlisten();
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if uiStore.zenMode}
  <ZenMode {wordCount}>
    <div class="flex-1 min-h-0 overflow-hidden w-full">
      {#if tabsStore.activeTab}
        <Editor bind:wordCount bind:cursorLine bind:cursorCol bind:headings bind:this={editorRef} />
      {:else}
        <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-secondary);">
          <div class="text-center">
            <p class="text-lg mb-2">Novelist</p>
            <p class="text-sm">Open a folder to get started</p>
          </div>
        </div>
      {/if}
    </div>
  </ZenMode>
{:else}
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
          <Editor bind:wordCount bind:cursorLine bind:cursorCol bind:headings bind:this={editorRef} />
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

    {#if uiStore.outlineVisible}
      <div class="shrink-0 overflow-y-auto" style="width: 200px;">
        <Outline {headings} onNavigate={(from) => editorRef?.scrollToPosition(from)} />
      </div>
    {/if}
  </div>
{/if}

{#if conflictFilePath}
  <ConflictDialog
    filePath={conflictFilePath}
    onKeepMine={() => handleKeepMine(conflictFilePath!)}
    onLoadTheirs={() => handleLoadTheirs(conflictFilePath!)}
    onClose={() => { conflictFilePath = null; }}
  />
{/if}

{#if paletteOpen}
  <CommandPalette onClose={() => { paletteOpen = false; }} />
{/if}
