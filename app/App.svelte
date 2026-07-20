<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import X from '@lucide/svelte/icons/x';
  import { open } from '@tauri-apps/plugin-dialog';
  import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
  // First-paint critical shell: keep these static.
  import Sidebar from '$lib/components/Sidebar.svelte';
  import EditorPane, { type PaneMetrics } from '$lib/components/EditorPane.svelte';
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
  const loadUpdateProgressModal = () => import('$lib/components/UpdateProgressModal.svelte');
  const loadUpdateAvailableBanner = () => import('$lib/components/UpdateAvailableBanner.svelte');
  import { updaterState } from '$lib/stores/updater-state.svelte';
  import { consumeWindowSeed } from '$lib/services/cli-open';
  import { ProjectOpenOwner } from '$lib/services/project-open-owner';
  import { ProjectWatcherOwner } from '$lib/services/project-watcher-owner';
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
  import { BLOCK_TRANSFORM_COMMANDS, registerAppCommands } from '$lib/app-commands';
  import { wireAppEvents } from '$lib/composables/app-events.svelte';
  import { wireMenuEvents } from '$lib/composables/menu-events.svelte';
  import { useMenuSync } from '$lib/composables/menu-sync.svelte';
  import { useAppLifecycle } from '$lib/composables/app-lifecycle.svelte';
  import { initScrollAutoHide } from '$lib/actions/auto-hide-scroll';
  import { unsavedPromptState, resolveUnsavedPrompt } from '$lib/composables/unsaved-prompt.svelte';
  import { handleKeepMine, handleLoadTheirs } from '$lib/conflict-handlers';
  import { createKeydownHandler } from '$lib/composables/app-shortcuts.svelte';
  import { createCloseTab } from '$lib/composables/close-tab.svelte';
  import { createScratchFile, createNewFileInProject, executeTemplate, requestSaveCurrentAsTemplate } from '$lib/services/new-file';
  import { shortcutsStore, initShortcutsI18n, formatShortcut } from '$lib/stores/shortcuts.svelte';
  import { t } from '$lib/i18n';
  import type { HeadingItem } from '$lib/editor/outline';
  import type { EditorView } from '@codemirror/view';

  // Per-pane editor metrics, keyed by pane id. Each EditorPane pushes its
  // word-count / cursor / headings / editor-ref up via onmetrics; the status
  // bar and outline read whichever pane is active.
  //
  // `handlePaneMetrics` is called FROM an EditorPane $effect, so we must read
  // the previous `paneMetrics` untracked — otherwise that effect would gain a
  // dependency on the very state it writes and loop forever.
  let paneMetrics = $state<Record<string, PaneMetrics>>({});
  function handlePaneMetrics(paneId: string, m: PaneMetrics) {
    paneMetrics = { ...untrack(() => paneMetrics), [paneId]: m };
  }
  // Drop metrics for panes that no longer exist (closed columns). Depends only
  // on `panes`; the paneMetrics read/write is untracked so this never self-loops.
  $effect(() => {
    const ids = new Set(tabsStore.panes.map(p => p.id));
    untrack(() => {
      const stale = Object.keys(paneMetrics).filter(id => !ids.has(id));
      if (stale.length) {
        const next = { ...paneMetrics };
        for (const id of stale) delete next[id];
        paneMetrics = next;
      }
    });
  });

  // Zen mode renders a single (pane-1) editor; keep its word count locally.
  let zenWordCount = $state(0);

  // Status bar reflects the active pane.
  let activeMetrics = $derived(paneMetrics[tabsStore.activePaneId]);
  let wordCount = $derived(activeMetrics?.wordCount ?? 0);
  let cursorLine = $derived(activeMetrics?.cursorLine ?? 1);
  let cursorCol = $derived(activeMetrics?.cursorCol ?? 1);
  let headings = $derived(activeMetrics?.headings ?? []);
  let activeEditorRef = $derived(activeMetrics?.editorRef);

