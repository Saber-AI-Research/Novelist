<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import type { RecentProject } from '$lib/ipc/commands';
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { t } from '$lib/i18n';
  import FileTreeNode from '$lib/components/FileTreeNode.svelte';
  import { compareByMode } from '$lib/utils/file-sort';

  // --- Project switcher popup (Notion-style) ---
  let switcherOpen = $state(false);

  interface Props {
    onOpenProjectFromPath?: (path: string) => void;
    recentProjects?: RecentProject[];
    onRemoveRecentProject?: (path: string) => void;
  }
  let { onOpenProjectFromPath, recentProjects = [], onRemoveRecentProject }: Props = $props();

  function toggleSwitcher() {
    switcherOpen = !switcherOpen;
  }

  async function switchToProject(path: string) {
    switcherOpen = false;
    if (path === projectStore.dirPath) return;
    await openProjectFromPath(path);
  }

  async function removeProject(e: Event, path: string) {
    e.stopPropagation();
    await commands.removeRecentProject(path);
    onRemoveRecentProject?.(path);
  }

  async function openProjectFromPath(dirPath: string) {
    if (onOpenProjectFromPath) {
      onOpenProjectFromPath(dirPath);
      return;
    }
    if (projectStore.isOpen) {
      const dirty = tabsStore.dirtyTabs;
      if (dirty.length > 0) {
        const names = dirty.map(t => t.fileName).join(', ');
        if (confirm(t('dialog.unsavedBeforeClose', { names }))) {
          await tabsStore.saveAllDirty();
        }
      }
    }
    projectStore.isLoading = true;
    await commands.stopFileWatcher();
    const configResult = await commands.detectProject(dirPath);
    const config = configResult.status === 'ok' ? configResult.data : null;
    const filesResult = await commands.listDirectory(dirPath);
    const files = filesResult.status === 'ok' ? filesResult.data : [];
    projectStore.setProject(dirPath, config, files);
    tabsStore.closeAll();
    const name = config?.project?.name || dirPath.split('/').pop() || 'Untitled';
    await commands.addRecentProject(dirPath, name);
    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') console.error('Failed to start file watcher:', watchResult.error);
  }

  const textExtensions = ['.md', '.markdown', '.txt', '.canvas', '.json', '.jsonl', '.csv'];

  function isTextFile(name: string): boolean {
    return textExtensions.some(ext => name.toLowerCase().endsWith(ext));
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
    const result = await commands.listDirectory(projectStore.dirPath);
    if (result.status === 'ok') {
      projectStore.updateFiles(result.data);
    }
  }

  // --- Open folder ---
  async function openDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const dirPath = selected as string;
    if (onOpenProjectFromPath) {
      onOpenProjectFromPath(dirPath);
      return;
    }
    projectStore.isLoading = true;
    await commands.stopFileWatcher();
    const configResult = await commands.detectProject(dirPath);
    const config = configResult.status === 'ok' ? configResult.data : null;
    const filesResult = await commands.listDirectory(dirPath);
    const files = filesResult.status === 'ok' ? filesResult.data : [];
    projectStore.setProject(dirPath, config, files);
    tabsStore.closeAll();
    const name = config?.project?.name || dirPath.split('/').pop() || 'Untitled';
    await commands.addRecentProject(dirPath, name);
    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') {
      console.error('Failed to start file watcher:', watchResult.error);
    }
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
    // Determine the "other" pane
    const currentPane = tabsStore.activePaneId;
    const otherPane = currentPane === 'pane-1' ? 'pane-2' : 'pane-1';
    // Ensure split is active
    if (!tabsStore.splitActive) tabsStore.toggleSplit();
    const result = await commands.readFile(entry.path);
    if (result.status === 'ok') {
      tabsStore.openTabInPane(otherPane, entry.path, result.data);
      await commands.registerOpenFile(entry.path);
    }
  }

  // --- New file inline input ---
  let creatingFile = $state(false);
  let creatingFolder = $state(false);
  let newItemName = $state('');
  let newItemInput = $state<HTMLInputElement | null>(null);

  function startCreateFile() {
    creatingFile = true;
    creatingFolder = false;
    newItemName = 'untitled.md';
    // Focus after DOM update
    requestAnimationFrame(() => {
      if (newItemInput) {
        newItemInput.focus();
        // Select name without extension
        const dotIdx = newItemName.lastIndexOf('.');
        newItemInput.setSelectionRange(0, dotIdx > 0 ? dotIdx : newItemName.length);
      }
    });
  }

  function startCreateFolder() {
    creatingFolder = true;
    creatingFile = false;
    newItemName = 'new-folder';
    requestAnimationFrame(() => {
      if (newItemInput) {
        newItemInput.focus();
        newItemInput.select();
      }
    });
  }

  async function confirmCreate() {
    if (!newItemName.trim() || !projectStore.dirPath) {
      cancelCreate();
      return;
    }
    if (creatingFile) {
      const result = await commands.createFile(projectStore.dirPath, newItemName.trim());
      if (result.status === 'ok') {
        await refreshFiles();
        // Open the new file
        const readResult = await commands.readFile(result.data);
        if (readResult.status === 'ok') {
          tabsStore.openTab(result.data, readResult.data);
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

  // --- Context menu ---
  let contextMenu = $state<{ x: number; y: number; entry: FileNode } | null>(null);
  let renaming = $state<FileNode | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);

  function handleContextMenu(e: MouseEvent, entry: FileNode) {
    e.preventDefault();
    const zoom = parseFloat(document.documentElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1');
    contextMenu = { x: e.clientX / zoom, y: e.clientY / zoom, entry };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function startRename(entry: FileNode) {
    closeContextMenu();
    renaming = entry;
    renameValue = entry.name;
    requestAnimationFrame(() => {
      if (renameInput) {
        renameInput.focus();
        const dotIdx = entry.name.lastIndexOf('.');
        renameInput.setSelectionRange(0, entry.is_dir ? entry.name.length : (dotIdx > 0 ? dotIdx : entry.name.length));
      }
    });
  }

  async function confirmRename() {
    if (!renaming || !renameValue.trim() || renameValue === renaming.name) {
      cancelRename();
      return;
    }
    const result = await commands.renameItem(renaming.path, renameValue.trim(), null);
    if (result.status === 'ok') {
      // Update any open tab referencing the old path
      const tab = tabsStore.findByPath(renaming.path);
      if (tab) {
        // Close old tab and reopen with new path
        const content = tab.content;
        tabsStore.closeTab(tab.id);
        tabsStore.openTab(result.data, content);
      }
      await refreshFiles();
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

    // Close any open tab for this file
    const tab = tabsStore.findByPath(entry.path);
    if (tab) {
      tabsStore.closeTab(tab.id);
    }

    const result = await commands.deleteItem(entry.path);
    if (result.status === 'ok') {
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
    e.dataTransfer.setData('application/x-novelist-path', node.path);
  }

  function handleDragEnd() {
    if (draggedNode) {
      // Clear any dragOver flags along the path from root to the node's deepest folder.
      clearAllDragOverFlags(projectStore.files);
    }
    draggedNode = null;
    rootDragOver = false;
  }

  function clearAllDragOverFlags(nodes: FileNode[]) {
    for (const n of nodes) {
      if (n.dragOver) n.dragOver = false;
      if (n.children) clearAllDragOverFlags(n.children);
    }
  }

  function isDescendant(source: FileNode, targetPath: string): boolean {
    if (!source.is_dir) return false;
    return targetPath === source.path || targetPath.startsWith(source.path + '/');
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

    const parentPath = source.path.slice(0, source.path.lastIndexOf('/'));
    if (parentPath === target.path) return; // no-op: already in that folder

    const result = await commands.moveItem(source.path, target.path);
    if (result.status !== 'ok') {
      console.error('Move failed:', result.error);
      return;
    }
    const newPath = result.data;

    // Update any open tab whose path starts with the moved source.
    for (const pane of tabsStore.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === source.path) {
          tabsStore.updateFilePath(tab.id, newPath);
        } else if (tab.filePath.startsWith(source.path + '/')) {
          tabsStore.updateFilePath(tab.id, newPath + tab.filePath.slice(source.path.length));
        }
      }
    }

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
    const parentPath = draggedNode.path.slice(0, draggedNode.path.lastIndexOf('/'));
    if (parentPath === projectStore.dirPath) {
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
    const parentPath = source.path.slice(0, source.path.lastIndexOf('/'));
    if (parentPath === projectStore.dirPath) return;

    const result = await commands.moveItem(source.path, projectStore.dirPath);
    if (result.status !== 'ok') {
      console.error('Move failed:', result.error);
      return;
    }
    const newPath = result.data;
    for (const pane of tabsStore.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === source.path || tab.filePath.startsWith(source.path + '/')) {
          const rest = tab.filePath.slice(source.path.length);
          tabsStore.updateFilePath(tab.id, newPath + rest);
        }
      }
    }
    await projectStore.refreshFolder(parentPath);
    await projectStore.refreshFolder(projectStore.dirPath);
  }
</script>

<!-- Close context menu and project switcher on click anywhere -->
<svelte:window
  onclick={() => { closeContextMenu(); switcherOpen = false; }}
  ondragend={handleDragEnd}
/>

<aside class="sidebar" data-testid="sidebar">
  <!-- Project header -->
  <div class="sidebar-header" data-tauri-drag-region>
    {#if projectStore.isOpen}
      <span class="sidebar-project-name">{projectStore.name}</span>
      <div class="sidebar-actions">
        <button class="sidebar-icon-btn" data-testid="sidebar-new-file" onclick={startCreateFile} title={t('sidebar.newFile')}>
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
      class:drag-over-root={rootDragOver}
      bind:this={filesContainer}
      ondragover={handleDragOverRoot}
      ondragleave={handleDragLeaveRoot}
      ondrop={handleDropOnRoot}
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
        {#if renaming && renaming.path === entry.path}
          <div class="sidebar-input-row">
            <input
              bind:this={renameInput}
              bind:value={renameValue}
              onkeydown={handleRenameKeydown}
              onblur={confirmRename}
              class="sidebar-input"
              data-testid="sidebar-input"
            />
          </div>
        {:else}
          <FileTreeNode
            node={entry}
            depth={0}
            onContextMenu={handleContextMenu}
            onFileOpen={openFile}
            onDragStart={handleDragStart}
            onDragOver={handleDragOverFolder}
            onDragLeave={handleDragLeaveFolder}
            onDrop={handleDropOnFolder}
            {isTextFile}
          />
        {/if}
      {/each}
    </div>

    <!-- Bottom bar: Notion-style project switcher -->
    <div class="sidebar-bottom" style="position: relative;">
      <button class="sidebar-switch-btn" onclick={toggleSwitcher} title={t('sidebar.switchProject')}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h4l2 2h6v7H2z"/></svg>
        <span>{projectStore.dirPath?.split('/').pop() ?? 'Project'}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="margin-left: auto; opacity: 0.5;"><path d="{switcherOpen ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}"/></svg>
      </button>

      {#if switcherOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="project-switcher" data-testid="project-switcher" onclick={(e) => e.stopPropagation()}>
          <div class="project-switcher-header">
            <span>{t('sidebar.projects')}</span>
          </div>
          {#each recentProjects.slice(0, 9) as project, i}
            <div class="project-switcher-row">
              <button
                class="project-switcher-item"
                class:project-switcher-item-active={project.path === projectStore.dirPath}
                onclick={() => switchToProject(project.path)}
              >
                <span class="project-switcher-num">{i + 1}</span>
                <span class="project-switcher-name">{project.name}</span>
                {#if project.path === projectStore.dirPath}
                  <span class="project-switcher-check">&#x2713;</span>
                {/if}
              </button>
              <button
                class="project-switcher-remove-btn"
                onclick={(e) => removeProject(e, project.path)}
                title={t('sidebar.removeProject')}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
              </button>
            </div>
          {/each}
          <div class="project-switcher-divider"></div>
          <button class="project-switcher-item" onclick={() => { switcherOpen = false; openDirectory(); }}>
            <span class="project-switcher-num">+</span>
            <span class="project-switcher-name">{t('sidebar.openFolderEllipsis')}</span>
          </button>
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
    {#if !contextMenu.entry.is_dir && isTextFile(contextMenu.entry.name)}
      <button role="menuitem" class="context-menu-item" onclick={() => openInOtherPane(contextMenu!.entry)}>{t('sidebar.openInOtherPane')}</button>
    {/if}
    <button role="menuitem" class="context-menu-item" onclick={() => revealInFinder(contextMenu!.entry)}>{t('sidebar.revealInFinder')}</button>
    <button role="menuitem" class="context-menu-item" onclick={() => copyPath(contextMenu!.entry)}>{t('sidebar.copyPath')}</button>
    <button role="menuitem" class="context-menu-item" onclick={() => copyRelativePath(contextMenu!.entry)}>{t('sidebar.copyRelativePath')}</button>
    {#if !contextMenu.entry.is_dir}
      <button role="menuitem" class="context-menu-item" onclick={() => handleDuplicate(contextMenu!.entry)}>{t('sidebar.duplicate')}</button>
    {/if}
    <div class="context-menu-separator"></div>
    <button role="menuitem" class="context-menu-item" onclick={() => startRename(contextMenu!.entry)}>{t('sidebar.rename')}</button>
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
    gap: 2px;
    -webkit-app-region: no-drag;
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
    padding: 4px 6px;
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
    font-size: 0.8rem;
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

  :global(.context-menu) {
    position: fixed;
    z-index: 9999;
    min-width: 140px;
    padding: 4px;
    border-radius: 8px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    color: var(--novelist-text);
  }
  :global(.context-menu-item) {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text);
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
  }
  :global(.context-menu-item:hover) {
    background: var(--novelist-sidebar-hover);
  }
  :global(.context-menu-item-danger:hover) {
    background: #e5484d18;
    color: #e5484d;
  }
  :global(.context-menu-separator) {
    height: 1px;
    margin: 4px 8px;
    background: var(--novelist-border-subtle, var(--novelist-border));
  }

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
  }

  .project-switcher-remove-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-tertiary, #b0b0b0);
    cursor: pointer;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
  }
  .project-switcher-row:hover .project-switcher-remove-btn {
    opacity: 1;
  }
  .project-switcher-remove-btn:hover {
    color: #e5484d;
    background: #e5484d12;
  }

  .project-switcher-item {
    display: flex;
    align-items: center;
    gap: 8px;
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
  .project-switcher-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .project-switcher-item-active {
    background: var(--novelist-sidebar-active);
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
