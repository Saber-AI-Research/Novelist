<script lang="ts">
  import { onMount } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  // First-paint critical shell: keep these static.
  import Sidebar from '$lib/components/Sidebar.svelte';
  import TabBar from '$lib/components/TabBar.svelte';
  import StatusBar from '$lib/components/StatusBar.svelte';
  import Welcome from '$lib/components/Welcome.svelte';
  import ErrorBoundary from '$lib/components/ErrorBoundary.svelte';
  // Everything else is dynamic-imported at the point of use so CodeMirror,
  // canvas/kanban/mindmap, modal dialogs, and right-panel components stay
  // out of the initial JS chunk.
  const loadEditor = () => import('$lib/components/Editor.svelte');
  const loadZenMode = () => import('$lib/components/ZenMode.svelte');
  const loadConflictDialog = () => import('$lib/components/ConflictDialog.svelte');
  const loadUnsavedChangesDialog = () => import('$lib/components/UnsavedChangesDialog.svelte');
  const loadCommandPalette = () => import('$lib/components/CommandPalette.svelte');
  const loadMoveFilePalette = () => import('$lib/components/MoveFilePalette.svelte');
  const loadExportDialog = () => import('$lib/components/ExportDialog.svelte');
  const loadSettings = () => import('$lib/components/Settings.svelte');
  const loadProjectSearch = () => import('$lib/components/ProjectSearch.svelte');
  const loadNewProjectDialog = () => import('$lib/components/NewProjectDialog.svelte');
  const loadMindmapOverlay = () => import('$lib/components/MindmapOverlay.svelte');
  const loadOutline = () => import('$lib/components/Outline.svelte');
  const loadDraftNote = () => import('$lib/components/DraftNote.svelte');
  const loadSnapshotPanel = () => import('$lib/components/SnapshotPanel.svelte');
  const loadStatsPanel = () => import('$lib/components/StatsPanel.svelte');
  const loadTemplatePanel = () => import('$lib/components/TemplatePanel.svelte');
  const loadPluginPanel = () => import('$lib/components/PluginPanel.svelte');
  const loadAiTalkPanel = () => import('$lib/components/AiTalkPanel.svelte');
  const loadAiAgentPanel = () => import('$lib/components/AiAgentPanel.svelte');
  const loadPluginFileEditor = () => import('$lib/components/PluginFileEditor.svelte');
  const loadCanvasFileEditor = () => import('$lib/components/CanvasFileEditor.svelte');
  const loadKanbanFileEditor = () => import('$lib/components/KanbanFileEditor.svelte');
  const loadUpdateProgressModal = () => import('$lib/components/UpdateProgressModal.svelte');
  const loadUpdateAvailableBanner = () => import('$lib/components/UpdateAvailableBanner.svelte');
  import { updaterState } from '$lib/stores/updater-state.svelte';
  import { consumeWindowSeed } from '$lib/services/cli-open';
  import type { TemplateFileSummary } from '$lib/ipc/commands';
  import { extensionStore } from '$lib/stores/extensions.svelte';
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
  import { pathBasename, pathDirname } from '$lib/utils/path';
  import { isScratchFile } from '$lib/utils/scratch';
  import { registerAppCommands } from '$lib/app-commands';
  import { wireAppEvents } from '$lib/composables/app-events.svelte';
  import { wireMenuEvents } from '$lib/composables/menu-events.svelte';
  import { useMenuSync } from '$lib/composables/menu-sync.svelte';
  import { useAppLifecycle } from '$lib/composables/app-lifecycle.svelte';
  import { unsavedPromptState, resolveUnsavedPrompt } from '$lib/composables/unsaved-prompt.svelte';
  import { handleKeepMine, handleLoadTheirs } from '$lib/conflict-handlers';
  import { createKeydownHandler } from '$lib/composables/app-shortcuts.svelte';
  import { createCloseTab } from '$lib/composables/close-tab.svelte';
  import { createScratchFile, createNewFileInProject, executeTemplate, requestSaveCurrentAsTemplate } from '$lib/services/new-file';
  import { SIDEBAR_PATH_MIME, hasSidebarPath, openPathInPane, openPathSplitRight } from '$lib/services/pane-drop';
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

  // Pane drop overlay (sidebar file → pane / split). The hovered zone drives
  // the visible drop indicator. 'none' = overlay rendered but no zone hot.
  type DropZone = 'none' | 'pane-1' | 'pane-2' | 'split-right';
  let activeDropZone = $state<DropZone>('none');

  function paneDragOver(e: DragEvent, zone: 'pane-1' | 'pane-2' | 'split-right') {
    if (!hasSidebarPath(e.dataTransfer?.types)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    activeDropZone = zone;
  }

  function paneDragLeave(zone: 'pane-1' | 'pane-2' | 'split-right') {
    // Only clear if the zone we're leaving is still the active one — otherwise
    // a sibling's dragenter may have already taken over.
    if (activeDropZone === zone) activeDropZone = 'none';
  }

  async function paneDrop(e: DragEvent, zone: 'pane-1' | 'pane-2' | 'split-right') {
    if (!hasSidebarPath(e.dataTransfer?.types)) return;
    e.preventDefault();
    activeDropZone = 'none';
    const path = e.dataTransfer?.getData(SIDEBAR_PATH_MIME);
    if (!path) return;
    if (zone === 'split-right') await openPathSplitRight(path);
    else await openPathInPane(zone, path);
  }

  function clearSidebarDragState() {
    uiStore.sidebarFileDragActive = false;
    activeDropZone = 'none';
  }

  // Whether any right panel content (not just toggle tabs) is visible
  let rightPanelContentVisible = $derived(
    uiStore.outlineVisible ||
    uiStore.draftVisible ||
    uiStore.snapshotVisible ||
    uiStore.statsVisible ||
    uiStore.templateVisible ||
    !!extensionStore.activePanelId
  );

  // Recent projects cache for Cmd+Number switching (Notion-style)
  import type { RecentProject } from '$lib/ipc/commands';
  let recentProjects = $state<RecentProject[]>([]);
  let projectSwitcherTrigger = $state(0);

  useWindowTitle(t);
  // Keep the native menu (labels + Open Recent) synced with the current
  // locale and recent-projects list. See menu-sync.svelte.ts.
  useMenuSync(() => recentProjects);

  // Conflict dialog state
  let conflictFilePath = $state<string | null>(null);

  async function refreshRecentProjects() {
    const result = await commands.getRecentProjects();
    if (result.status === 'ok') recentProjects = result.data;
  }

  function runStartupTask(label: string, task: () => Promise<void> | void): void {
    try {
      Promise.resolve(task()).catch((e) => {
        console.error(`[startup] ${label} failed:`, e);
      });
    } catch (e) {
      console.error(`[startup] ${label} failed:`, e);
    }
  }

  /** Auto-save all dirty files before switching project. */
  async function autoSaveBeforeSwitch(): Promise<boolean> {
    const dirty = tabsStore.dirtyTabs;
    if (dirty.length === 0) return true;
    return tabsStore.saveAllDirty();
  }

  async function openProjectFromPath(dirPath: string) {
    if (projectStore.isOpen) {
      const saved = await autoSaveBeforeSwitch();
      if (!saved) return;
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
    const name = config?.project?.name || pathBasename(dirPath) || 'Untitled';
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

  /**
   * Open a single text file in this window, entering single-file mode if no
   * project is open. Shared by the "Open File…" command and the spawned-window
   * `#file=` seed. Returns true on success.
   */
  async function openSingleFile(filePath: string, line: number | null = null): Promise<boolean> {
    const result = await commands.readFile(filePath);
    if (result.status !== 'ok') return false;
    if (!projectStore.isOpen) {
      projectStore.enterSingleFileMode();
      uiStore.sidebarVisible = false;
    }
    tabsStore.openTab(filePath, result.data);
    await commands.registerOpenFile(filePath);
    if (line && line > 0) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('novelist-goto-line', { detail: { line } }));
      });
    }
    return true;
  }

  async function handleOpenFile() {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv', 'canvas', 'kanban'] }],
    });
    if (!selected) return;
    await openSingleFile(selected as string);
  }

  /** Open the active file's containing folder as a project. */
  async function handleOpenContainingFolder() {
    const filePath = tabsStore.activeTab?.filePath;
    if (!filePath || isScratchFile(filePath)) return;
    const dir = pathDirname(filePath);
    if (dir) await openProjectFromPath(dir);
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

    // Commands must be registered before first-paint so global shortcuts
    // (Cmd+P, Cmd+K, Cmd+Shift+P, …) respond from the very first frame.
    registerAppCommands({
      t,
      getActiveEditorView,
      renameCurrentFile: () => activeEditorRef?.renameCurrentFile(),
      openNewWindow,
      handleNewFile,
      handleNewScratchFile,
      handleOpenFile,
      handleOpenDirectory,
      handleOpenContainingFolder,
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

    // Lifecycle wiring (onCloseRequested, WebDAV auto-sync) stays pre-paint so
    // quitting during the first frame still prompts on unsaved changes.
    const unlistenLifecycle = useAppLifecycle({
      t,
      isClosingTab: () => closeTab.isClosing(),
    });

    // Deferred teardown handles — nulled until the rAF fires. The cleanup
    // closure optional-chains so unmounting before first-paint is safe.
    let unlistenAppEvents: (() => void) | null = null;
    let unlistenMenu: (() => void) | null = null;

    startupMark('frontend.app.onMount.end');
    // Wait one frame so "first-paint" reflects the actual paint after mount.
    // After painting, wire the non-critical event bridges + kick off
    // deferred startup work (plugin scan, recent-projects refresh, updater).
    requestAnimationFrame(() => {
      startupMark('frontend.app.first-paint');
      runStartupTask('startupReport', () => startupReport());

      // Load recent projects for Cmd+Number switching.
      runStartupTask('refreshRecentProjects', () => refreshRecentProjects());

      // Load UI extensions from installed plugins. Deferred to idle so the
      // plugin disk scan (ensure_bundled_plugins + manifest parsing) runs
      // outside of the first-paint window. Built-in AI panels are hardcoded
      // into extensionStore so the toggle-tabs render without the scan.
      const scheduleIdle: (cb: () => void) => void =
        typeof (globalThis as any).requestIdleCallback === 'function'
          ? (cb) => (globalThis as any).requestIdleCallback(cb, { timeout: 2000 })
          : (cb) => setTimeout(cb, 200);
      scheduleIdle(() => {
        runStartupTask('extensionStore.loadFromPlugins', () => extensionStore.loadFromPlugins());
      });

      // Async event listeners — consolidated in $lib/composables/app-events.
      unlistenAppEvents = wireAppEvents({
        onConflict: (path) => { conflictFilePath = path; },
        onRecentProjectsUpdated: (list) => { recentProjects = list; },
        onGotoLine: (line) => {
          const ref = tabsStore.activePaneId === 'pane-2' ? pane2EditorRef : pane1EditorRef;
          ref?.jumpToAbsoluteLine(line);
        },
        onOpenProjectInThisWindow: (dirPath) => openProjectFromPath(dirPath),
      });

      // Spawned-window seed: this window may have been launched by the
      // cli-open routing helper with `#project=…` or `#file=…` in its hash.
      runStartupTask('consumeWindowSeed', () => consumeWindowSeed({
        openProject: (path) => openProjectFromPath(path),
        openFile: (filePath, line) => openSingleFile(filePath, line),
      }));

      // Native menu → commandRegistry dispatch bridge.
      unlistenMenu = wireMenuEvents({
        onOpenRecent: (path) => { void handleOpenRecent(path); },
      });

      // Check for updates silently after startup (5s delay to not block UI)
      setTimeout(async () => {
        runStartupTask('checkForUpdates', async () => {
          const { checkForUpdates } = await import('$lib/updater');
          await checkForUpdates(true);
        });
      }, 5000);
    });

    return () => {
      unlistenAppEvents?.();
      unlistenLifecycle();
      unlistenMenu?.();
    };
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (editorCtxMenu && e.key === 'Escape') { closeEditorCtxMenu(); e.preventDefault(); return; }
    handleKeydown(e);
  }}
  ondragend={clearSidebarDragState}
  ondrop={clearSidebarDragState}
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
  <Welcome onOpenFile={handleOpenFile} onOpenDirectory={handleOpenDirectory} onOpenRecent={handleOpenRecent} onNewFile={handleNewScratchFile} onNewProject={() => { newProjectDialogOpen = true; }} />
{:else if uiStore.zenMode}
  {#await loadZenMode() then { default: ZenMode }}
    <ZenMode {wordCount}>
      <div class="flex-1 min-h-0 overflow-hidden w-full">
        {#if tabsStore.getPaneActiveTab('pane-1')}
          {#await loadEditor() then { default: Editor }}
            <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
          {/await}
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
  {/await}
{:else}
  <!--
    Layout: sidebar | [editor-area] | outline
    Editor area: [pane1] | [pane2 if split] stacked vertically with shared status bar
  -->
  <div data-testid="app-layout" class="novelist-view-fade-in flex h-full w-full" style="{isDraggingAny ? 'cursor: col-resize; user-select: none;' : ''}">
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
      <div class="sidebar-edge">
        <button
          type="button"
          class="sidebar-toggle-handle"
          data-testid="sidebar-edge-toggle"
          title="{t('command.toggleSidebar')} ({formatShortcut(shortcutsStore.get('toggle-sidebar'))})"
          aria-label={t('command.toggleSidebar')}
          onclick={() => uiStore.toggleSidebar()}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 4L6 8l4 4" />
          </svg>
        </button>
        <div class="panel-resize-handle" onmousedown={startLeftSidebarDrag}></div>
      </div>
    {:else if projectStore.isOpen}
      <button
        type="button"
        class="sidebar-reopen-handle"
        data-testid="sidebar-edge-toggle"
        title="{t('command.toggleSidebar')} ({formatShortcut(shortcutsStore.get('toggle-sidebar'))})"
        aria-label={t('command.toggleSidebar')}
        onclick={() => uiStore.toggleSidebar()}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
    {/if}

    <!-- Main editor column (contains split panes + status bar) -->
    <div data-testid="editor-region" class="flex flex-col flex-1 min-w-0 relative">
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

          <div class="flex-1 min-h-0 overflow-hidden relative">
            {#if tabsStore.getPaneActiveTab('pane-1')}
              {@const fileName1 = tabsStore.getPaneActiveTab('pane-1')?.fileName ?? ''}
              {@const lower1 = fileName1.toLowerCase()}
              {#if lower1.endsWith('.canvas')}
                {#await loadCanvasFileEditor() then { default: CanvasFileEditor }}
                  <ErrorBoundary><CanvasFileEditor paneId="pane-1" /></ErrorBoundary>
                {/await}
              {:else if lower1.endsWith('.kanban')}
                {#await loadKanbanFileEditor() then { default: KanbanFileEditor }}
                  <ErrorBoundary><KanbanFileEditor paneId="pane-1" /></ErrorBoundary>
                {/await}
              {:else}
                {@const fileHandler1 = extensionStore.getFileHandler(fileName1)}
                {#if fileHandler1}
                  {#await loadPluginFileEditor() then { default: PluginFileEditor }}
                    <ErrorBoundary><PluginFileEditor extension={fileHandler1} paneId="pane-1" /></ErrorBoundary>
                  {/await}
                {:else}
                  {#await loadEditor() then { default: Editor }}
                    <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={pane1WordCount} bind:cursorLine={pane1CursorLine} bind:cursorCol={pane1CursorCol} bind:headings={pane1Headings} bind:this={pane1EditorRef} /></ErrorBoundary>
                  {/await}
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

            <!-- Sidebar-file drop overlay (open in pane-1 / split right) -->
            {#if uiStore.sidebarFileDragActive}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="pane-drop-zone pane-drop-main"
                class:pane-drop-active={activeDropZone === 'pane-1'}
                style="right: {tabsStore.splitActive ? '0' : '30%'};"
                ondragover={(e) => paneDragOver(e, 'pane-1')}
                ondragleave={() => paneDragLeave('pane-1')}
                ondrop={(e) => paneDrop(e, 'pane-1')}
              >
                <span class="pane-drop-label">{t('pane.drop.openHere')}</span>
              </div>
              {#if !tabsStore.splitActive}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="pane-drop-zone pane-drop-split-right"
                  class:pane-drop-active={activeDropZone === 'split-right'}
                  ondragover={(e) => paneDragOver(e, 'split-right')}
                  ondragleave={() => paneDragLeave('split-right')}
                  ondrop={(e) => paneDrop(e, 'split-right')}
                >
                  <span class="pane-drop-label">{t('pane.drop.splitRight')}</span>
                </div>
              {/if}
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

            <div class="flex-1 min-h-0 overflow-hidden relative">
              {#if tabsStore.getPaneActiveTab('pane-2')}
                {@const fileName2 = tabsStore.getPaneActiveTab('pane-2')?.fileName ?? ''}
                {@const lower2 = fileName2.toLowerCase()}
                {#if lower2.endsWith('.canvas')}
                  {#await loadCanvasFileEditor() then { default: CanvasFileEditor }}
                    <ErrorBoundary><CanvasFileEditor paneId="pane-2" /></ErrorBoundary>
                  {/await}
                {:else if lower2.endsWith('.kanban')}
                  {#await loadKanbanFileEditor() then { default: KanbanFileEditor }}
                    <ErrorBoundary><KanbanFileEditor paneId="pane-2" /></ErrorBoundary>
                  {/await}
                {:else}
                  {@const fileHandler2 = extensionStore.getFileHandler(fileName2)}
                  {#if fileHandler2}
                    {#await loadPluginFileEditor() then { default: PluginFileEditor }}
                      <ErrorBoundary><PluginFileEditor extension={fileHandler2} paneId="pane-2" /></ErrorBoundary>
                    {/await}
                  {:else}
                    {#await loadEditor() then { default: Editor }}
                      <ErrorBoundary><Editor paneId="pane-2" bind:wordCount={pane2WordCount} bind:cursorLine={pane2CursorLine} bind:cursorCol={pane2CursorCol} bind:headings={pane2Headings} bind:this={pane2EditorRef} /></ErrorBoundary>
                    {/await}
                  {/if}
                {/if}
              {:else}
                <div class="flex items-center justify-center h-full" style="color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
                  <div class="text-center">
                    <p style="font-size: 0.95rem;">{t('app.openFile')}</p>
                  </div>
                </div>
              {/if}

              <!-- Sidebar-file drop overlay (open in pane-2) -->
              {#if uiStore.sidebarFileDragActive}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="pane-drop-zone pane-drop-main"
                  class:pane-drop-active={activeDropZone === 'pane-2'}
                  style="right: 0;"
                  ondragover={(e) => paneDragOver(e, 'pane-2')}
                  ondragleave={() => paneDragLeave('pane-2')}
                  ondrop={(e) => paneDrop(e, 'pane-2')}
                >
                  <span class="pane-drop-label">{t('pane.drop.openHere')}</span>
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
        <div class="overflow-y-auto" style="width: {uiStore.rightPanelWidth}px; border-right: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          {#await loadOutline() then { default: Outline }}
            <Outline {headings} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} onMoveSection={handleMoveSection} />
          {/await}
        </div>
      {/if}
      {#if uiStore.draftVisible && tabsStore.activeTab}
        <div style="width: {uiStore.rightPanelWidth}px;">
          {#await loadDraftNote() then { default: DraftNote }}
            <DraftNote filePath={tabsStore.activeTab.filePath} />
          {/await}
        </div>
      {:else if uiStore.snapshotVisible}
        <div style="width: {uiStore.rightPanelWidth}px;">
          {#await loadSnapshotPanel() then { default: SnapshotPanel }}
            <SnapshotPanel />
          {/await}
        </div>
      {:else if uiStore.statsVisible && (projectStore.dirPath ?? tabsStore.activeTab)}
        <div style="width: {uiStore.rightPanelWidth}px;">
          {#await loadStatsPanel() then { default: StatsPanel }}
            <StatsPanel projectDir={projectStore.dirPath ?? tabsStore.activeTab?.filePath ?? ''} />
          {/await}
        </div>
      {:else if uiStore.templateVisible}
        <div style="width: {uiStore.rightPanelWidth}px;">
          {#await loadTemplatePanel() then { default: TemplatePanel }}
            <TemplatePanel
              onExecute={executeTemplateWrapper}
              openDialogRequest={templateDialogRequest}
              onDialogHandled={() => { templateDialogRequest = null; }}
            />
          {/await}
        </div>
      {:else if extensionStore.activePanelId}
        {@const activePanel = extensionStore.panels.find(p => p.pluginId === extensionStore.activePanelId)}
        {#if activePanel?.pluginId === 'ai-talk'}
          <div style="width: {uiStore.rightPanelWidth}px;">
            {#await loadAiTalkPanel() then { default: AiTalkPanel }}
              <ErrorBoundary><AiTalkPanel /></ErrorBoundary>
            {/await}
          </div>
        {:else if activePanel?.pluginId === 'ai-agent'}
          <div style="width: {uiStore.rightPanelWidth}px;">
            {#await loadAiAgentPanel() then { default: AiAgentPanel }}
              <ErrorBoundary><AiAgentPanel /></ErrorBoundary>
            {/await}
          </div>
        {:else if activePanel && tabsStore.activeTab}
          <div style="width: {uiStore.rightPanelWidth}px;">
            {#await loadPluginPanel() then { default: PluginPanel }}
              <PluginPanel extension={activePanel} onNavigate={(from) => activeEditorRef?.scrollToPosition(from)} />
            {/await}
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
            data-testid="panel-toggle-{panel.pluginId}"
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
  {#await loadConflictDialog() then { default: ConflictDialog }}
    <ConflictDialog
      filePath={conflictFilePath}
      onKeepMine={() => handleKeepMine(conflictFilePath!)}
      onLoadTheirs={() => handleLoadTheirs(conflictFilePath!)}
      onClose={() => { conflictFilePath = null; }}
    />
  {/await}
{/if}

{#if unsavedPromptState.pending}
  {#await loadUnsavedChangesDialog() then { default: UnsavedChangesDialog }}
    <UnsavedChangesDialog
      fileNames={unsavedPromptState.pending.fileNames}
      saveLabel={unsavedPromptState.pending.saveLabel}
      onSave={() => resolveUnsavedPrompt('save')}
      onDontSave={() => resolveUnsavedPrompt('discard')}
      onCancel={() => resolveUnsavedPrompt('cancel')}
    />
  {/await}
{/if}

{#if paletteOpen}
  {#await loadCommandPalette() then { default: CommandPalette }}
    <CommandPalette onClose={() => { paletteOpen = false; }} />
  {/await}
{/if}

{#if movePaletteOpen}
  {#await loadMoveFilePalette() then { default: MoveFilePalette }}
    <MoveFilePalette onClose={() => {
      movePaletteOpen = false;
      // Return focus to the editor on the next frame so typing resumes without
      // a manual click. rAF waits for the palette's input to unmount first.
      const tabId = tabsStore.activeTab?.id;
      if (tabId) requestAnimationFrame(() => getEditorView(tabId)?.focus());
    }} />
  {/await}
{/if}

{#if exportDialogOpen}
  {#await loadExportDialog() then { default: ExportDialog }}
    <ExportDialog onClose={() => { exportDialogOpen = false; }} />
  {/await}
{/if}

{#if uiStore.settingsOpen}
  {#await loadSettings() then { default: Settings }}
    <Settings onClose={() => { uiStore.settingsOpen = false; }} />
  {/await}
{/if}

{#if projectSearchOpen}
  {#await loadProjectSearch() then { default: ProjectSearch }}
    <ProjectSearch onClose={() => { projectSearchOpen = false; }} />
  {/await}
{/if}

{#if mindmapOverlayOpen}
  {@const activeTab = tabsStore.activeTab}
  {@const view = activeTab ? getEditorView(activeTab.id) : undefined}
  {@const mdContent = view?.state.doc.toString() ?? activeTab?.content ?? ''}
  {#await loadMindmapOverlay() then { default: MindmapOverlay }}
    <MindmapOverlay content={mdContent} onClose={() => { mindmapOverlayOpen = false; }} />
  {/await}
{/if}

{#if newProjectDialogOpen}
  {#await loadNewProjectDialog() then { default: NewProjectDialog }}
    <NewProjectDialog
      onClose={() => { newProjectDialogOpen = false; }}
      onProjectCreated={(path) => openProjectFromPath(path)}
    />
  {/await}
{/if}

{#if updaterState.phase === 'available'}
  {#await loadUpdateAvailableBanner() then { default: UpdateAvailableBanner }}
    <UpdateAvailableBanner />
  {/await}
{/if}

{#if updaterState.phase === 'downloading' || updaterState.phase === 'installing' || updaterState.phase === 'ready' || updaterState.phase === 'error'}
  {#await loadUpdateProgressModal() then { default: UpdateProgressModal }}
    <UpdateProgressModal />
  {/await}
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

  .sidebar-edge {
    position: relative;
    flex-shrink: 0;
    box-sizing: border-box;
    width: 4px;
    display: flex;
    align-items: stretch;
    background: var(--novelist-sidebar-bg);
    border-left: 1px solid var(--novelist-border-subtle, var(--novelist-border));
  }
  .sidebar-edge .panel-resize-handle {
    width: 4px;
    margin-left: 0;
    background: transparent;
  }
  .sidebar-edge .panel-resize-handle:hover {
    background: color-mix(in srgb, var(--novelist-accent) 16%, var(--novelist-sidebar-bg));
  }
  .sidebar-toggle-handle,
  .sidebar-reopen-handle {
    position: absolute;
    top: 50%;
    z-index: 70;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 26px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--novelist-accent) 22%, var(--novelist-border));
    background: var(--novelist-sidebar-bg);
    color: color-mix(in srgb, var(--novelist-accent) 45%, var(--novelist-text-tertiary, var(--novelist-text-secondary)));
    cursor: pointer;
    transform: translateY(-50%);
    transition: color 120ms, border-color 120ms, background 120ms, box-shadow 120ms;
  }
  .sidebar-toggle-handle svg,
  .sidebar-reopen-handle svg {
    width: 8px;
    height: 8px;
  }
  .sidebar-toggle-handle {
    right: -5px;
    border-radius: 0 5px 5px 0;
  }
  .sidebar-reopen-handle {
    left: 0;
    border-left: none;
    border-radius: 0 5px 5px 0;
  }
  .sidebar-toggle-handle:hover,
  .sidebar-reopen-handle:hover {
    color: var(--novelist-accent);
    border-color: color-mix(in srgb, var(--novelist-accent) 70%, var(--novelist-border));
    background: var(--novelist-sidebar-hover);
    box-shadow: 0 1px 4px color-mix(in srgb, var(--novelist-text) 8%, transparent);
  }
  .sidebar-toggle-handle:focus-visible,
  .sidebar-reopen-handle:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--novelist-accent) 36%, transparent);
    outline-offset: 2px;
  }

  /* Pane drop overlays — only rendered while a sidebar file drag is in flight. */
  .pane-drop-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    background: transparent;
    border: 2px dashed transparent;
    border-radius: 6px;
    transition: background 120ms, border-color 120ms;
  }
  .pane-drop-split-right {
    left: auto;
    right: 0;
    width: 30%;
  }
  .pane-drop-active {
    background: color-mix(in srgb, var(--novelist-accent) 12%, transparent);
    border-color: var(--novelist-accent);
  }
  .pane-drop-label {
    color: var(--novelist-text-secondary);
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    opacity: 0;
    transition: opacity 120ms;
    pointer-events: none;
  }
  .pane-drop-active .pane-drop-label {
    opacity: 1;
    color: var(--novelist-accent);
  }

</style>
