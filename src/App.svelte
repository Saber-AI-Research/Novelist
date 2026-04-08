<script lang="ts">
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { open } from '@tauri-apps/plugin-dialog';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import ConflictDialog from '$lib/components/ConflictDialog.svelte';
  import Outline from '$lib/components/Outline.svelte';
  import ZenMode from '$lib/components/ZenMode.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ExportDialog from '$lib/components/ExportDialog.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import type { HeadingItem } from '$lib/editor/outline';

  // Per-pane editor state for status bar & outline navigation
  let pane1WordCount = $state(0);
  let pane1CursorLine = $state(1);
  let pane1CursorCol = $state(1);
  let pane1Headings = $state<HeadingItem[]>([]);
  let pane1EditorRef = $state<{ scrollToPosition: (from: number) => void } | undefined>(undefined);

  let pane2WordCount = $state(0);
  let pane2CursorLine = $state(1);
  let pane2CursorCol = $state(1);
  let pane2Headings = $state<HeadingItem[]>([]);
  let pane2EditorRef = $state<{ scrollToPosition: (from: number) => void } | undefined>(undefined);

  // Status bar reflects active pane
  let wordCount = $derived(tabsStore.activePaneId === 'pane-2' ? pane2WordCount : pane1WordCount);
  let cursorLine = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorLine : pane1CursorLine);
  let cursorCol = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorCol : pane1CursorCol);
  let headings = $derived(tabsStore.activePaneId === 'pane-2' ? pane2Headings : pane1Headings);
  let activeEditorRef = $derived(tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef);

  let paletteOpen = $state(false);
  let exportDialogOpen = $state(false);

  // Conflict dialog state
  let conflictFilePath = $state<string | null>(null);

  async function openProjectFromPath(dirPath: string) {
    projectStore.isLoading = true;
    await commands.stopFileWatcher();

    const configResult = await commands.detectProject(dirPath);
    const config = configResult.status === 'ok' ? configResult.data : null;

    const filesResult = await commands.listDirectory(dirPath);
    const files = filesResult.status === 'ok' ? filesResult.data : [];

    projectStore.setProject(dirPath, config, files);
    tabsStore.closeAll();

    // Track as recent project
    const name = config?.project?.name || dirPath.split('/').pop() || 'Untitled';
    commands.addRecentProject(dirPath, name);

    // Start watching
    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') {
      console.error('Failed to start file watcher:', watchResult.error);
    }
  }

  async function handleOpenDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await openProjectFromPath(selected as string);
  }

  async function handleOpenRecent(path: string) {
    await openProjectFromPath(path);
  }

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
    // Cmd+\ or Ctrl+\ to toggle split view
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      tabsStore.toggleSplit();
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
    commandRegistry.register({ id: 'toggle-split', label: 'Toggle Split View', shortcut: 'Ctrl+\\', handler: () => tabsStore.toggleSplit() });
    commandRegistry.register({ id: 'export-project', label: 'Export Project', handler: () => { exportDialogOpen = true; } });

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

{#if !projectStore.isOpen}
  <Welcome onOpenDirectory={handleOpenDirectory} onOpenRecent={handleOpenRecent} />
{:else if uiStore.zenMode}
  <ZenMode {wordCount}>
    <div class="flex-1 min-h-0 overflow-hidden w-full">
      {#if tabsStore.getPaneActiveTab('pane-1')}
        <Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} />
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
  <!--
    Layout: sidebar | [editor-area] | outline
    Editor area: [pane1] | [pane2 if split] stacked vertically with shared status bar
  -->
  <div class="flex h-full w-full">
    {#if uiStore.sidebarVisible}
      <div class="shrink-0" style="width: {uiStore.sidebarWidth}px; border-right: 1px solid var(--novelist-border);">
        <Sidebar />
      </div>
    {/if}

    <!-- Main editor column (contains split panes + status bar) -->
    <div class="flex flex-col flex-1 min-w-0">
      <!-- Panes row -->
      <div class="flex flex-1 min-h-0">

        <!-- Pane 1 -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex flex-col flex-1 min-w-0"
          style="
            border-right: {tabsStore.splitActive ? '1px solid var(--novelist-border)' : 'none'};
            {tabsStore.splitActive && tabsStore.activePaneId === 'pane-1' ? 'box-shadow: inset 0 0 0 2px var(--novelist-accent);' : ''}
          "
          onclick={() => tabsStore.setActivePane('pane-1')}
        >
          <TabBar paneId="pane-1" />

          <div class="flex-1 min-h-0 overflow-hidden">
            {#if tabsStore.getPaneActiveTab('pane-1')}
              <Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} />
            {:else}
              <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-secondary);">
                <div class="text-center">
                  <p class="text-lg mb-2">Novelist</p>
                  <p class="text-sm">Open a folder to get started (Ctrl+B to toggle sidebar)</p>
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- Pane 2 (shown when split is active) -->
        {#if tabsStore.splitActive}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex flex-col flex-1 min-w-0"
            style="{tabsStore.activePaneId === 'pane-2' ? 'box-shadow: inset 0 0 0 2px var(--novelist-accent);' : ''}"
            onclick={() => tabsStore.setActivePane('pane-2')}
          >
            <TabBar paneId="pane-2" />

            <div class="flex-1 min-h-0 overflow-hidden">
              {#if tabsStore.getPaneActiveTab('pane-2')}
                <Editor paneId="pane-2" bind:wordCount={pane2WordCount} bind:cursorLine={pane2CursorLine} bind:cursorCol={pane2CursorCol} bind:headings={pane2Headings} bind:this={pane2EditorRef} />
              {:else}
                <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-secondary);">
                  <div class="text-center">
                    <p class="text-lg mb-2">Split View</p>
                    <p class="text-sm">Open a file in this pane</p>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}

      </div>

      <!-- Shared status bar spanning both panes -->
      <StatusBar {wordCount} {cursorLine} {cursorCol} />
    </div>

    {#if uiStore.outlineVisible}
      <div class="shrink-0 overflow-y-auto" style="width: 200px;">
        <Outline {headings} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} />
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

{#if exportDialogOpen}
  <ExportDialog onClose={() => { exportDialogOpen = false; }} />
{/if}