let paletteOpen = $state(false);
  let movePaletteOpen = $state(false);
  let exportDialogOpen = $state(false);
  let mindmapOverlayOpen = $state(false);
  let projectSearchOpen = $state(false);
  let newProjectDialogOpen = $state(false);
  let operationError = $state<string | null>(null);
  // Opening the template dialog from outside TemplatePanel (e.g. from the
  // command palette) — the panel consumes this object then calls back to clear.
  let templateDialogRequest = $state<{ id: string | null; prefill?: { name?: string; body?: string } } | null>(null);

  // Drag state flags — kept here so the template can bind cursor styles etc.
  let isDraggingSplit = $state(false);
  let isDraggingLeftSidebar = $state(false);
  let isDraggingRightPanel = $state(false);
  let splitContainerRef: HTMLDivElement | undefined = $state(undefined);

  // Column flex grow factor for pane `i`. The 2-pane case keeps using the
  // persisted `splitRatio`; N>2 columns use session-only weights in the store.
  function paneFlex(i: number): number {
    if (tabsStore.panes.length === 2) {
      return i === 0 ? uiStore.splitRatio : 1 - uiStore.splitRatio;
    }
    return tabsStore.paneSizes[i] ?? 1;
  }

  // Divider `i` sits between columns i-1 and i and redistributes width between
  // them. Returns a fresh mousedown handler bound to that divider index.
  function startDividerDrag(i: number) {
    return makeResizeHandler({
      shouldStart: () => tabsStore.panes.length > 1,
      setDragging: (v) => { isDraggingSplit = v; },
      init: () => ({
        rect: splitContainerRef!.getBoundingClientRect(),
        sizes: [...tabsStore.paneSizes],
      }),
      onMove: (ev, s) => {
        if (!splitContainerRef) return;
        const px = (ev.clientX - s.rect.left) / s.rect.width;
        if (tabsStore.panes.length === 2) {
          uiStore.setSplitRatio(px);
          return;
        }
        const left = i - 1, right = i;
        const total = s.sizes.reduce((a, b) => a + b, 0) || 1;
        const beforeFrac = s.sizes.slice(0, left).reduce((a, b) => a + b, 0) / total;
        const pair = s.sizes[left] + s.sizes[right];
        const pairFrac = pair / total;
        const MINF = 0.1;
        let leftFrac = Math.max(MINF, Math.min(pairFrac - MINF, px - beforeFrac));
        const leftWeight = (leftFrac / pairFrac) * pair;
        const next = [...s.sizes];
        next[left] = leftWeight;
        next[right] = pair - leftWeight;
        tabsStore.paneSizes = next;
      },
    });
  }

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

  // Per-pane edge drop zones live in EditorPane.svelte now.

  function clearSidebarDragState() {
    uiStore.sidebarFileDragActive = false;
    uiStore.tabDragActive = false;
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
  const projectOpenOwner = new ProjectOpenOwner();
  const projectWatcherOwner = new ProjectWatcherOwner({
    stop: () => commands.stopFileWatcher(),
    start: (projectDir) => commands.startFileWatcher(projectDir),
  });

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

  function showOperationError(message: string): void {
    operationError = message;
  }

  /** Auto-save all dirty files before switching project. */
  async function autoSaveBeforeSwitch(): Promise<boolean> {
    const dirty = tabsStore.dirtyTabs;
    if (dirty.length === 0) return true;
    return tabsStore.saveAllDirty();
  }

  async function openProjectFromPath(dirPath: string) {
    const token = projectOpenOwner.begin(dirPath, projectStore.dirPath, projectStore.generation);
    if (!token) return;
    const isCurrent = () => projectOpenOwner.isCurrent(token);
    await projectOpenOwner.run(token, async () => {
      const previousProjectDir = projectStore.dirPath;
      const previousOpenFiles = [...new Set(tabsStore.allTabs.map(tab => tab.filePath))];
      let watcherStopped = false;
      let targetWatcherStarted = false;
      let committed = false;
      try {
        if (projectStore.isOpen) {
          const saved = await autoSaveBeforeSwitch();
          if (!saved || !isCurrent()) return;
        }

        try {
          await projectStore.prepareProjectSwitch(dirPath);
        } catch {
          return;
        }
        if (!isCurrent()) return;

        projectStore.isLoading = true;
        watcherStopped = true;
        const stopped = await projectWatcherOwner.stop(isCurrent);
        if (!stopped || !isCurrent()) return;
        if (stopped.status === 'error') {
          console.error('Failed to stop file watcher:', stopped.error);
          showOperationError(t('project.watcherUnavailable'));
          return;
        }

        const configResult = await commands.detectProject(dirPath);
        if (!isCurrent() || configResult.status !== 'ok') return;
        const config = configResult.data;

        // Load the per-project settings overlay BEFORE the initial listDirectory
        // so the user's saved `show_hidden_files` preference applies to the first
        // tree render. `projectStore.setProject` also kicks a load, but awaiting
        // here guarantees the preference is known before we fetch files.
        const preparedSettings = await settingsStore.prepareLoad(dirPath);
        if (!isCurrent()) return;

        const filesResult = await commands.listDirectory(
          dirPath,
          preparedSettings.effective.view.show_hidden_files,
        );
        if (!isCurrent() || filesResult.status !== 'ok') return;
        const files = filesResult.data;

        if (projectStore.isOpen) {
          const saved = await autoSaveBeforeSwitch();
          if (!saved || !isCurrent()) return;
        }

        // A project is not committed until its required watcher is live. This
        // keeps the current project intact when native watcher setup fails.
        const watchResult = await projectWatcherOwner.start(dirPath, isCurrent);
        if (!isCurrent() || !watchResult) return;
        if (watchResult.status === 'error') {
          console.error('Failed to start file watcher:', watchResult.error);
          showOperationError(t('project.watcherUnavailable'));
          return;
        }
        targetWatcherStarted = true;

        if (!projectOpenOwner.seal(token)) return;
        committed = await projectStore.setProject(dirPath, config, files, token.id, true);
        if (!committed || !isCurrent()) return;
        settingsStore.commitPrepared(preparedSettings);
        uiStore.sidebarVisible = true;
        tabsStore.closeAll();

        // Track as recent project (backend persistence for next launch)
        const name = config?.project?.name || pathBasename(dirPath) || 'Untitled';
        await commands.addRecentProject(dirPath, name);

        // Keep Cmd+number mapping stable: only append truly new projects
        if (isCurrent() && !recentProjects.some(p => p.path === dirPath)) {
          recentProjects = [...recentProjects, { path: dirPath, name, last_opened: String(Math.floor(Date.now() / 1000)), pinned: false, sort_order: null }];
        }
      } finally {
        try {
          if (!committed) {
            projectStore.isLoading = false;
            if (targetWatcherStarted) {
              await projectWatcherOwner.stop(() => projectStore.dirPath !== dirPath);
            }
            if (watcherStopped && isCurrent()) {
              let restoreFailed = false;
              if (previousProjectDir) {
                const restored = await projectWatcherOwner.start(
                  previousProjectDir,
                  () => isCurrent() && projectStore.dirPath === previousProjectDir,
                );
                if (!restored || restored.status === 'error') {
                  restoreFailed = true;
                  console.error(
                    'Failed to restore previous file watcher:',
                    restored?.status === 'error' ? restored.error : 'stale restore',
                  );
                }
              }
              for (const filePath of previousOpenFiles) {
                try {
                  const registered = await commands.registerOpenFile(filePath);
                  if (registered.status === 'error') {
                    restoreFailed = true;
                    console.error('Failed to restore tracked open file:', registered.error);
                  }
                } catch (error) {
                  restoreFailed = true;
                  console.error('Failed to restore tracked open file:', error);
                }
              }
              if (restoreFailed) showOperationError(t('project.watcherUnavailable'));
            }
          }
        } finally {
          projectOpenOwner.settle(token);
        }
      }
    });
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
    await projectOpenOwner.cancel();
    const result = await commands.readFile(filePath);
    if (result.status !== 'ok') return false;
    if (!projectStore.isOpen) {
      await projectStore.enterSingleFileMode();
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

  const handleNewScratchFile = async () => {
    await projectOpenOwner.cancel();
    return createScratchFile();
  };
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
  let blockTypeSubmenuOpen = $state(false);
  let blockTypeTrigger = $state<HTMLButtonElement | null>(null);
  let blockTypeSubmenu = $state<HTMLDivElement | null>(null);
  let blockTypeSubmenuPosition = $state<{ left: number; top: number } | null>(null);
  const CONTEXT_SUBMENU_GAP = 4;
  const CONTEXT_VIEWPORT_MARGIN = 8;
  // Read-alias so markup expressions like `editorCtxMenu.x` stay byte-identical.
  // Writes (oncontextmenu handler below) go through `editorCtx.state = ...`.
  const editorCtxMenu = $derived(editorCtx.state);
  function closeBlockTypeSubmenu(restoreTriggerFocus = false) {
    blockTypeSubmenuOpen = false;
    blockTypeSubmenuPosition = null;
    if (restoreTriggerFocus) blockTypeTrigger?.focus();
  }
  function closeEditorCtxMenu() {
    closeBlockTypeSubmenu();
    editorCtx.close();
  }
  function positionBlockTypeSubmenu() {
    if (!blockTypeTrigger || !blockTypeSubmenu) return;
    const triggerRect = blockTypeTrigger.getBoundingClientRect();
    const submenuRect = blockTypeSubmenu.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

    let left = triggerRect.right + CONTEXT_SUBMENU_GAP;
    if (left + submenuRect.width > viewportWidth - CONTEXT_VIEWPORT_MARGIN) {
      left = triggerRect.left - submenuRect.width - CONTEXT_SUBMENU_GAP;
    }
    left = Math.min(
      Math.max(CONTEXT_VIEWPORT_MARGIN, left),
      Math.max(CONTEXT_VIEWPORT_MARGIN, viewportWidth - CONTEXT_VIEWPORT_MARGIN - submenuRect.width),
    );
    const top = Math.min(
      Math.max(CONTEXT_VIEWPORT_MARGIN, triggerRect.top),
      Math.max(CONTEXT_VIEWPORT_MARGIN, viewportHeight - CONTEXT_VIEWPORT_MARGIN - submenuRect.height),
    );
    blockTypeSubmenuPosition = { left, top };
  }
  async function openBlockTypeSubmenu(focusFirst = false) {
    blockTypeSubmenuOpen = true;
    await tick();
    if (!blockTypeSubmenuOpen) return;
    positionBlockTypeSubmenu();
    if (focusFirst) {
      await tick();
      blockTypeSubmenu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    }
  }
  function handleBlockTypeTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      void openBlockTypeSubmenu(true);
    }
  }
  function handleBlockTypeSubmenuKeydown(event: KeyboardEvent) {
    const items = [...(blockTypeSubmenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
    else if (event.key === 'ArrowUp') nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      closeBlockTypeSubmenu(true);
      return;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeEditorCtxMenu();
      getActiveEditorView()?.focus();
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (items.length > 0 && nextIndex !== null) items[nextIndex]?.focus();
  }
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
    const ref = activeEditorRef;
    promptGoToLine(t('gotoline.prompt'), (line) => ref?.jumpToAbsoluteLine(line));
  }

  onMount(() => {
    startupMark('frontend.app.onMount.begin');
    // Wire up i18n for shortcuts store (needs Svelte compile context)
    initShortcutsI18n(t);
    // Reveal overlay scrollbars while actively scrolling (hover reveal is CSS).
    const unlistenScrollAutoHide = initScrollAutoHide();
    const handleOperationError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: unknown }>).detail;
      if (typeof detail?.message === 'string' && detail.message.trim()) {
        showOperationError(detail.message);
      }
    };
    window.addEventListener('novelist-operation-error', handleOperationError);
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
        openProject: (path: string) => openProjectFromPath(path),
        openFile: (path: string) => openSingleFile(path),
        getActiveEditor: () => {
          const tab = tabsStore.activeTab;
          const view = getActiveEditorView();
          if (!tab || !view || !view.dom.isConnected) return null;
          return { tabId: tab.id, filePath: tab.filePath, view };
        },
        setActiveEditorDocument: async (
          content: string,
          selection: { anchor: number; head: number },
        ) => {
          const { Transaction } = await import('@codemirror/state');
          const view = getActiveEditorView();
          if (!view || !view.dom.isConnected) throw new Error('Active editor is not ready');
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: content },
            selection,
            annotations: Transaction.addToHistory.of(false),
          });
          view.focus();
        },
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
    const scheduleFirstFrame = (callback: FrameRequestCallback) => {
      if ((window as typeof window & { __PW_ACTIVE__?: boolean }).__PW_ACTIVE__) {
        window.setTimeout(() => callback(performance.now()), 0);
      } else {
        requestAnimationFrame(callback);
      }
    };
    scheduleFirstFrame(() => {
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
          const ref = activeEditorRef;
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
      unlistenScrollAutoHide();
      window.removeEventListener('novelist-operation-error', handleOperationError);
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
      closeBlockTypeSubmenu();
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

{#if operationError}
  <div class="operation-error-toast" role="alert" data-testid="operation-error">
    <span>{operationError}</span>
    <button
      type="button"
      class="operation-error-dismiss"
      title={t('common.dismiss')}
      aria-label={t('common.dismiss')}
      onclick={() => { operationError = null; }}
    >
      <X size={15} />
    </button>
  </div>
{/if}

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
    <button
      bind:this={blockTypeTrigger}
      type="button"
      role="menuitem"
      class="context-menu-item context-menu-submenu-trigger"
      data-testid="editor-ctx-block-type"
      aria-haspopup="menu"
      aria-expanded={blockTypeSubmenuOpen}
      aria-controls="editor-block-type-submenu"
      onclick={() => { void openBlockTypeSubmenu(); }}
      onmouseenter={() => { void openBlockTypeSubmenu(); }}
      onkeydown={handleBlockTypeTriggerKeydown}
    >
      <span>{t('editor.menu.blockType')}</span>
      <ChevronRight class="context-menu-submenu-chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    <div class="context-menu-separator"></div>
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
    {#if blockTypeSubmenuOpen}
      <div
        bind:this={blockTypeSubmenu}
        id="editor-block-type-submenu"
        role="menu"
        tabindex="-1"
        class="context-menu context-submenu"
        data-positioned={blockTypeSubmenuPosition !== null}
        data-testid="editor-ctx-block-submenu"
        aria-label={t('editor.menu.blockType')}
        style:left={blockTypeSubmenuPosition ? `${blockTypeSubmenuPosition.left}px` : '0'}
        style:top={blockTypeSubmenuPosition ? `${blockTypeSubmenuPosition.top}px` : '0'}
        onkeydown={handleBlockTypeSubmenuKeydown}
      >
        {#each BLOCK_TRANSFORM_COMMANDS as command}
          <button
            type="button"
            role="menuitem"
            class="context-menu-item context-submenu-item"
            data-testid="editor-ctx-block-{command.target}"
            onclick={() => { editorCtxRunCommand(command.id); closeEditorCtxMenu(); }}
          >{t(command.labelKey)}</button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if !projectStore.isOpen}
  <Welcome onOpenFile={handleOpenFile} onOpenDirectory={handleOpenDirectory} onOpenRecent={handleOpenRecent} onNewFile={handleNewScratchFile} onNewProject={() => { newProjectDialogOpen = true; }} />
{:else if uiStore.zenMode}
  {#await loadZenMode() then { default: ZenMode }}
    <ZenMode wordCount={zenWordCount}>
      <div class="flex-1 min-h-0 overflow-hidden w-full">
        {#if tabsStore.getPaneActiveTab('pane-1')}
          {#await loadEditor() then { default: Editor }}
            <ErrorBoundary><Editor paneId="pane-1" bind:wordCount={zenWordCount} /></ErrorBoundary>
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
      <!-- Panes row: N resizable editor columns, dividers between them. -->
      <div class="flex flex-1 min-h-0" bind:this={splitContainerRef} style="{isDraggingSplit ? 'cursor: col-resize; user-select: none;' : ''}">
        {#each tabsStore.panes as pane, i (pane.id)}
          {#if i > 0}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="split-divider" onmousedown={startDividerDrag(i)}></div>
          {/if}
          <div class="flex flex-col min-w-0" style="flex: {paneFlex(i)} 1 0%;">
            <EditorPane
              paneId={pane.id}
              index={i}
              isPrimary={i === 0}
              isActive={tabsStore.activePaneId === pane.id}
              onmetrics={handlePaneMetrics}
            />
          </div>
        {/each}
      </div>

      <!-- Shared status bar spanning all panes -->
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
  .operation-error-toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 500;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: min(420px, calc(100vw - 32px));
    padding: 10px 10px 10px 12px;
    border: 1px solid color-mix(in srgb, #d24a4a 58%, var(--novelist-border));
    border-radius: 6px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    box-shadow: 0 6px 18px color-mix(in srgb, #000 16%, transparent);
    font-size: 13px;
    line-height: 1.4;
  }

  .operation-error-toast span {
    min-width: 0;
    flex: 1;
  }

  .operation-error-dismiss {
    display: inline-flex;
    flex: 0 0 26px;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
  }

  .operation-error-dismiss:hover {
    background: var(--novelist-hover);
    color: var(--novelist-text);
  }

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
    transition: color 120ms, border-color 120ms, background 120ms, box-shadow 120ms, opacity 120ms;
  }
  .sidebar-toggle-handle svg,
  .sidebar-reopen-handle svg {
    width: 8px;
    height: 8px;
  }
  .sidebar-toggle-handle {
    right: -5px;
    border-radius: 0 5px 5px 0;
    /* Hidden at rest; revealed when the pointer is over the sidebar or its
       edge (or when focused via keyboard). Keeps the writing surface clean. */
    opacity: 0;
  }
  [data-testid='sidebar-region']:hover + .sidebar-edge .sidebar-toggle-handle,
  .sidebar-edge:hover .sidebar-toggle-handle,
  .sidebar-toggle-handle:focus-visible {
    opacity: 1;
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
</style>
