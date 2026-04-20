<script lang="ts">
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Editor from '$lib/components/Editor.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import ConflictDialog from '$lib/components/ConflictDialog.svelte';
  import Outline from '$lib/components/Outline.svelte';
  import ZenMode from '$lib/components/ZenMode.svelte';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import MoveFilePalette from '$lib/components/MoveFilePalette.svelte';
  import ExportDialog from '$lib/components/ExportDialog.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import DraftNote from '$lib/components/DraftNote.svelte';
  import SnapshotPanel from '$lib/components/SnapshotPanel.svelte';
  import StatsPanel from '$lib/components/StatsPanel.svelte';
  import TemplatePanel from '$lib/components/TemplatePanel.svelte';
  import type { TemplateFileSummary } from '$lib/ipc/commands';
  import ProjectSearch from '$lib/components/ProjectSearch.svelte';
  import NewProjectDialog from '$lib/components/NewProjectDialog.svelte';
  import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';
  import { extensionStore } from '$lib/stores/extensions.svelte';
  import PluginPanel from '$lib/components/PluginPanel.svelte';
  import PluginFileEditor from '$lib/components/PluginFileEditor.svelte';
  import CanvasFileEditor from '$lib/components/CanvasFileEditor.svelte';
  import KanbanFileEditor from '$lib/components/KanbanFileEditor.svelte';
  import MindmapOverlay from '$lib/components/MindmapOverlay.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { startupMark, startupReport } from '$lib/utils/startup-timing';
  import { moveSection } from '$lib/editor/section-move';
  import { createEditorContextMenu } from '$lib/composables/editor-context-menu.svelte';
  import * as fmt from '$lib/editor/formatting';
  import { makeResizeHandler } from '$lib/utils/resize-drag';
  import { handleTitlebarDrag } from '$lib/utils/window-drag';
  import { useWindowTitle } from '$lib/composables/window-title.svelte';
  import { promptGoToLine } from '$lib/utils/go-to-line';
  import { registerAppCommands } from '$lib/app-commands';
  import { wireAppEvents } from '$lib/composables/app-events.svelte';
  import { useAppLifecycle } from '$lib/composables/app-lifecycle.svelte';
  import { handleKeepMine, handleLoadTheirs } from '$lib/conflict-handlers';
  import { createKeydownHandler } from '$lib/composables/app-shortcuts.svelte';
  import { createCloseTab } from '$lib/composables/close-tab.svelte';
  import { createScratchFile, createNewFileInProject, executeTemplate, requestSaveCurrentAsTemplate } from '$lib/services/new-file';
  import { shortcutsStore, initShortcutsI18n, formatShortcut } from '$lib/stores/shortcuts.svelte';
  import { t } from '$lib/i18n';
  import type { HeadingItem } from '$lib/editor/outline';
  import type { EditorView } from '@codemirror/view';

  // Per-pane editor state for status bar & outline navigation
  let pane1WordCount = $state(0);
  let pane1CursorLine = $state(1);
  let pane1CursorCol = $state(1);
  let pane1Headings = $state<HeadingItem[]>([]);
  let pane1EditorRef = $state<{ scrollToPosition: (from: number) => void; jumpToAbsoluteLine: (line: number) => void; renameCurrentFile: () => void; saveCurrentFile: () => Promise<void> } | undefined>(undefined);

  let pane2WordCount = $state(0);
  let pane2CursorLine = $state(1);
  let pane2CursorCol = $state(1);
  let pane2Headings = $state<HeadingItem[]>([]);
  let pane2EditorRef = $state<{ scrollToPosition: (from: number) => void; jumpToAbsoluteLine: (line: number) => void; renameCurrentFile: () => void; saveCurrentFile: () => Promise<void> } | undefined>(undefined);

  // Status bar reflects active pane
  let wordCount = $derived(tabsStore.activePaneId === 'pane-2' ? pane2WordCount : pane1WordCount);
  let cursorLine = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorLine : pane1CursorLine);
  let cursorCol = $derived(tabsStore.activePaneId === 'pane-2' ? pane2CursorCol : pane1CursorCol);
  let headings = $derived(tabsStore.activePaneId === 'pane-2' ? pane2Headings : pane1Headings);
  let activeEditorRef = $derived(tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef);

  let projectChapters = $derived(
    projectStore.files
      .filter(f => /\.(md|txt|json|jsonl|csv)$/i.test(f.name))
      .map(f => ({ fileName: f.name, filePath: f.path, wordCount: 0 }))
  );

  let paletteOpen = $state(false);
  let movePaletteOpen = $state(false);
  let exportDialogOpen = $state(false);
  let mindmapOverlayOpen = $state(false);
  let projectSearchOpen = $state(false);
  let newProjectDialogOpen = $state(false);
  // Opening the template dialog from outside TemplatePanel (e.g. from the
  // command palette) — the panel consumes this object then calls back to clear.
  let templateDialogRequest = $state<{ id: string | null; prefill?: { name?: string; body?: string } } | null>(null);

  // Drag state flags — kept here so the template can bind cursor styles etc.
  let isDraggingSplit = $state(false);
  let isDraggingLeftSidebar = $state(false);
  let isDraggingRightPanel = $state(false);
  let splitContainerRef: HTMLDivElement | undefined = $state(undefined);

  const startSplitDrag = makeResizeHandler({
    shouldStart: () => tabsStore.splitActive,
    setDragging: (v) => { isDraggingSplit = v; },
    onMove: (ev) => {
      if (!splitContainerRef) return;
      const rect = splitContainerRef.getBoundingClientRect();
      uiStore.setSplitRatio((ev.clientX - rect.left) / rect.width);
    },
  });

  const startLeftSidebarDrag = makeResizeHandler({
    setDragging: (v) => { isDraggingLeftSidebar = v; },
    init: (e) => ({ x: e.clientX, w: uiStore.sidebarWidth }),
    onMove: (ev, s) => uiStore.setSidebarWidth(s.w + (ev.clientX - s.x)),
  });

  const startRightPanelDrag = makeResizeHandler({
    setDragging: (v) => { isDraggingRightPanel = v; },
    init: (e) => ({ x: e.clientX, w: uiStore.rightPanelWidth }),
    // Dragging left increases width (right panel grows leftward)
    onMove: (ev, s) => uiStore.setRightPanelWidth(s.w - (ev.clientX - s.x)),
  });

  let isDraggingAny = $derived(isDraggingSplit || isDraggingLeftSidebar || isDraggingRightPanel);

  // Whether any right panel content (not just toggle tabs) is visible
  let rightPanelContentVisible = $derived(
    uiStore.outlineVisible ||
    uiStore.draftVisible ||
    uiStore.snapshotVisible ||
    uiStore.statsVisible ||
    uiStore.templateVisible ||
    !!(extensionStore.activePanelId && tabsStore.activeTab)
  );

  // Recent projects cache for Cmd+Number switching (Notion-style)
  import type { RecentProject } from '$lib/ipc/commands';
  let recentProjects = $state<RecentProject[]>([]);
  let projectSwitcherTrigger = $state(0);

  useWindowTitle(t);

  // Conflict dialog state
  let conflictFilePath = $state<string | null>(null);

  async function refreshRecentProjects() {
    const result = await commands.getRecentProjects();
    if (result.status === 'ok') recentProjects = result.data;
  }

  /** Auto-save all dirty files before switching project. */
  async function autoSaveBeforeSwitch(): Promise<void> {
    const dirty = tabsStore.dirtyTabs;
    if (dirty.length === 0) return;
    await tabsStore.saveAllDirty();
  }

  async function openProjectFromPath(dirPath: string) {
    if (projectStore.isOpen) {
      await autoSaveBeforeSwitch();
    }
    projectStore.isLoading = true;
    await commands.stopFileWatcher();

    const configResult = await commands.detectProject(dirPath);
    const config = configResult.status === 'ok' ? configResult.data : null;

    // Load the per-project settings overlay BEFORE the initial listDirectory
    // so the user's saved `show_hidden_files` preference applies to the first
    // tree render. `projectStore.setProject` also kicks a load, but awaiting
    // here guarantees the preference is known before we fetch files.
    await settingsStore.load(dirPath);

    const filesResult = await commands.listDirectory(dirPath, settingsStore.effective.view.show_hidden_files);
    const files = filesResult.status === 'ok' ? filesResult.data : [];

    projectStore.setProject(dirPath, config, files);
    uiStore.sidebarVisible = true;
    tabsStore.closeAll();

    // Track as recent project (backend persistence for next launch)
    const name = config?.project?.name || dirPath.split('/').pop() || 'Untitled';
    await commands.addRecentProject(dirPath, name);

    // Keep Cmd+number mapping stable: only append truly new projects
    if (!recentProjects.some(p => p.path === dirPath)) {
      recentProjects = [...recentProjects, { path: dirPath, name, last_opened: String(Math.floor(Date.now() / 1000)), pinned: false, sort_order: null }];
    }

    // Start watching
    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') {
      console.error('Failed to start file watcher:', watchResult.error);
    }
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

  const handleNewScratchFile = () => createScratchFile();
  const handleNewFile = () => createNewFileInProject();
  const executeTemplateWrapper = (summary: TemplateFileSummary) => executeTemplate(summary, getActiveEditorView, t);
  function saveCurrentFileAsTemplate() {
    requestSaveCurrentAsTemplate(getActiveEditorView, t, (prefill) => {
      templateDialogRequest = { id: null, prefill };
    });
  }

  // Close-tab pipeline + guard against Cmd+W vs native onCloseRequested
  // double-firing. `closeTab.isClosing()` is read from useAppLifecycle below.
  const closeTab = createCloseTab();
  const handleCloseTab = closeTab.handleCloseTab;

  // --- Editor formatting helpers ---
  function getActiveEditorView(): EditorView | null {
    const tabId = tabsStore.activeTab?.id;
    if (!tabId) return null;
    return getEditorView(tabId) ?? null;
  }

  // --- Editor context menu (right-click inside .cm-content) ---
  const editorCtx = createEditorContextMenu(getActiveEditorView);
  // Read-alias so markup expressions like `editorCtxMenu.x` stay byte-identical.
  // Writes (oncontextmenu handler below) go through `editorCtx.state = ...`.
  const editorCtxMenu = $derived(editorCtx.state);
  const closeEditorCtxMenu = () => editorCtx.close();
  const editorCtxCut = () => editorCtx.cut();
  const editorCtxCopy = () => editorCtx.copy();
  const editorCtxPaste = () => editorCtx.paste();
  const editorCtxSelectAll = () => editorCtx.selectAll();
  const editorCtxRunCommand = (id: string) => editorCtx.runCommand(id);

  function wrapSelection(before: string, after: string) {
    const view = getActiveEditorView();
    if (view) fmt.wrapSelection(view, before, after);
  }
  function toggleWrap(marker: string) {
    const view = getActiveEditorView();
    if (view) fmt.toggleWrap(view, marker);
  }
  function toggleLinePrefix(prefix: string) {
    const view = getActiveEditorView();
    if (view) fmt.toggleLinePrefix(view, prefix);
  }

  const handleKeydown = createKeydownHandler({
    openNewWindow: () => openNewWindow(),
    saveActiveFile: () => { void activeEditorRef?.saveCurrentFile(); },
    toggleProjectSearch: () => { projectSearchOpen = !projectSearchOpen; },
    getRecentProjects: () => recentProjects,
    openProjectFromPath: (path) => { void openProjectFromPath(path); },
  });

  function handleMoveSection(sourceFrom: number, targetFrom: number) {
    const tabId = tabsStore.activeTab?.id;
    if (!tabId) return;
    const view = getEditorView(tabId);
    if (!view) return;
    moveSection(view, headings, sourceFrom, targetFrom);
  }

  function handleGoToLine() {
    const ref = tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef;
    promptGoToLine(t('gotoline.prompt'), (line) => ref?.jumpToAbsoluteLine(line));
  }

  onMount(() => {
    startupMark('frontend.app.onMount.begin');
    // Wire up i18n for shortcuts store (needs Svelte compile context)
    initShortcutsI18n(t);
    // Kick off global settings load so reactive consumers see real values
    // as soon as IPC answers. Safe if no project is open — falls back to
    // ~/.novelist/settings.json defaults.
    void settingsStore.load(null);

    // Expose test API when running in browser-mode E2E tests
    if ((window as any).__TAURI_MOCK_STATE__) {
      (window as any).__test_api__ = {
        toggleSidebar: () => uiStore.toggleSidebar(),
        toggleZen: () => uiStore.toggleZen(),
        toggleSplit: () => tabsStore.toggleSplit(),
        toggleSettings: () => uiStore.toggleSettings(),
        save: () => activeEditorRef?.saveCurrentFile(),
        newFile: () => { projectStore.dirPath ? handleNewFile() : handleNewScratchFile(); },
      };
    }

    // Load recent projects for Cmd+Number switching
    refreshRecentProjects();

    // Load UI extensions from installed plugins
    extensionStore.loadFromPlugins();

    registerAppCommands({
      t,
      getActiveEditorView,
      renameCurrentFile: () => activeEditorRef?.renameCurrentFile(),
      openNewWindow,
      handleNewFile,
      handleNewScratchFile,
      handleOpenDirectory,
      handleCloseTab,
      handleGoToLine,
      saveCurrentFileAsTemplate,
      togglePalette: () => { paletteOpen = !paletteOpen; },
      openMovePalette: () => { movePaletteOpen = true; },
      toggleProjectSearch: () => { projectSearchOpen = !projectSearchOpen; },
      openExportDialog: () => { exportDialogOpen = true; },
      openNewProjectDialog: () => { newProjectDialogOpen = true; },
      toggleMindmapOverlay: () => { mindmapOverlayOpen = !mindmapOverlayOpen; },
      requestProjectSwitcher: () => { uiStore.sidebarVisible = true; projectSwitcherTrigger++; },
    });

    // Check for updates silently after startup (5s delay to not block UI)
    setTimeout(async () => {
      const { checkForUpdates } = await import('$lib/updater');
      checkForUpdates(true);
    }, 5000);

    // Async event listeners — consolidated in $lib/composables/app-events.
    const unlistenAppEvents = wireAppEvents({
      onConflict: (path) => { conflictFilePath = path; },
      onRecentProjectsUpdated: (list) => { recentProjects = list; },
      onGotoLine: (line) => {
        const ref = tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef;
        ref?.jumpToAbsoluteLine(line);
      },
    });

    const unlistenLifecycle = useAppLifecycle({
      t,
      isClosingTab: () => closeTab.isClosing(),
    });

    startupMark('frontend.app.onMount.end');
    // Wait one frame so "first-paint" reflects the actual paint after mount.
    requestAnimationFrame(() => {
      startupMark('frontend.app.first-paint');
      void startupReport();
    });

    return () => {
      unlistenAppEvents();
      unlistenLifecycle();
    };
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (editorCtxMenu && e.key === 'Escape') { closeEditorCtxMenu(); e.preventDefault(); return; }
    handleKeydown(e);
  }}
  onmousedown={handleTitlebarDrag}
  onclick={closeEditorCtxMenu}
  oncontextmenu={(e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) { e.preventDefault(); return; }
    // Inside the editor: show a styled custom menu (matches the app theme)
    // instead of the native WKWebView one.
    if (target.closest('.cm-content')) {
      e.preventDefault();
      const view = getActiveEditorView();
      if (!view) { editorCtx.state = null; return; }
      const { from, to } = view.state.selection.main;
      const scaleMatch = document.documentElement.style.transform.match(/scale\(([^)]+)\)/);
      const zoom = scaleMatch ? parseFloat(scaleMatch[1]) || 1 : 1;
      editorCtx.state = {
        x: e.clientX / zoom,
        y: e.clientY / zoom,
        hasSelection: from !== to,
        from,
        to,
      };
      return;
    }
    // Other editable surfaces (inputs, textareas, contenteditable widgets)
    // keep their native context menu for OS text-editing affordances.
    const editable = target.closest('input, textarea, [contenteditable="true"]') !== null;
    if (!editable) e.preventDefault();
  }}
