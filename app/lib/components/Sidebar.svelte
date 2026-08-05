<script lang="ts">
  import { tick } from 'svelte';
  import { open } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import {
    moveItemAfterSidecarFlush,
    renameItemAfterSidecarFlush,
  } from '$lib/services/rename-coordinator';
  import type { RecentProject } from '$lib/ipc/commands';
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { extensionStore } from '$lib/stores/extensions.svelte';
  import { formatShortcut, shortcutsStore } from '$lib/stores/shortcuts.svelte';
  import { t } from '$lib/i18n';
  import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
  import FileTreeNode from '$lib/components/FileTreeNode.svelte';
  import { compareByMode, type SortMode } from '$lib/utils/file-sort';
  import {
    currentFilenameTemplateRaw,
    persistManagedNameEnrollment,
    proposeNewFileName,
  } from '$lib/services/new-file';
  import {
    detachManagedName,
    loadManagedName,
    reEnableManagedName,
    type ManagedNameLoadResult,
  } from '$lib/services/managed-name-persistence';
  import {
    persistReEnableAutoNamingMenuAction,
    persistStopAutoNamingMenuAction,
  } from '$lib/services/managed-name-menu-actions';
  import { SIDEBAR_PATH_MIME } from '$lib/services/pane-drop';
  import { fileManagerLabelKey } from '$lib/utils/platform-labels';
  import { pathBasename, pathDirname, pathStartsWithChild } from '$lib/utils/path';

  // --- Project switcher popup (Notion-style) ---
  let switcherOpen = $state(false);

  // --- Sort menu popup ---
  let sortMenuOpen = $state(false);

  const sortOptions: Array<{ id: SortMode; labelKey: string }> = [
    { id: 'numeric-asc', labelKey: 'sidebar.sort.numericAsc' },
    { id: 'numeric-desc', labelKey: 'sidebar.sort.numericDesc' },
    { id: 'name-asc', labelKey: 'sidebar.sort.nameAsc' },
    { id: 'name-desc', labelKey: 'sidebar.sort.nameDesc' },
    { id: 'mtime-desc', labelKey: 'sidebar.sort.mtimeDesc' },
    { id: 'mtime-asc', labelKey: 'sidebar.sort.mtimeAsc' },
    { id: 'ctime-desc', labelKey: 'sidebar.sort.ctimeDesc' },
    { id: 'ctime-asc', labelKey: 'sidebar.sort.ctimeAsc' },
  ];
  let newFileShortcutLabel = $derived(formatShortcut(shortcutsStore.get('new-file')));
  let switchProjectShortcutLabel = $derived(`${formatShortcut('Cmd+1')}~9`);
  let revealInFileManagerLabelKey = $derived(fileManagerLabelKey());

  function selectSort(mode: SortMode) {
    projectStore.setSortMode(mode);
    sortMenuOpen = false;
  }

  $effect(() => {
    if (!sortMenuOpen) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-testid="sidebar-sort-menu"], [data-testid="sidebar-sort-button"]')) {
        sortMenuOpen = false;
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });

  interface Props {
    onOpenProjectFromPath: (path: string) => Promise<void>;
    recentProjects?: RecentProject[];
    onRemoveRecentProject?: (path: string) => void;
    onRefreshRecentProjects?: () => void;
    openSwitcherTrigger?: number;
  }
  let {
    onOpenProjectFromPath,
    recentProjects = [],
    onRemoveRecentProject,
    onRefreshRecentProjects,
    openSwitcherTrigger = 0,
  }: Props = $props();

  // External trigger: when `openSwitcherTrigger` changes, open the popup.
  // Skip the initial run so the popup doesn't auto-open on mount.
  let lastSeenTrigger = $state<number | null>(null);
  $effect(() => {
    const current = openSwitcherTrigger;
    if (lastSeenTrigger === null) {
      lastSeenTrigger = current;
      return;
    }
    if (current !== lastSeenTrigger) {
      lastSeenTrigger = current;
      switcherOpen = true;
    }
  });

  function toggleSwitcher(e: MouseEvent) {
    // Stop propagation so the window-level onclick handler (which closes
    // the switcher on any outside click) doesn't immediately reset this.
    e.stopPropagation();
    switcherOpen = !switcherOpen;
  }

  async function switchToProject(path: string) {
    switcherOpen = false;
    await openProjectFromPath(path);
  }

  async function removeProject(e: Event, path: string) {
    e.stopPropagation();
    await commands.removeRecentProject(path);
    onRemoveRecentProject?.(path);
  }

  async function togglePinProject(e: Event, project: RecentProject) {
    e.stopPropagation();
    await commands.setProjectPinned(project.path, !project.pinned);
    onRefreshRecentProjects?.();
  }

  async function openProjectFromPath(dirPath: string) {
    await onOpenProjectFromPath(dirPath);
  }

  const textExtensions = ['.md', '.markdown', '.txt', '.canvas', '.kanban', '.json', '.jsonl', '.csv'];

  function isTextFile(name: string): boolean {
    return textExtensions.some(ext => name.toLowerCase().endsWith(ext))
      || extensionStore.getFileHandler(name) !== null;
  }

  function isCanvasFile(name: string): boolean {
    return name.toLowerCase().endsWith('.canvas');
  }

  let filesContainer = $state<HTMLDivElement | null>(null);

  let sortedFiles = $derived.by<FileNode[]>(() => {
    return [...projectStore.files].sort((a, b) =>
      compareByMode(a, b, projectStore.sortMode)
    );
  });

  // Reset scroll position when project changes
  $effect(() => {
    projectStore.dirPath;  // track dependency
    if (filesContainer) filesContainer.scrollTop = 0;
  });

  // --- Refresh file list ---
  async function refreshFiles() {
    if (!projectStore.dirPath) return;
    const result = await commands.listDirectory(projectStore.dirPath, projectStore.showHiddenFiles);
    if (result.status === 'ok') {
      projectStore.updateFiles(result.data);
    }
  }

  // --- Open folder ---
  async function openDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    await onOpenProjectFromPath(selected as string);
  }

  // --- Open file ---
  async function openFile(entry: FileNode) {
    if (entry.is_dir || !isTextFile(entry.name)) return;

    // Always read full content. Editor decides mode based on size.
    const result = await commands.readFile(entry.path);
    if (result.status === 'ok') {
      tabsStore.openTab(entry.path, result.data);
    } else {
      return;
    }
    await commands.registerOpenFile(entry.path);
  }

  async function openInOtherPane(entry: FileNode) {
    closeContextMenu();
    if (entry.is_dir || !isTextFile(entry.name)) return;
    const result = await commands.readFile(entry.path);
    if (result.status !== 'ok') return;
    // Target the column to the right of the active one, creating it if this is
    // still a single pane (falling back to the active pane at the column cap).
    const panes = tabsStore.panes;
    const activeIdx = panes.findIndex(p => p.id === tabsStore.activePaneId);
    let targetId: string;
    if (panes.length === 1) {
      targetId = tabsStore.createPane(activeIdx + 1) ?? panes[0].id;
    } else {
      targetId = panes[Math.min(activeIdx + 1, panes.length - 1)].id;
    }
    tabsStore.openTabInPane(targetId, entry.path, result.data);
    tabsStore.setActivePane(targetId);
    await commands.registerOpenFile(entry.path);
  }

  // --- New file inline input ---
  let creatingFile = $state(false);
  let creatingFolder = $state(false);
  let newItemName = $state('');
  let newItemInput = $state<HTMLInputElement | null>(null);

  async function startCreateFile() {
    creatingFile = true;
    creatingFolder = false;
    // Seed the inline input with the smart name from settings
    // (date/time macros + {N} numbering inferred from siblings) so the
    // sidebar "+" matches Cmd+N's naming, instead of always "untitled.md".
    newItemName = projectStore.dirPath
      ? await proposeNewFileName(projectStore.dirPath)
      : 'untitled.md';
    await tick();
    if (newItemInput) {
      newItemInput.focus();
      // Select name without extension
      const dotIdx = newItemName.lastIndexOf('.');
      newItemInput.setSelectionRange(0, dotIdx > 0 ? dotIdx : newItemName.length);
    }
  }

  async function startCreateFolder() {
    creatingFolder = true;
    creatingFile = false;
    newItemName = 'new-folder';
    await tick();
    if (newItemInput) {
      newItemInput.focus();
      newItemInput.select();
    }
  }

  async function confirmCreate() {
    if (!newItemName.trim() || !projectStore.dirPath) {
      cancelCreate();
      return;
    }
    if (creatingFile) {
      const templateRaw = currentFilenameTemplateRaw();
      const result = await commands.createFile(projectStore.dirPath, newItemName.trim());
      if (result.status === 'ok') {
        void settingsStore.recordLastUsedDir(projectStore.dirPath);
        await persistManagedNameEnrollment(
          projectStore.dirPath,
          result.data,
          templateRaw,
          '',
          'Managed-name enrollment failed during sidebar header new-file creation',
        );
        await refreshFiles();
        // Open the new file
        const readResult = await commands.readFile(result.data);
        if (readResult.status === 'ok') {
          tabsStore.openTab(result.data, readResult.data, { justCreated: true });
          await commands.registerOpenFile(result.data);
        }
      } else {
        console.error('Failed to create file:', result.error);
      }
    } else if (creatingFolder) {
      const result = await commands.createDirectory(projectStore.dirPath, newItemName.trim());
      if (result.status === 'ok') {
        await refreshFiles();
      } else {
        console.error('Failed to create folder:', result.error);
      }
    }
    cancelCreate();
  }

  function cancelCreate() {
    creatingFile = false;
    creatingFolder = false;
    newItemName = '';
  }

  /**
   * Create a file directly inside `targetDir` with an auto-numbered default
   * name, then kick off inline rename on the new node so the user can type
   * the real name. `targetDir` may be the project root or any folder.
   */
  async function createFileAt(targetDir: string, ext: string = '.md') {
    closeContextMenu();
    closeViewMenu();
    const templateRaw = currentFilenameTemplateRaw();
    const proposedName = await proposeNewFileName(targetDir, ext === '.md' ? undefined : ext);
    const result = await commands.createFile(targetDir, proposedName);
    if (result.status !== 'ok') {
      console.error('Failed to create file:', result.error);
      return;
    }
    void settingsStore.recordLastUsedDir(targetDir);
    const enrollment = projectStore.dirPath
      ? await persistManagedNameEnrollment(
        projectStore.dirPath,
        result.data,
        templateRaw,
        '',
        'Managed-name enrollment failed during sidebar context-menu new-file creation',
      )
      : 'not-applicable';
    if (targetDir !== projectStore.dirPath) {
      await projectStore.expandFolder(targetDir);
    }
    await projectStore.refreshFolder(targetDir);
    const newNode = findTreeNodeByPath(result.data);
    if (newNode && enrollment !== 'failed') startRename(newNode);
  }

  /**
   * File-handler plugins registered via extension manifest (e.g. canvas, kanban).
   * Each entry yields a "New {label}" item in the sidebar right-click menus,
   * creating an empty file with the plugin's primary registered extension.
   */
  const pluginFileCreators = $derived.by(() => {
    return extensionStore.fileHandlers
      .filter(h => h.fileExtensions && h.fileExtensions.length > 0)
      .map(h => ({
        pluginId: h.pluginId,
        label: h.label,
        ext: h.fileExtensions![0],
      }));
  });

  async function expandAllAt(targetDir: string) {
    closeContextMenu();
    closeViewMenu();
    await projectStore.expandFolderRecursive(targetDir);
  }

  function collapseAllAt(targetDir: string) {
    closeContextMenu();
    closeViewMenu();
    projectStore.collapseFolderRecursive(targetDir);
  }

  async function createFolderAt(targetDir: string) {
    closeContextMenu();
    closeViewMenu();
    const result = await commands.createDirectory(targetDir, 'new-folder');
    if (result.status !== 'ok') {
      console.error('Failed to create folder:', result.error);
      return;
    }
    if (targetDir !== projectStore.dirPath) {
      await projectStore.expandFolder(targetDir);
    }
    await projectStore.refreshFolder(targetDir);
    const newNode = findTreeNodeByPath(result.data);
    if (newNode) startRename(newNode);
  }

  /** DFS through projectStore.files to locate a node by exact path. */
  function findTreeNodeByPath(path: string): FileNode | null {
    function walk(nodes: FileNode[]): FileNode | null {
      for (const n of nodes) {
        if (n.path === path) return n;
        if (n.children) {
          const hit = walk(n.children);
          if (hit) return hit;
        }
      }
      return null;
    }
    return walk(projectStore.files);
  }

  function handleCreateKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelCreate();
    }
  }

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  // --- Blank-area view menu (right-click on empty sidebar space) ---
  let viewMenu = $state<{ x: number; y: number } | null>(null);

  function handleViewContextMenu(e: MouseEvent) {
    // Only fire when the click lands on the empty sidebar region, not on a
    // file row or any interactive element. Each file row has its own
    // `oncontextmenu` handler that already stops propagation.
    const target = e.target as HTMLElement;
    if (target.closest('.sidebar-input-row, .tree-row')) return;
    e.preventDefault();
    closeContextMenu();
    const zoom = parseFloat(document.documentElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1');
    viewMenu = { x: e.clientX / zoom, y: e.clientY / zoom };
  }

  function closeViewMenu() {
    viewMenu = null;
  }

  async function toggleHiddenFiles() {
    await settingsStore.writeView({
      show_hidden_files: !settingsStore.effective.view.show_hidden_files,
    });
    closeViewMenu();
    // Re-fetch root so the tree reflects the new filter immediately.
    if (projectStore.dirPath) {
      await projectStore.refreshFolder(projectStore.dirPath);
    }
  }

  // --- Context menu ---
  let contextMenu = $state<{ x: number; y: number; entry: FileNode } | null>(null);
  let contextManagedName = $state<ManagedNameLoadResult | null>(null);
  let renaming = $state<FileNode | null>(null);
  let renameValue = $state('');

  function handleContextMenu(e: MouseEvent, entry: FileNode) {
    e.preventDefault();
    const zoom = parseFloat(document.documentElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1');
    contextMenu = { x: e.clientX / zoom, y: e.clientY / zoom, entry };
    contextManagedName = null;
    if (!entry.is_dir && projectStore.dirPath && isTextFile(entry.name)) {
      void loadManagedName(projectStore.dirPath, entry.path).then((state) => {
        if (contextMenu?.entry.path === entry.path) contextManagedName = state;
      });
    }
  }

  function closeContextMenu() {
    contextMenu = null;
    contextManagedName = null;
  }

  async function stopAutoNaming(entry: FileNode) {
    if (!projectStore.dirPath || contextManagedName?.kind !== 'ready') return;
    const result = await persistStopAutoNamingMenuAction(
      projectStore.dirPath,
      entry.path,
      contextManagedName.state,
      detachManagedName,
    );
    if (result.kind !== 'persisted') return;
    contextManagedName = { kind: 'ready', state: result.state };
    closeContextMenu();
  }

  async function reEnableAutoNaming(entry: FileNode) {
    if (!projectStore.dirPath || contextManagedName?.kind !== 'ready') return;
    const result = await persistReEnableAutoNamingMenuAction(
      projectStore.dirPath,
      entry.path,
      contextManagedName.state,
      reEnableManagedName,
    );
    if (result.kind !== 'persisted') return;
    contextManagedName = { kind: 'ready', state: result.state };
    closeContextMenu();
    const openTab = tabsStore.findByPath(entry.path);
    const content = openTab?.content ?? (await commands.readFile(entry.path).then(r => r.status === 'ok' ? r.data : null));
    if (typeof content === 'string') {
      await tabsStore.tryRenameAfterSave(entry.path, content, { reconcileCurrentH1: true });
    }
  }

  function startRename(entry: FileNode) {
    closeContextMenu();
    renaming = entry;
    renameValue = entry.name;
  }

  async function confirmRename() {
    if (!renaming || !renameValue.trim() || renameValue === renaming.name) {
      cancelRename();
      return;
    }
    const oldPath = renaming.path;
    const oldParent = pathDirname(oldPath);
    const result = await renameItemAfterSidecarFlush(projectStore.dirPath, renaming.path, renameValue.trim(), null);
    if (result.status === 'ok') {
      const newPath = result.data.new_path;
      await tabsStore.retargetOpenPathTree(oldPath, newPath, { broadcast: false });
      const newParent = pathDirname(newPath);
      if (oldParent) await projectStore.refreshFolder(oldParent);
      if (newParent && newParent !== oldParent) await projectStore.refreshFolder(newParent);
    } else {
      console.error('Failed to rename:', result.error);
    }
    cancelRename();
  }

  function cancelRename() {
    renaming = null;
    renameValue = '';
  }

  function handleRenameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirmRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  }

  async function revealInFinder(entry: FileNode) {
    closeContextMenu();
    await commands.revealInFileManager(entry.path);
  }

  async function copyPath(entry: FileNode) {
    closeContextMenu();
    await navigator.clipboard.writeText(entry.path);
  }

  async function copyRelativePath(entry: FileNode) {
    closeContextMenu();
    const base = projectStore.dirPath;
    if (base && entry.path.startsWith(base)) {
      const rel = entry.path.slice(base.length).replace(/^\//, '');
      await navigator.clipboard.writeText(rel);
    } else {
      await navigator.clipboard.writeText(entry.path);
    }
  }

  async function handleDuplicate(entry: FileNode) {
    closeContextMenu();
    const result = await commands.duplicateFile(entry.path);
    if (result.status === 'ok') {
      await refreshFiles();
      // Open the duplicate
      const readResult = await commands.readFile(result.data);
      if (readResult.status === 'ok') {
        tabsStore.openTab(result.data, readResult.data);
        await commands.registerOpenFile(result.data);
      }
    } else {
      console.error('Failed to duplicate file:', result.error);
    }
  }

  async function handleDelete(entry: FileNode) {
    closeContextMenu();
    const confirmed = confirm(t('sidebar.deleteConfirm', { name: entry.name }));
    if (!confirmed) return;

    const openTabs = tabsStore.allTabs.filter(tab =>
      tab.filePath === entry.path || pathStartsWithChild(tab.filePath, entry.path)
    );
    for (const tab of openTabs) {
      const pathBeforeClose = tab.filePath;
      await tabsStore.closeTab(tab.id);
      if (tabsStore.findByPath(pathBeforeClose)) {
        return;
      }
    }

    const result = await commands.deleteItem(entry.path);
    if (result.status === 'ok') {
      projectStore.removeWorkspacePath(entry.path);
      await refreshFiles();
    } else {
      console.error('Failed to delete:', result.error);
    }
  }

  // --- Drag-drop ---
  let draggedNode = $state<FileNode | null>(null);

  function handleDragStart(e: DragEvent, node: FileNode) {
    if (!e.dataTransfer) return;
    draggedNode = node;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(SIDEBAR_PATH_MIME, node.path);
    e.dataTransfer.setData('text/plain', node.path);
    // Files (not folders) light up pane drop overlays in App.svelte.
    if (!node.is_dir && isTextFile(node.name)) {
      uiStore.sidebarFileDragActive = true;
    }
  }

  function handleDragEnd() {
    if (draggedNode) {
      // Clear any dragOver flags along the path from root to the node's deepest folder.
      clearAllDragOverFlags(projectStore.files);
    }
    draggedNode = null;
    rootDragOver = false;
    uiStore.sidebarFileDragActive = false;
  }

  function clearAllDragOverFlags(nodes: FileNode[]) {
    for (const n of nodes) {
      if (n.dragOver) n.dragOver = false;
      if (n.children) clearAllDragOverFlags(n.children);
    }
  }

  function isDescendant(source: FileNode, targetPath: string): boolean {
    if (!source.is_dir) return false;
    return targetPath === source.path || pathStartsWithChild(targetPath, source.path);
  }

  function handleDragOverFolder(e: DragEvent, target: FileNode) {
    if (!draggedNode) return;
    if (!target.is_dir) return;
    if (isDescendant(draggedNode, target.path)) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    target.dragOver = true;
  }

  function handleDragLeaveFolder(_e: DragEvent, target: FileNode) {
    target.dragOver = false;
  }

  async function handleDropOnFolder(e: DragEvent, target: FileNode) {
    e.preventDefault();
    target.dragOver = false;
    const source = draggedNode;
    draggedNode = null;
    if (!source || !target.is_dir) return;
    if (isDescendant(source, target.path)) return;
    if (source.path === target.path) return;

    const parentPath = pathDirname(source.path);
    if (!parentPath || parentPath === target.path) return; // no-op: already in that folder

    const result = await moveItemAfterSidecarFlush(
      projectStore.dirPath,
      source.path,
      target.path,
    );
    if (result.status !== 'ok') {
      console.error('Move failed:', result.error);
      return;
    }
    const newPath = result.data.new_path;

    await tabsStore.retargetOpenPathTree(source.path, newPath, { broadcast: false });

    await projectStore.refreshFolder(parentPath);
    await projectStore.refreshFolder(target.path);
  }

  // Root drop zone handlers (drop onto empty sidebar area = move to project root).
  let rootDragOver = $state(false);

  function handleDragOverRoot(e: DragEvent) {
    // If a child folder's handler already accepted the drop, don't steal focus/highlight.
    if (e.defaultPrevented) {
      rootDragOver = false;
      return;
    }
    if (!draggedNode || !projectStore.dirPath) return;
    const parentPath = pathDirname(draggedNode.path);
    if (!parentPath || parentPath === projectStore.dirPath) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    rootDragOver = true;
  }

  function handleDragLeaveRoot() { rootDragOver = false; }

  async function handleDropOnRoot(e: DragEvent) {
    e.preventDefault();
    rootDragOver = false;
    const source = draggedNode;
    draggedNode = null;
    if (!source || !projectStore.dirPath) return;
    const parentPath = pathDirname(source.path);
    if (!parentPath || parentPath === projectStore.dirPath) return;

    const result = await moveItemAfterSidecarFlush(
      projectStore.dirPath,
      source.path,
      projectStore.dirPath,
    );
    if (result.status !== 'ok') {
      console.error('Move failed:', result.error);
      return;
    }
    const newPath = result.data.new_path;
    await tabsStore.retargetOpenPathTree(source.path, newPath, { broadcast: false });
    await projectStore.refreshFolder(parentPath);
    await projectStore.refreshFolder(projectStore.dirPath);
  }
</script>

<!-- Close context menu and project switcher on click anywhere -->
<svelte:window
  onclick={() => { closeContextMenu(); closeViewMenu(); switcherOpen = false; sortMenuOpen = false; }}
  ondragend={handleDragEnd}
/>

<aside class="sidebar" data-testid="sidebar" style="--novelist-sidebar-file-font-size: {projectStore.sidebarFontSize}px;">
  <!-- Project header -->
  <div class="sidebar-header" data-tauri-drag-region>
    {#if projectStore.isOpen}
      <span class="sidebar-project-name">{projectStore.name}</span>
      <div class="sidebar-actions">
        <div class="sidebar-sort-wrap">
          <button
            type="button"
            class="sidebar-icon-btn"
            data-testid="sidebar-sort-button"
            title={t('sidebar.sort.button')}
            aria-label={t('sidebar.sort.button')}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            onclick={(e) => { e.stopPropagation(); sortMenuOpen = !sortMenuOpen; }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2"/></svg>
          </button>
          {#if sortMenuOpen}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="sidebar-sort-menu"
              data-testid="sidebar-sort-menu"
              role="menu"
              tabindex="-1"
              onclick={(e) => e.stopPropagation()}
            >
              {#each sortOptions as opt (opt.id)}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={projectStore.sortMode === opt.id}
                  class="sidebar-sort-item"
                  class:sidebar-sort-item-active={projectStore.sortMode === opt.id}
                  data-testid="sidebar-sort-{opt.id}"
                  onclick={() => selectSort(opt.id)}
                >
                  <span class="sidebar-sort-check">{projectStore.sortMode === opt.id ? '\u2713' : ''}</span>
                  <span class="sidebar-sort-label">{t(opt.labelKey)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <button class="sidebar-icon-btn" data-testid="sidebar-new-file" onclick={startCreateFile} title={t('sidebar.newFile', { shortcut: newFileShortcutLabel })}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="sidebar-icon-btn" data-testid="sidebar-new-folder" onclick={startCreateFolder} title={t('sidebar.newFolder')}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 5h4l2 2h6v6H2z"/></svg>
        </button>
      </div>
    {:else}
      <button class="sidebar-open-btn" data-testid="sidebar-open-folder" onclick={openDirectory}>{t('sidebar.openFolder')}</button>
    {/if}
  </div>

  {#if projectStore.isOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="sidebar-files"
      data-testid="sidebar-files"
      class:drag-over-root={rootDragOver}
      bind:this={filesContainer}
      ondragover={handleDragOverRoot}
      ondragleave={handleDragLeaveRoot}
      ondrop={handleDropOnRoot}
      oncontextmenu={handleViewContextMenu}
    >
      {#if creatingFile || creatingFolder}
        <div class="sidebar-input-row">
          <input
            bind:this={newItemInput}
            bind:value={newItemName}
            onkeydown={handleCreateKeydown}
            onblur={confirmCreate}
            class="sidebar-input"
            data-testid="sidebar-input"
            placeholder={creatingFolder ? t('sidebar.folderNamePlaceholder') : t('sidebar.fileNamePlaceholder')}
          />
        </div>
      {/if}

      {#each sortedFiles as entry (entry.path)}
        <FileTreeNode
          node={entry}
          depth={0}
          onContextMenu={handleContextMenu}
          onFileOpen={openFile}
          onRenameRequest={startRename}
          onDragStart={handleDragStart}
          onDragOver={handleDragOverFolder}
          onDragLeave={handleDragLeaveFolder}
          onDrop={handleDropOnFolder}
          {isTextFile}
          renamingPath={renaming?.path ?? null}
          {renameValue}
          onRenameInput={(value) => { renameValue = value; }}
          onRenameKeydown={handleRenameKeydown}
          onRenameBlur={confirmRename}
        />
      {/each}
    </div>

    <!-- Bottom bar: Notion-style project switcher -->
    <div class="sidebar-bottom" style="position: relative;">
      <button class="sidebar-switch-btn" data-testid="sidebar-switch-btn" onclick={toggleSwitcher} title={t('sidebar.switchProject', { shortcut: switchProjectShortcutLabel })}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h4l2 2h6v7H2z"/></svg>
        <span>{projectStore.dirPath ? (pathBasename(projectStore.dirPath) || 'Project') : 'Project'}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: auto; opacity: 0.5;"><path d="{switcherOpen ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}"/></svg>
      </button>

      {#if switcherOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="project-switcher" data-testid="project-switcher" onclick={(e) => e.stopPropagation()}>
          <div class="project-switcher-header">
            <span>{t('sidebar.projects')}</span>
          </div>
          {#each recentProjects as project, i (project.path)}
            <div
              class="project-switcher-row"
              class:project-switcher-row-active={project.path === projectStore.dirPath}
            >
              <button
                class="project-switcher-item"
                onclick={() => switchToProject(project.path)}
              >
                <span class="project-switcher-num">{i < 9 ? i + 1 : '·'}</span>
                <span class="project-switcher-name">{project.name}</span>
                {#if project.path === projectStore.dirPath}
                  <span class="project-switcher-check">&#x2713;</span>
                {/if}
              </button>
              <button
                class="project-switcher-action-btn"
                class:active={project.pinned}
                data-testid="project-switcher-pin-{i}"
                onclick={(e) => togglePinProject(e, project)}
                title={project.pinned ? t('welcome.unpinProject') : t('welcome.pinProject')}
                aria-label={project.pinned ? t('welcome.unpinProject') : t('welcome.pinProject')}
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill={project.pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 2l4 4-3 1-1 4-4-4 4-1 0-4zM6 10l-3 4"/>
                </svg>
              </button>
              <button
                class="project-switcher-action-btn project-switcher-remove-btn"
                onclick={(e) => removeProject(e, project.path)}
                title={t('sidebar.removeProject')}
                aria-label={t('sidebar.removeProject')}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
              </button>
            </div>
          {/each}
          <div class="project-switcher-divider"></div>
          <div class="project-switcher-row">
            <button class="project-switcher-item" onclick={() => { switcherOpen = false; openDirectory(); }}>
              <span class="project-switcher-num">+</span>
              <span class="project-switcher-name">{t('sidebar.openFolderEllipsis')}</span>
            </button>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="sidebar-empty">
      <p>{t('sidebar.noProject')}</p>
      <button class="sidebar-open-btn" onclick={openDirectory}>{t('sidebar.openFolder')}</button>
    </div>
  {/if}
</aside>

{#if viewMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="context-menu"
    data-testid="sidebar-view-menu"
    use:portal
    style="left: {viewMenu.x}px; top: {viewMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    {#if projectStore.dirPath}
      <button
        role="menuitem"
        class="context-menu-item"
        data-testid="sidebar-view-new-file"
        onclick={() => createFileAt(projectStore.dirPath!)}
      >{t('sidebar.menu.newFile')}</button>
      {#each pluginFileCreators as creator (creator.pluginId)}
        <button
          role="menuitem"
          class="context-menu-item"
          data-testid="sidebar-view-new-{creator.pluginId}"
          onclick={() => createFileAt(projectStore.dirPath!, creator.ext)}
        >{t('sidebar.menu.newFileOfType', { type: creator.label })}</button>
      {/each}
      <button
        role="menuitem"
        class="context-menu-item"
        data-testid="sidebar-view-new-folder"
        onclick={() => createFolderAt(projectStore.dirPath!)}
      >{t('sidebar.menu.newFolder')}</button>
      <div class="context-menu-separator"></div>
      <button
        role="menuitem"
        class="context-menu-item"
        data-testid="sidebar-view-expand-all"
        onclick={() => expandAllAt(projectStore.dirPath!)}
      >{t('sidebar.menu.expandAll')}</button>
      <button
        role="menuitem"
        class="context-menu-item"
        data-testid="sidebar-view-collapse-all"
        onclick={() => collapseAllAt(projectStore.dirPath!)}
      >{t('sidebar.menu.collapseAll')}</button>
      <div class="context-menu-separator"></div>
    {/if}
    <button
      role="menuitem"
      class="context-menu-item"
      data-testid="sidebar-view-toggle-hidden"
      onclick={toggleHiddenFiles}
    >{settingsStore.effective.view.show_hidden_files ? t('sidebar.view.hideHidden') : t('sidebar.view.showHidden')}</button>
  </div>
{/if}

{#if contextMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="context-menu"
    data-testid="context-menu"
    use:portal
    style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    {#if contextMenu.entry.is_dir}
      <button role="menuitem" class="context-menu-item" data-testid="context-menu-new-file" onclick={() => createFileAt(contextMenu!.entry.path)}>{t('sidebar.menu.newFileHere')}</button>
      {#each pluginFileCreators as creator (creator.pluginId)}
        <button
          role="menuitem"
          class="context-menu-item"
          data-testid="context-menu-new-{creator.pluginId}"
          onclick={() => createFileAt(contextMenu!.entry.path, creator.ext)}
        >{t('sidebar.menu.newFileOfTypeHere', { type: creator.label })}</button>
      {/each}
      <button role="menuitem" class="context-menu-item" data-testid="context-menu-new-folder" onclick={() => createFolderAt(contextMenu!.entry.path)}>{t('sidebar.menu.newFolderHere')}</button>
      <div class="context-menu-separator"></div>
      <button role="menuitem" class="context-menu-item" data-testid="context-menu-expand-all" onclick={() => expandAllAt(contextMenu!.entry.path)}>{t('sidebar.menu.expandAll')}</button>
      <button role="menuitem" class="context-menu-item" data-testid="context-menu-collapse-all" onclick={() => collapseAllAt(contextMenu!.entry.path)}>{t('sidebar.menu.collapseAll')}</button>
      <div class="context-menu-separator"></div>
    {/if}
    {#if !contextMenu.entry.is_dir && isTextFile(contextMenu.entry.name)}
      <button role="menuitem" class="context-menu-item" onclick={() => openInOtherPane(contextMenu!.entry)}>{t('sidebar.openInOtherPane')}</button>
    {/if}
    <button role="menuitem" class="context-menu-item" onclick={() => revealInFinder(contextMenu!.entry)}>{t(revealInFileManagerLabelKey)}</button>
    <button role="menuitem" class="context-menu-item" onclick={() => copyPath(contextMenu!.entry)}>{t('sidebar.copyPath')}</button>
    <button role="menuitem" class="context-menu-item" onclick={() => copyRelativePath(contextMenu!.entry)}>{t('sidebar.copyRelativePath')}</button>
    {#if !contextMenu.entry.is_dir}
      <button role="menuitem" class="context-menu-item" onclick={() => handleDuplicate(contextMenu!.entry)}>{t('sidebar.duplicate')}</button>
    {/if}
    {#if !contextMenu.entry.is_dir && contextManagedName?.kind === 'ready'}
      {#if contextManagedName.state.status === 'managed'}
        <button role="menuitem" class="context-menu-item context-menu-item-with-icon" data-testid="context-menu-stop-auto-naming" onclick={() => stopAutoNaming(contextMenu!.entry)}>
          <svg class="context-menu-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h4"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="M2 2l20 20"/></svg>
          <span>{t('sidebar.stopAutoNaming')}</span>
        </button>
      {:else}
        <button role="menuitem" class="context-menu-item context-menu-item-with-icon" data-testid="context-menu-reenable-auto-naming" onclick={() => reEnableAutoNaming(contextMenu!.entry)}>
          <svg class="context-menu-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2"/><path d="M18 2v4h-4"/><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M6 22v-4h4"/></svg>
          <span>{t('sidebar.reenableAutoNaming')}</span>
        </button>
      {/if}
    {/if}
    <div class="context-menu-separator"></div>
    <button role="menuitem" class="context-menu-item" data-testid="context-menu-rename" onclick={() => startRename(contextMenu!.entry)}>{t('sidebar.rename')}</button>
    <button role="menuitem" class="context-menu-item context-menu-item-danger" onclick={() => handleDelete(contextMenu!.entry)}>{t('sidebar.delete')}</button>
  </div>
{/if}

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--novelist-sidebar-bg);
    color: var(--novelist-sidebar-text);
    font-family: var(--novelist-sidebar-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    padding-top: 2.25rem;
    -webkit-app-region: drag;
    user-select: none;
  }

  .sidebar-project-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--novelist-text);
    letter-spacing: 0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    -webkit-app-region: no-drag;
  }

  .sidebar-sort-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .sidebar-sort-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 180px;
    padding: 4px;
    border-radius: 8px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    z-index: 50;
  }

  .sidebar-sort-item {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text);
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
  }
  .sidebar-sort-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .sidebar-sort-item-active {
    color: var(--novelist-accent);
  }
  .sidebar-sort-check {
    display: inline-flex;
    justify-content: center;
    width: 12px;
    color: var(--novelist-accent);
    flex-shrink: 0;
  }
  .sidebar-sort-label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    cursor: pointer;
    transition: background 100ms, color 100ms;
  }
  .sidebar-icon-btn:hover {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-accent);
  }

  .sidebar-open-btn {
    width: 100%;
    padding: 6px 12px;
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    transition: border-color 100ms, color 100ms;
    -webkit-app-region: no-drag;
  }
  .sidebar-open-btn:hover {
    border-color: var(--novelist-accent);
    color: var(--novelist-text);
  }

  .sidebar-files {
    flex: 1;
    overflow-y: auto;
    padding: 6px 6px;
  }
  .sidebar-files.drag-over-root {
    box-shadow: inset 0 0 0 2px var(--novelist-accent);
  }

  .sidebar-input-row {
    padding: 2px 6px;
  }
  .sidebar-input {
    width: 100%;
    padding: 4px 8px;
    border: 1px solid var(--novelist-accent);
    border-radius: 5px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font-size: var(--novelist-sidebar-file-font-size, 14px);
    line-height: var(--novelist-sidebar-file-line-height, 1.35);
    font-family: var(--novelist-sidebar-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    outline: none;
  }

  .sidebar-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 12px;
    padding: 24px;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
  }

  /* .context-menu, .context-menu-item, .context-menu-separator styles
     live in app/app.css so they are available everywhere, including
     zen mode where the sidebar isn't mounted. */

  /* Bottom project switch bar */
  .sidebar-bottom {
    padding: 6px 8px;
    border-top: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    -webkit-app-region: no-drag;
  }

  .sidebar-switch-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 0.72rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
    white-space: nowrap;
    overflow: hidden;
  }
  .sidebar-switch-btn span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sidebar-switch-btn:hover {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-text);
  }

  /* Notion-style project switcher popup */
  .project-switcher {
    position: absolute;
    bottom: 100%;
    left: 8px;
    right: 8px;
    margin-bottom: 4px;
    padding: 4px;
    border-radius: 8px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.12);
    z-index: 40;
    max-height: 360px;
    overflow-y: auto;
  }

  .project-switcher-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px 4px;
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
  }

  .project-switcher-row {
    display: flex;
    align-items: center;
    position: relative;
    padding-right: 4px;
    border-radius: 5px;
    transition: background 80ms;
  }
  .project-switcher-row:hover {
    background: var(--novelist-sidebar-hover);
  }
  .project-switcher-row-active {
    background: var(--novelist-sidebar-active);
  }

  .project-switcher-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-tertiary, #b0b0b0);
    cursor: pointer;
    flex-shrink: 0;
    margin-left: 1px;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
  }
  .project-switcher-row:hover .project-switcher-action-btn,
  .project-switcher-action-btn.active {
    opacity: 1;
  }
  .project-switcher-action-btn:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
  .project-switcher-action-btn.active {
    color: var(--novelist-accent);
  }
  .project-switcher-remove-btn:hover {
    color: #e5484d;
    background: #e5484d12;
  }

  .project-switcher-item {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text);
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
  }

  .project-switcher-num {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    background: var(--novelist-bg-tertiary);
    color: var(--novelist-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
    flex-shrink: 0;
  }

  .project-switcher-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-switcher-check {
    margin-left: auto;
    color: var(--novelist-accent);
    font-size: 0.78rem;
    flex-shrink: 0;
  }

  .project-switcher-divider {
    height: 1px;
    margin: 4px 8px;
    background: var(--novelist-border-subtle, var(--novelist-border));
  }
</style>
