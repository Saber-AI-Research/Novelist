<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { open } from '@tauri-apps/plugin-dialog';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import ConflictDialog from '$lib/components/ConflictDialog.svelte';
  import Outline from '$lib/components/Outline.svelte';
  import ZenMode from '$lib/components/ZenMode.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import ExportDialog from '$lib/components/ExportDialog.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import DraftNote from '$lib/components/DraftNote.svelte';
  import SnapshotPanel from '$lib/components/SnapshotPanel.svelte';
  import StatsPanel from '$lib/components/StatsPanel.svelte';
  import ProjectSearch from '$lib/components/ProjectSearch.svelte';
  import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { moveSection } from '$lib/editor/section-move';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import { shortcutsStore } from '$lib/stores/shortcuts.svelte';
  import type { HeadingItem } from '$lib/editor/outline';

  // Per-pane editor state for status bar & outline navigation
  let pane1WordCount = $state(0);
  let pane1CursorLine = $state(1);
  let pane1CursorCol = $state(1);
  let pane1Headings = $state<HeadingItem[]>([]);
  let pane1EditorRef = $state<{ scrollToPosition: (from: number) => void; jumpToAbsoluteLine: (line: number) => void } | undefined>(undefined);

  let pane2WordCount = $state(0);
  let pane2CursorLine = $state(1);
  let pane2CursorCol = $state(1);
  let pane2Headings = $state<HeadingItem[]>([]);
  let pane2EditorRef = $state<{ scrollToPosition: (from: number) => void; jumpToAbsoluteLine: (line: number) => void } | undefined>(undefined);

  // Status bar reflects active pane
  let wordCount = $derived(tabsStore.activePaneId === 'pane-2' ? pane2WordCount : pane1WordCount);
  let cursorLine = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorLine : pane1CursorLine);
  let cursorCol = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorCol : pane1CursorCol);
  let headings = $derived(tabsStore.activePaneId === 'pane-2' ? pane2Headings : pane1Headings);
  let activeEditorRef = $derived(tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef);

  let projectChapters = $derived(
    projectStore.files
      .filter(f => f.name.endsWith('.md') || f.name.endsWith('.txt'))
      .map(f => ({ fileName: f.name, filePath: f.path, wordCount: 0 }))
  );

  let paletteOpen = $state(false);
  let exportDialogOpen = $state(false);
  let projectSearchOpen = $state(false);

  // Recent projects cache for Cmd+Number switching (Notion-style)
  import type { RecentProject } from '$lib/ipc/commands';
  let recentProjects = $state<RecentProject[]>([]);

  // Dynamic window title
  $effect(() => {
    const tab = tabsStore.activeTab;
    const project = projectStore.name;
    let title = 'Novelist';
    if (tab) {
      title = `${tab.isDirty ? '● ' : ''}${tab.fileName} — ${project} — Novelist`;
    } else if (projectStore.isOpen) {
      title = `${project} — Novelist`;
    }
    getCurrentWindow().setTitle(title);
  });

  // Conflict dialog state
  let conflictFilePath = $state<string | null>(null);

  async function refreshRecentProjects() {
    const result = await commands.getRecentProjects();
    if (result.status === 'ok') recentProjects = result.data;
  }

  /**
   * Check for unsaved changes before switching project.
   * Returns true if safe to proceed, false if user cancelled.
   */
  async function confirmUnsavedChanges(): Promise<boolean> {
    const dirty = tabsStore.dirtyTabs;
    if (dirty.length === 0) return true;

    const names = dirty.map(t => t.fileName).join(', ');
    const choice = confirm(
      `You have unsaved changes in: ${names}\n\nClick "OK" to save, or "Cancel" to discard changes.`
    );
    if (choice) {
      await tabsStore.saveAllDirty();
    }
    return true;
  }

  async function openProjectFromPath(dirPath: string) {
    if (projectStore.isOpen) {
      const proceed = await confirmUnsavedChanges();
      if (!proceed) return;
    }
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

    // Refresh recent projects cache
    await refreshRecentProjects();
  }

  async function openNewWindow() {
    const label = `novelist-${Date.now()}`;
    const webview = new WebviewWindow(label, {
      title: 'Novelist',
      width: 1200,
      height: 800,
    });
    webview.once('tauri://error', (e) => {
      console.error('Failed to open new window:', e);
    });
  }

  async function handleOpenDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await openProjectFromPath(selected as string);
  }

  async function handleOpenRecent(path: string) {
    await openProjectFromPath(path);
  }

  async function handleNewFile() {
    if (!projectStore.dirPath) return;
    // Generate unique filename
    let name = 'untitled.md';
    let counter = 1;
    const existing = new Set(projectStore.files.map(f => f.name));
    while (existing.has(name)) {
      name = `untitled-${counter}.md`;
      counter++;
    }
    const result = await commands.createFile(projectStore.dirPath, name);
    if (result.status === 'ok') {
      // Refresh sidebar
      const filesResult = await commands.listDirectory(projectStore.dirPath!);
      if (filesResult.status === 'ok') projectStore.updateFiles(filesResult.data);
      // Open in editor
      const readResult = await commands.readFile(result.data);
      if (readResult.status === 'ok') {
        tabsStore.openTab(result.data, readResult.data);
        await commands.registerOpenFile(result.data);
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+Shift+N: new window
    if (mod && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      openNewWindow();
      return;
    }
    // Cmd+B: toggle sidebar
    if (mod && e.key === 'b') {
      e.preventDefault();
      uiStore.toggleSidebar();
      return;
    }
    // Cmd+Shift+O: toggle outline
    if (mod && e.shiftKey && e.key === 'O') {
      e.preventDefault();
      uiStore.toggleOutline();
      return;
    }
    // Cmd+Shift+D: toggle draft note
    if (mod && e.shiftKey && e.key === 'D') {
      e.preventDefault();
      uiStore.toggleDraft();
      return;
    }
    // F11 or Cmd+Shift+Z: zen mode
    if (e.key === 'F11' || (mod && e.shiftKey && e.key === 'Z')) {
      e.preventDefault();
      uiStore.toggleZen();
      return;
    }
    // Cmd+Shift+F: project search
    if (mod && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      projectSearchOpen = !projectSearchOpen;
      return;
    }
    // Cmd+Shift+P: command palette
    if (mod && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      paletteOpen = !paletteOpen;
      return;
    }
    // Escape: exit zen mode
    if (e.key === 'Escape' && uiStore.zenMode) {
      e.preventDefault();
      uiStore.toggleZen();
      return;
    }
    // Cmd+\: toggle split view
    if (mod && e.key === '\\') {
      e.preventDefault();
      tabsStore.toggleSplit();
      return;
    }
    // Cmd+N: new file
    if (mod && e.key === 'n') {
      e.preventDefault();
      handleNewFile();
      return;
    }
    // Cmd+P: export project
    if (mod && !e.shiftKey && e.key === 'p') {
      e.preventDefault();
      exportDialogOpen = true;
      return;
    }
    // Cmd+W: close tab
    if (mod && e.key === 'w') {
      e.preventDefault();
      const tab = tabsStore.activeTab;
      if (tab) tabsStore.closeTab(tab.id);
      return;
    }
    // Cmd+,: settings
    if (mod && e.key === ',') {
      e.preventDefault();
      uiStore.toggleSettings();
      return;
    }
    // Cmd+G: go to line
    if (mod && e.key === 'g') {
      e.preventDefault();
      handleGoToLine();
      return;
    }
    // Cmd+1~9: switch to recent project (Notion-style)
    if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (idx < recentProjects.length) {
        const target = recentProjects[idx];
        // Don't switch if already on this project
        if (target.path !== projectStore.dirPath) {
          e.preventDefault();
          openProjectFromPath(target.path);
        }
      }
      return;
    }
  }

  function handleMoveSection(sourceFrom: number, targetFrom: number) {
    const tabId = tabsStore.activeTab?.id;
    if (!tabId) return;
    const view = getEditorView(tabId);
    if (!view) return;
    moveSection(view, headings, sourceFrom, targetFrom);
  }

  function handleGoToLine() {
    const input = prompt('Go to line:');
    if (!input) return;
    const line = parseInt(input, 10);
    if (isNaN(line) || line < 1) return;
    const ref = tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef;
    ref?.jumpToAbsoluteLine(line);
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

  onMount(() => {
    // Load recent projects for Cmd+Number switching
    refreshRecentProjects();

    commandRegistry.register({ id: 'new-window', label: 'New Window', shortcut: 'Cmd+Shift+N', handler: () => openNewWindow() });
    commandRegistry.register({ id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: shortcutsStore.get('toggle-sidebar'), handler: () => uiStore.toggleSidebar() });
    commandRegistry.register({ id: 'toggle-outline', label: 'Toggle Outline', shortcut: shortcutsStore.get('toggle-outline'), handler: () => uiStore.toggleOutline() });
    commandRegistry.register({ id: 'toggle-zen', label: 'Toggle Zen Mode', shortcut: shortcutsStore.get('toggle-zen'), handler: () => uiStore.toggleZen() });
    commandRegistry.register({ id: 'toggle-draft', label: 'Toggle Draft Note', shortcut: shortcutsStore.get('toggle-draft'), handler: () => uiStore.toggleDraft() });
    commandRegistry.register({ id: 'toggle-stats', label: 'Toggle Writing Stats', handler: () => uiStore.toggleStats() });
    commandRegistry.register({ id: 'command-palette', label: 'Command Palette', shortcut: shortcutsStore.get('command-palette'), handler: () => { paletteOpen = !paletteOpen; } });
    commandRegistry.register({ id: 'project-search', label: 'Search in Project', shortcut: 'Cmd+Shift+F', handler: () => { projectSearchOpen = !projectSearchOpen; } });
    commandRegistry.register({ id: 'toggle-split', label: 'Toggle Split View', shortcut: shortcutsStore.get('toggle-split'), handler: () => tabsStore.toggleSplit() });
    commandRegistry.register({ id: 'new-file', label: 'New File', shortcut: shortcutsStore.get('new-file'), handler: () => handleNewFile() });
    commandRegistry.register({ id: 'export-project', label: 'Export Project', shortcut: shortcutsStore.get('export-project'), handler: () => { exportDialogOpen = true; } });
    commandRegistry.register({ id: 'close-tab', label: 'Close Tab', shortcut: shortcutsStore.get('close-tab'), handler: () => { const tab = tabsStore.activeTab; if (tab) tabsStore.closeTab(tab.id); } });
    commandRegistry.register({ id: 'open-settings', label: 'Open Settings', shortcut: shortcutsStore.get('open-settings'), handler: () => uiStore.toggleSettings() });
    commandRegistry.register({ id: 'go-to-line', label: 'Go to Line', shortcut: shortcutsStore.get('go-to-line'), handler: () => handleGoToLine() });
    commandRegistry.register({ id: 'run-benchmark', label: 'Run Performance Benchmark (150K lines)', handler: async () => {
      const { runBenchmark } = await import('$lib/utils/benchmark');
      const result = await runBenchmark(150000);
      alert(result);
    }});
    commandRegistry.register({ id: 'run-scroll-test', label: 'Run Scroll+Edit Stability Test', handler: async () => {
      const { runScrollEditTest } = await import('$lib/utils/scroll-edit-test');
      const result = await runScrollEditTest();
      alert(result);
    }});

    // Async event listeners — store refs for cleanup
    let unlistenFileChanged: (() => void) | null = null;
    let unlistenDragDrop: (() => void) | null = null;
    let unlistenCloseRequested: (() => void) | null = null;

    listen<{ path: string }>('file-changed', async (event) => {
      const { path } = event.payload;
      const tab = tabsStore.findByPath(path);
      if (!tab) return;

      if (!tab.isDirty) {
        const result = await commands.readFile(path);
        if (result.status === 'ok') {
          tabsStore.reloadContent(tab.id, result.data);
        }
      } else {
        conflictFilePath = path;
      }
    }).then(fn => { unlistenFileChanged = fn; });

    // Drag-and-drop: open .md/.markdown/.txt files dropped onto the window
    getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        const textExtensions = ['.md', '.markdown', '.txt'];
        for (const filePath of event.payload.paths) {
          const lower = filePath.toLowerCase();
          if (textExtensions.some(ext => lower.endsWith(ext))) {
            const result = await commands.readFile(filePath);
            if (result.status === 'ok') {
              tabsStore.openTab(filePath, result.data);
              await commands.registerOpenFile(filePath);
            }
          }
        }
      }
    }).then(fn => { unlistenDragDrop = fn; });

    // WebDAV auto-sync timer
    let syncIntervalId: ReturnType<typeof setInterval> | null = null;

    async function setupSyncTimer() {
      if (syncIntervalId) { clearInterval(syncIntervalId); syncIntervalId = null; }
      if (!projectStore.dirPath) return;
      try {
        const config = await invoke('get_sync_config', { projectDir: projectStore.dirPath }) as {
          enabled: boolean;
          interval_minutes: number;
        };
        if (config.enabled && config.interval_minutes > 0) {
          syncIntervalId = setInterval(async () => {
            if (!projectStore.dirPath) return;
            try {
              await invoke('sync_now', { projectDir: projectStore.dirPath });
            } catch (e) {
              console.error('Auto-sync failed:', e);
            }
          }, config.interval_minutes * 60 * 1000);
        }
      } catch (e) {
        // Sync not configured — that's fine
      }
    }

    // Set up sync timer for the current project
    setupSyncTimer();

    // Prevent window close when there are unsaved changes
    getCurrentWindow().onCloseRequested(async (event) => {
      const dirty = tabsStore.dirtyTabs;
      if (dirty.length === 0) return;

      const names = dirty.map(t => t.fileName).join(', ');
      const choice = confirm(
        `You have unsaved changes in: ${names}\n\nClick "OK" to save, or "Cancel" to discard changes.`
      );
      if (choice) {
        await tabsStore.saveAllDirty();
      }
    }).then(fn => { unlistenCloseRequested = fn; });

    // Sync on app close
    function handleBeforeUnload() {
      if (projectStore.dirPath) {
        // Fire-and-forget final sync — navigator.sendBeacon won't work for Tauri,
        // but invoke is still dispatched synchronously enough for beforeunload
        invoke('sync_now', { projectDir: projectStore.dirPath }).catch(() => {});
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);

    // Listen for goto-line events from ProjectSearch
    function handleGotoLine(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (detail?.line) {
        const ref = tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef;
        ref?.jumpToAbsoluteLine(detail.line);
      }
    }
    window.addEventListener('novelist-goto-line', handleGotoLine);

    return () => {
      unlistenFileChanged?.();
      unlistenDragDrop?.();
      unlistenCloseRequested?.();
      window.removeEventListener('novelist-goto-line', handleGotoLine);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (syncIntervalId) clearInterval(syncIntervalId);
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
        <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
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
      <div class="shrink-0" style="width: {uiStore.sidebarWidth}px; border-right: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
        <Sidebar onOpenProjectFromPath={openProjectFromPath} />
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
            border-right: {tabsStore.splitActive ? '1px solid var(--novelist-border-subtle, var(--novelist-border))' : 'none'};
            {tabsStore.splitActive && tabsStore.activePaneId === 'pane-1' ? 'box-shadow: inset 0 2px 0 0 var(--novelist-accent);' : ''}
          "
          onclick={() => tabsStore.setActivePane('pane-1')}
        >
          <TabBar paneId="pane-1" />

          <div class="flex-1 min-h-0 overflow-hidden">
            {#if tabsStore.getPaneActiveTab('pane-1')}
              <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
            {:else}
              <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                <div class="text-center">
                  <p style="font-size: 1.1rem; font-weight: 500; margin-bottom: 6px; color: var(--novelist-text-secondary);">Novelist</p>
                  <p style="font-size: 0.8rem;">Open a folder to get started</p>
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
            style="{tabsStore.activePaneId === 'pane-2' ? 'box-shadow: inset 0 2px 0 0 var(--novelist-accent);' : ''}"
            onclick={() => tabsStore.setActivePane('pane-2')}
          >
            <TabBar paneId="pane-2" />

            <div class="flex-1 min-h-0 overflow-hidden">
              {#if tabsStore.getPaneActiveTab('pane-2')}
                <ErrorBoundary><Editor paneId="pane-2" bind:wordCount={pane2WordCount} bind:cursorLine={pane2CursorLine} bind:cursorCol={pane2CursorCol} bind:headings={pane2Headings} bind:this={pane2EditorRef} /></ErrorBoundary>
              {:else}
                <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                  <div class="text-center">
                    <p style="font-size: 0.85rem;">Open a file in this pane</p>
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

    <!-- Right panels (Outline / Draft) + toggle tabs -->
    <div class="shrink-0 flex">
      <!-- Panel content -->
      {#if uiStore.outlineVisible}
        <div class="overflow-y-auto" style="width: 200px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <Outline {headings} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} onMoveSection={handleMoveSection} />
        </div>
      {/if}
      {#if uiStore.draftVisible && tabsStore.activeTab}
        <div style="width: 300px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <DraftNote filePath={tabsStore.activeTab.filePath} />
        </div>
      {/if}
      {#if uiStore.snapshotVisible}
        <div style="width: 280px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <SnapshotPanel />
        </div>
      {/if}
      {#if uiStore.statsVisible && projectStore.dirPath}
        <div style="width: 300px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <StatsPanel
            projectDir={projectStore.dirPath}
            chapters={projectChapters}
          />
        </div>
      {/if}
      <!-- Vertical toggle tabs -->
      <div class="flex flex-col" style="border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.outlineVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.outlineVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleOutline()}
          title="Toggle Outline (Cmd+Shift+O)"
        >
          OUTLINE
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.draftVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.draftVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleDraft()}
          title="Toggle Draft Note (Cmd+Shift+D)"
        >
          DRAFT
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.snapshotVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.snapshotVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleSnapshot()}
          title="Toggle Snapshots"
        >
          SNAPS
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.statsVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.statsVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleStats()}
          title="Toggle Writing Stats"
        >
          STATS
        </button>
      </div>
    </div>
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

{#if uiStore.settingsOpen}
  <Settings onClose={() => { uiStore.settingsOpen = false; }} />
{/if}

{#if projectSearchOpen}
  <ProjectSearch onClose={() => { projectSearchOpen = false; }} />
{/if}