/>

{#if editorCtxMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="context-menu"
    data-testid="editor-context-menu"
    style="left: {editorCtxMenu.x}px; top: {editorCtxMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if editorCtxMenu.hasSelection}
      <button role="menuitem" class="context-menu-item" data-testid="editor-ctx-cut" onclick={() => { editorCtxCut(); closeEditorCtxMenu(); }}>{t('editor.menu.cut')}</button>
      <button role="menuitem" class="context-menu-item" data-testid="editor-ctx-copy" onclick={() => { editorCtxCopy(); closeEditorCtxMenu(); }}>{t('editor.menu.copy')}</button>
      <div class="context-menu-separator"></div>
      <button role="menuitem" class="context-menu-item" onclick={() => { editorCtxRunCommand('copy-rich-text'); closeEditorCtxMenu(); }}>{t('command.copyRichText')}</button>
      <button role="menuitem" class="context-menu-item" onclick={() => { editorCtxRunCommand('copy-plain-text'); closeEditorCtxMenu(); }}>{t('command.copyPlainText')}</button>
      <div class="context-menu-separator"></div>
    {/if}
    <button role="menuitem" class="context-menu-item" data-testid="editor-ctx-paste" onclick={() => { editorCtxPaste(); closeEditorCtxMenu(); }}>{t('editor.menu.paste')}</button>
    <div class="context-menu-separator"></div>
    <button role="menuitem" class="context-menu-item" data-testid="editor-ctx-select-all" onclick={() => { editorCtxSelectAll(); closeEditorCtxMenu(); }}>{t('editor.menu.selectAll')}</button>
  </div>
{/if}

{#if !projectStore.isOpen}
  <Welcome onOpenDirectory={handleOpenDirectory} onOpenRecent={handleOpenRecent} onNewFile={handleNewScratchFile} onNewProject={() => { newProjectDialogOpen = true; }} />
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
  <div data-testid="app-layout" class="flex h-full w-full" style="{isDraggingAny ? 'cursor: col-resize; user-select: none;' : ''}">
    {#if uiStore.sidebarVisible}
      <div data-testid="sidebar-region" class="shrink-0" style="width: {uiStore.sidebarWidth}px;">
        <Sidebar
          onOpenProjectFromPath={openProjectFromPath}
          {recentProjects}
          onRemoveRecentProject={(path) => { recentProjects = recentProjects.filter(p => p.path !== path); }}
          onRefreshRecentProjects={refreshRecentProjects}
          openSwitcherTrigger={projectSwitcherTrigger}
        />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="panel-resize-handle" onmousedown={startLeftSidebarDrag}></div>
    {/if}

    <!-- Main editor column (contains split panes + status bar) -->
    <div data-testid="editor-region" class="flex flex-col flex-1 min-w-0">
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
              {@const fileName1 = tabsStore.getPaneActiveTab('pane-1')?.fileName ?? ''}
              {@const lower1 = fileName1.toLowerCase()}
              {#if lower1.endsWith('.canvas')}
                <ErrorBoundary><CanvasFileEditor paneId="pane-1" /></ErrorBoundary>
              {:else if lower1.endsWith('.kanban')}
                <ErrorBoundary><KanbanFileEditor paneId="pane-1" /></ErrorBoundary>
              {:else}
                {@const fileHandler1 = extensionStore.getFileHandler(fileName1)}
                {#if fileHandler1}
                  <ErrorBoundary><PluginFileEditor extension={fileHandler1} paneId="pane-1" /></ErrorBoundary>
                {:else}
                  <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
                {/if}
              {/if}
            {:else}
              <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                <div class="text-center">
                  <p style="font-size: 1.3rem; font-weight: 500; margin-bottom: 6px; color: var(--novelist-text-secondary);">{t('app.name')}</p>
                  <p style="font-size: 0.95rem;">{t('app.openFolder')}</p>
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
                {@const fileName2 = tabsStore.getPaneActiveTab('pane-2')?.fileName ?? ''}
                {@const lower2 = fileName2.toLowerCase()}
                {#if lower2.endsWith('.canvas')}
                  <ErrorBoundary><CanvasFileEditor paneId="pane-2" /></ErrorBoundary>
                {:else if lower2.endsWith('.kanban')}
                  <ErrorBoundary><KanbanFileEditor paneId="pane-2" /></ErrorBoundary>
                {:else}
                  {@const fileHandler2 = extensionStore.getFileHandler(fileName2)}
                  {#if fileHandler2}
                    <ErrorBoundary><PluginFileEditor extension={fileHandler2} paneId="pane-2" /></ErrorBoundary>
                  {:else}
                    <ErrorBoundary><Editor paneId="pane-2" bind:wordCount={pane2WordCount} bind:cursorLine={pane2CursorLine} bind:cursorCol={pane2CursorCol} bind:headings={pane2Headings} bind:this={pane2EditorRef} /></ErrorBoundary>
                  {/if}
                {/if}
              {:else}
                <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                  <div class="text-center">
                    <p style="font-size: 0.95rem;">{t('app.openFile')}</p>
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
      <!-- Resize handle for right panel -->
      {#if rightPanelContentVisible}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="panel-resize-handle" onmousedown={startRightPanelDrag}></div>
      {/if}
      <!-- Panel content -->
      {#if uiStore.outlineVisible}
        <div class="overflow-y-auto" style="width: {uiStore.rightPanelWidth}px;">
          <Outline {headings} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} onMoveSection={handleMoveSection} />
        </div>
      {/if}
      {#if uiStore.draftVisible && tabsStore.activeTab}
        <div style="width: {uiStore.rightPanelWidth}px;">
          <DraftNote filePath={tabsStore.activeTab.filePath} />
        </div>
      {:else if uiStore.snapshotVisible}
        <div style="width: {uiStore.rightPanelWidth}px;">
          <SnapshotPanel />
        </div>
      {:else if uiStore.statsVisible && projectStore.dirPath}
        <div style="width: {uiStore.rightPanelWidth}px;">
          <StatsPanel
            projectDir={projectStore.dirPath}
            chapters={projectChapters}
          />
        </div>
      {:else if uiStore.templateVisible}
        <div style="width: {uiStore.rightPanelWidth}px;">
          <TemplatePanel
            onExecute={executeTemplateWrapper}
            openDialogRequest={templateDialogRequest}
            onDialogHandled={() => { templateDialogRequest = null; }}
          />
        </div>
      {:else if extensionStore.activePanelId && tabsStore.activeTab}
        {@const activePanel = extensionStore.panels.find(p => p.pluginId === extensionStore.activePanelId)}
        {#if activePanel}
          <div style="width: {uiStore.rightPanelWidth}px;">
            <PluginPanel extension={activePanel} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} />
          </div>
        {/if}
      {/if}
      <!-- Vertical toggle tabs -->
      <div class="flex flex-col" style="border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.outlineVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.outlineVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleOutline()}
          title="{t('command.toggleOutline')} ({formatShortcut(shortcutsStore.get('toggle-outline'))})"
        >
          {t('outline.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.draftVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.draftVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleDraft()}
          title="{t('command.toggleDraft')} ({formatShortcut(shortcutsStore.get('toggle-draft'))})"
        >
          {t('draft.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.snapshotVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.snapshotVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleSnapshot()}
          title="{t('command.toggleSnapshot')} ({formatShortcut(shortcutsStore.get('toggle-snapshot'))})"
        >
          {t('snapshot.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          style="width: 20px; flex: 1; background: {uiStore.statsVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.statsVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleStats()}
          title="{t('command.toggleStats')} ({formatShortcut(shortcutsStore.get('toggle-stats'))})"
        >
          {t('stats.title')}
        </button>
        <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
        <button
          class="flex items-center justify-center cursor-pointer"
          data-testid="toggle-template"
          style="width: 20px; flex: 1; background: {uiStore.templateVisible ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {uiStore.templateVisible ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
          onclick={() => uiStore.toggleTemplate()}
          title="{t('command.toggleTemplate')} ({formatShortcut(shortcutsStore.get('toggle-template'))})"
        >
          {t('template.title')}
        </button>
        {#each extensionStore.panels.filter(p => p.pluginId !== 'mindmap') as panel}
          <div style="height: 1px; background: var(--novelist-border-subtle, var(--novelist-border));"></div>
          <button
            class="flex items-center justify-center cursor-pointer"
            style="width: 20px; flex: 1; background: {extensionStore.activePanelId === panel.pluginId ? 'color-mix(in srgb, var(--novelist-accent) 10%, transparent)' : 'transparent'}; color: {extensionStore.activePanelId === panel.pluginId ? 'var(--novelist-accent)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'}; border: none; writing-mode: vertical-rl; font-size: 9px; letter-spacing: 0.08em; user-select: none; transition: color 100ms, background 100ms;"
            onclick={() => extensionStore.togglePanel(panel.pluginId)}
            title="Toggle {panel.label}"
          >
            {panel.label}
          </button>
        {/each}
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

{#if movePaletteOpen}
  <MoveFilePalette onClose={() => {
    movePaletteOpen = false;
    // Return focus to the editor on the next frame so typing resumes without
    // a manual click. rAF waits for the palette's input to unmount first.
    const tabId = tabsStore.activeTab?.id;
    if (tabId) requestAnimationFrame(() => getEditorView(tabId)?.focus());
  }} />
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

{#if mindmapOverlayOpen}
  {@const activeTab = tabsStore.activeTab}
  {@const view = activeTab ? getEditorView(activeTab.id) : undefined}
  {@const mdContent = view?.state.doc.toString() ?? activeTab?.content ?? ''}
  <MindmapOverlay content={mdContent} onClose={() => { mindmapOverlayOpen = false; }} />
{/if}

{#if newProjectDialogOpen}
  <NewProjectDialog
    onClose={() => { newProjectDialogOpen = false; }}
    onProjectCreated={(path) => openProjectFromPath(path)}
  />
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

  .panel-resize-handle {
    flex-shrink: 0;
    width: 4px;
    cursor: col-resize;
    background: var(--novelist-border-subtle, var(--novelist-border));
    transition: background 150ms;
  }
  .panel-resize-handle:hover {
    background: var(--novelist-accent);
  }
</style>
