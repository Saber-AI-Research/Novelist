<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { open, ask } from '@tauri-apps/plugin-dialog';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import CanvasEditor from '$lib/components/CanvasEditor.svelte';
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
  import MindmapPanel from '$lib/components/MindmapPanel.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { moveSection } from '$lib/editor/section-move';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import { shortcutsStore, matchesShortcut, initShortcutsI18n } from '$lib/stores/shortcuts.svelte';
  import { t } from '$lib/i18n';
  import type { HeadingItem } from '$lib/editor/outline';
  import { EditorView } from '@codemirror/view';

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

  // Split divider drag state
  let isDraggingSplit = $state(false);
  let splitContainerRef: HTMLDivElement | undefined = $state(undefined);

  function startSplitDrag(e: MouseEvent) {
    if (!tabsStore.splitActive) return;
    e.preventDefault();
    isDraggingSplit = true;

    const onMove = (ev: MouseEvent) => {
      if (!splitContainerRef) return;
      const rect = splitContainerRef.getBoundingClientRect();
      const ratio = (ev.clientX - rect.left) / rect.width;
      uiStore.setSplitRatio(ratio);
    };
    const onUp = () => {
      isDraggingSplit = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Recent projects cache for Cmd+Number switching (Notion-style)
  import type { RecentProject } from '$lib/ipc/commands';
  let recentProjects = $state<RecentProject[]>([]);

  // Dynamic window title
  $effect(() => {
    const tab = tabsStore.activeTab;
    const project = projectStore.name;
    let title = t('app.name');
    if (tab) {
      title = `${tab.isDirty ? '● ' : ''}${tab.fileName} — ${project} — ${t('app.name')}`;
    } else if (projectStore.isOpen) {
      title = `${project} — ${t('app.name')}`;
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
    const choice = confirm(t('dialog.unsavedInFiles', { names }));
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
      titleBarStyle: 'overlay',
      hiddenTitle: true,
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

  function handleDragMouseDown(e: MouseEvent) {
    const target = e.target as HTMLElement;
    // Don't interfere with interactive elements or the editor
    if (target.closest('button, input, a, [role="button"], select, textarea, .cm-editor, [contenteditable]')) return;
    // Initiate drag if click is on a drag region or in the top titlebar area
    const TITLEBAR_HEIGHT = 38;
    if (target.closest('[data-tauri-drag-region]') || e.clientY <= TITLEBAR_HEIGHT) {
      e.preventDefault();
      getCurrentWindow().startDragging();
    }
  }

  // --- Editor formatting helpers ---
  function getActiveEditorView(): EditorView | null {
    const tabId = tabsStore.activeTab?.id;
    if (!tabId) return null;
    return getEditorView(tabId) ?? null;
  }

  function wrapSelection(before: string, after: string) {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selectedText = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: before + selectedText + after },
      selection: { anchor: from + before.length, head: to + before.length },
    });
  }

  function toggleLinePrefix(prefix: string) {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const text = line.text;
    if (text.startsWith(prefix + ' ')) {
      // Remove prefix
      view.dispatch({
        changes: { from: line.from, to: line.from + prefix.length + 1, insert: '' },
        selection: { anchor: from - (prefix.length + 1), head: Math.max(line.from, to - (prefix.length + 1)) },
      });
    } else {
      // Add prefix (strip existing # prefix if present)
      const existingMatch = text.match(/^(#{1,6})\s*/);
      const removeLen = existingMatch ? existingMatch[0].length : 0;
      view.dispatch({
        changes: { from: line.from, to: line.from + removeLen, insert: prefix + ' ' },
        selection: { anchor: from + (prefix.length + 1 - removeLen), head: Math.max(line.from, to + (prefix.length + 1 - removeLen)) },
      });
    }
  }

  // Map of customizable commandId → handler
  const shortcutHandlers: Record<string, () => void> = {
    'toggle-sidebar': () => uiStore.toggleSidebar(),
    'toggle-outline': () => uiStore.toggleOutline(),
    'toggle-draft': () => uiStore.toggleDraft(),
    'toggle-snapshot': () => uiStore.toggleSnapshot(),
    'toggle-stats': () => uiStore.toggleStats(),
    'toggle-mindmap': () => uiStore.toggleMindmap(),
    'toggle-zen': () => uiStore.toggleZen(),
    'command-palette': () => { paletteOpen = !paletteOpen; },
    'toggle-split': () => tabsStore.toggleSplit(),
    'new-file': () => handleNewFile(),
    'export-project': () => { exportDialogOpen = true; },
    'close-tab': () => { const tab = tabsStore.activeTab; if (tab) tabsStore.closeTab(tab.id); },
    'open-settings': () => uiStore.toggleSettings(),
    'go-to-line': () => handleGoToLine(),

    // Editor formatting
    'editor-bold': () => wrapSelection('**', '**'),
    'editor-italic': () => wrapSelection('*', '*'),
    'editor-link': () => wrapSelection('[', '](url)'),
    'editor-heading': () => toggleLinePrefix('#'),
    'editor-code-inline': () => wrapSelection('`', '`'),
    'editor-strikethrough': () => wrapSelection('~~', '~~'),
  };

  function handleKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    // Non-customizable shortcuts: new window, zoom, project switch, escape

    // Cmd+Shift+N: new window (non-customizable)
    if (mod && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      openNewWindow();
      return;
    }

    // Cmd+Shift+F: project search (non-customizable)
    if (mod && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      projectSearchOpen = !projectSearchOpen;
      return;
    }

    // Escape: exit zen mode (non-customizable)
    if (e.key === 'Escape' && uiStore.zenMode) {
      e.preventDefault();
      uiStore.toggleZen();
      return;
    }

    // Zoom (non-customizable)
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      uiStore.zoomIn();
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      uiStore.zoomOut();
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      uiStore.resetZoom();
      return;
    }

    // Cmd+1~9: switch to recent project (non-customizable)
    if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (idx < recentProjects.length) {
        const target = recentProjects[idx];
        if (target.path !== projectStore.dirPath) {
          e.preventDefault();
          openProjectFromPath(target.path);
        }
      }
      return;
    }

    // Customizable shortcuts — match against shortcutsStore
    for (const cmdId of shortcutsStore.allCommandIds) {
      const shortcut = shortcutsStore.get(cmdId);
      if (shortcut && matchesShortcut(e, shortcut)) {
        e.preventDefault();
        shortcutHandlers[cmdId]?.();
        return;
      }
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
    const input = prompt(t('gotoline.prompt'));
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
    // Wire up i18n for shortcuts store (needs Svelte compile context)
    initShortcutsI18n(t);

    // Load recent projects for Cmd+Number switching
    refreshRecentProjects();

    commandRegistry.register({ id: 'new-window', label: t('command.newWindow'), shortcut: 'Cmd+Shift+N', handler: () => openNewWindow() });
    commandRegistry.register({ id: 'toggle-sidebar', label: t('command.toggleSidebar'), shortcut: shortcutsStore.get('toggle-sidebar'), handler: () => uiStore.toggleSidebar() });
    commandRegistry.register({ id: 'toggle-outline', label: t('command.toggleOutline'), shortcut: shortcutsStore.get('toggle-outline'), handler: () => uiStore.toggleOutline() });
    commandRegistry.register({ id: 'toggle-zen', label: t('command.toggleZen'), shortcut: shortcutsStore.get('toggle-zen'), handler: () => uiStore.toggleZen() });
    commandRegistry.register({ id: 'toggle-draft', label: t('command.toggleDraft'), shortcut: shortcutsStore.get('toggle-draft'), handler: () => uiStore.toggleDraft() });
    commandRegistry.register({ id: 'toggle-snapshot', label: t('command.toggleSnapshot'), shortcut: shortcutsStore.get('toggle-snapshot'), handler: () => uiStore.toggleSnapshot() });
    commandRegistry.register({ id: 'toggle-stats', label: t('command.toggleStats'), shortcut: shortcutsStore.get('toggle-stats'), handler: () => uiStore.toggleStats() });
    commandRegistry.register({ id: 'toggle-mindmap', label: t('command.toggleMindmap'), shortcut: shortcutsStore.get('toggle-mindmap'), handler: () => uiStore.toggleMindmap() });
    commandRegistry.register({ id: 'command-palette', label: t('command.commandPalette'), shortcut: shortcutsStore.get('command-palette'), handler: () => { paletteOpen = !paletteOpen; } });
    commandRegistry.register({ id: 'project-search', label: t('command.projectSearch'), shortcut: 'Cmd+Shift+F', handler: () => { projectSearchOpen = !projectSearchOpen; } });
    commandRegistry.register({ id: 'toggle-split', label: t('command.toggleSplit'), shortcut: shortcutsStore.get('toggle-split'), handler: () => tabsStore.toggleSplit() });
    commandRegistry.register({ id: 'new-file', label: t('command.newFile'), shortcut: shortcutsStore.get('new-file'), handler: () => handleNewFile() });
    commandRegistry.register({ id: 'export-project', label: t('command.exportProject'), shortcut: shortcutsStore.get('export-project'), handler: () => { exportDialogOpen = true; } });
    commandRegistry.register({ id: 'close-tab', label: t('command.closeTab'), shortcut: shortcutsStore.get('close-tab'), handler: () => { const tab = tabsStore.activeTab; if (tab) tabsStore.closeTab(tab.id); } });
    commandRegistry.register({ id: 'open-settings', label: t('command.openSettings'), shortcut: shortcutsStore.get('open-settings'), handler: () => uiStore.toggleSettings() });
    commandRegistry.register({ id: 'go-to-line', label: t('command.goToLine'), shortcut: shortcutsStore.get('go-to-line'), handler: () => handleGoToLine() });
    // Editor formatting commands
    commandRegistry.register({ id: 'editor-bold', label: t('command.bold'), shortcut: shortcutsStore.get('editor-bold'), handler: () => wrapSelection('**', '**') });
    commandRegistry.register({ id: 'editor-italic', label: t('command.italic'), shortcut: shortcutsStore.get('editor-italic'), handler: () => wrapSelection('*', '*') });
    commandRegistry.register({ id: 'editor-link', label: t('command.insertLink'), shortcut: shortcutsStore.get('editor-link'), handler: () => wrapSelection('[', '](url)') });
    commandRegistry.register({ id: 'editor-heading', label: t('command.toggleHeading'), shortcut: shortcutsStore.get('editor-heading'), handler: () => toggleLinePrefix('#') });
    commandRegistry.register({ id: 'editor-code-inline', label: t('command.inlineCode'), shortcut: shortcutsStore.get('editor-code-inline'), handler: () => wrapSelection('`', '`') });
    commandRegistry.register({ id: 'editor-strikethrough', label: t('command.strikethrough'), shortcut: shortcutsStore.get('editor-strikethrough'), handler: () => wrapSelection('~~', '~~') });
    commandRegistry.register({ id: 'run-benchmark', label: t('command.runBenchmark'), handler: async () => {
      const { runBenchmark } = await import('$lib/utils/benchmark');
      const result = await runBenchmark(150000);
      alert(result);
    }});
    commandRegistry.register({ id: 'run-scroll-test', label: t('command.runScrollTest'), handler: async () => {
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

    // Cmd+W on macOS triggers window close via native menu.
    // Convert it to "close active tab" when tabs are open.
    // Only actually close the window when no tabs remain.
    getCurrentWindow().onCloseRequested(async (event) => {
      // If there's an active tab, close it instead of the window
      const activeTab = tabsStore.activeTab;
      if (activeTab) {
        event.preventDefault();
        await tabsStore.closeTab(activeTab.id);
        return;
      }

      // No open tabs — check for dirty tabs in other panes before closing window
      const dirty = tabsStore.dirtyTabs;
      if (dirty.length > 0) {
        event.preventDefault();
        const names = dirty.map(t => t.fileName).join(', ');
        const shouldSave = await ask(
          t('dialog.unsavedBeforeClose', { names }),
          { title: t('dialog.unsavedChanges'), kind: 'warning', okLabel: t('dialog.save'), cancelLabel: t('dialog.dontSave') }
        );
        if (shouldSave) {
          await tabsStore.saveAllDirty();
        }
        // Now actually close the window
        await getCurrentWindow().close();
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

<svelte:window onkeydown={handleKeydown} onmousedown={handleDragMouseDown} />

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
            <p class="text-lg mb-2">{t('app.name')}</p>
            <p class="text-sm">{t('app.openFolder')}</p>
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
      <div class="flex flex-1 min-h-0" bind:this={splitContainerRef} style="{isDraggingSplit ? 'cursor: col-resize; user-select: none;' : ''}">

        <!-- Pane 1 -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="flex flex-col min-w-0"
          style="
            flex: {tabsStore.splitActive ? `0 0 ${uiStore.splitRatio * 100}%` : '1 1 0%'};
            {tabsStore.splitActive && tabsStore.activePaneId === 'pane-1' ? 'box-shadow: inset 0 2px 0 0 var(--novelist-accent);' : ''}
          "
          onclick={() => tabsStore.setActivePane('pane-1')}
        >
          <TabBar paneId="pane-1" />

          <div class="flex-1 min-h-0 overflow-hidden">
            {#if tabsStore.getPaneActiveTab('pane-1')}
              {#if tabsStore.getPaneActiveTab('pane-1')?.fileName.endsWith('.canvas')}
                <ErrorBoundary><CanvasEditor paneId="pane-1" /></ErrorBoundary>
              {:else}
                <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
              {/if}
            {:else}
              <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                <div class="text-center">
                  <p style="font-size: 1.1rem; font-weight: 500; margin-bottom: 6px; color: var(--novelist-text-secondary);">{t('app.name')}</p>
                  <p style="font-size: 0.8rem;">{t('app.openFolder')}</p>
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- Resizable split divider -->
        {#if tabsStore.splitActive}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="split-divider"
            onmousedown={startSplitDrag}
          ></div>
        {/if}

        <!-- Pane 2 (shown when split is active) -->
        {#if tabsStore.splitActive}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="flex flex-col min-w-0"
            style="flex: 0 0 {(1 - uiStore.splitRatio) * 100}%; {tabsStore.activePaneId === 'pane-2' ? 'box-shadow: inset 0 2px 0 0 var(--novelist-accent);' : ''}"
            onclick={() => tabsStore.setActivePane('pane-2')}
          >
            <TabBar paneId="pane-2" />

            <div class="flex-1 min-h-0 overflow-hidden">
              {#if tabsStore.getPaneActiveTab('pane-2')}
                {#if tabsStore.getPaneActiveTab('pane-2')?.fileName.endsWith('.canvas')}
                  <ErrorBoundary><CanvasEditor paneId="pane-2" /></ErrorBoundary>
                {:else}
                  <ErrorBoundary><Editor paneId="pane-2" bind:wordCount={pane2WordCount} bind:cursorLine={pane2CursorLine} bind:cursorCol={pane2CursorCol} bind:headings={pane2Headings} bind:this={pane2EditorRef} /></ErrorBoundary>
                {/if}
              {:else}
                <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                  <div class="text-center">
                    <p style="font-size: 0.85rem;">{t('app.openFile')}</p>
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

    <!-- Right panels (Outline + one of Draft/Snapshot/Stats) + toggle tabs -->
    <div class="shrink-0 flex">
      <!-- Panel content -->
      {#if uiStore.outlineVisible}
        <div class="overflow-y-auto" style="width: 280px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <Outline {headings} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} onMoveSection={handleMoveSection} />
        </div>
      {/if}
      {#if uiStore.draftVisible && tabsStore.activeTab}
        <div style="width: 280px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <DraftNote filePath={tabsStore.activeTab.filePath} />
        </div>
      {:else if uiStore.snapshotVisible}
        <div style="width: 280px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <SnapshotPanel />
        </div>
      {:else if uiStore.statsVisible && projectStore.dirPath}
        <div style="width: 280px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <StatsPanel
            projectDir={projectStore.dirPath}
            chapters={projectChapters}
          />
        </div>
      {:else if uiStore.mindmapVisible && tabsStore.activeTab}
        <div style="width: 400px; border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <MindmapPanel onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} />
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
          {t('outline.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.draftVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.draftVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleDraft()}
          title="Toggle Draft Note (Cmd+Shift+D)"
        >
          {t('draft.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.snapshotVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.snapshotVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleSnapshot()}
          title="Toggle Snapshots (Cmd+Shift+S)"
        >
          {t('snapshot.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.statsVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.statsVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleStats()}
          title="Toggle Writing Stats (Cmd+Shift+T)"
        >
          {t('stats.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.mindmapVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.mindmapVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleMindmap()}
          title="Toggle Mindmap (Cmd+Shift+M)"
        >
          {t('mindmap.title')}
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

<style>
  .split-divider {
    flex-shrink: 0;
    width: 5px;
    cursor: col-resize;
    background: var(--novelist-border-subtle, var(--novelist-border));
    transition: background 150ms;
  }
  .split-divider:hover {
    background: var(--novelist-accent);
  }
</style>
