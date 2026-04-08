<script lang="ts">
  import { open } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import type { FileEntry } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';

  const textExtensions = ['.md', '.markdown', '.txt'];

  function isTextFile(name: string): boolean {
    return textExtensions.some(ext => name.toLowerCase().endsWith(ext));
  }

  function sortedFiles(): FileEntry[] {
    const dirs = projectStore.files.filter(f => f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    const files = projectStore.files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

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
    projectStore.isLoading = true;

    await commands.stopFileWatcher();

    const configResult = await commands.detectProject(dirPath);
    const config = configResult.status === 'ok' ? configResult.data : null;

    const filesResult = await commands.listDirectory(dirPath);
    const files = filesResult.status === 'ok' ? filesResult.data : [];

    projectStore.setProject(dirPath, config, files);
    tabsStore.closeAll();

    const name = config?.project?.name || dirPath.split('/').pop() || 'Untitled';
    commands.addRecentProject(dirPath, name);

    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') {
      console.error('Failed to start file watcher:', watchResult.error);
    }
  }

  // --- Open file ---
  async function openFile(entry: FileEntry) {
    if (entry.is_dir || !isTextFile(entry.name)) return;

    console.log(`[Sidebar.openFile] ${entry.name}: size=${entry.size}`);

    // Always read full content. Editor decides mode based on size.
    const result = await commands.readFile(entry.path);
    if (result.status === 'ok') {
      tabsStore.openTab(entry.path, result.data);
      console.log(`[Sidebar.openFile] loaded ${result.data.length} bytes, ${result.data.split('\n').length} lines`);
    } else {
      console.error('Failed to read file:', result.error);
      return;
    }
    const regResult = await commands.registerOpenFile(entry.path);
    if (regResult.status !== 'ok') {
      console.error('Failed to register open file:', regResult.error);
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

  // --- Context menu ---
  let contextMenu = $state<{ x: number; y: number; entry: FileEntry } | null>(null);
  let renaming = $state<FileEntry | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);

  function handleContextMenu(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    contextMenu = { x: e.clientX, y: e.clientY, entry };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function startRename(entry: FileEntry) {
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
    const result = await commands.renameItem(renaming.path, renameValue.trim());
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

  async function handleDelete(entry: FileEntry) {
    closeContextMenu();
    const confirmed = confirm(`Delete "${entry.name}"? This cannot be undone.`);
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
</script>

<!-- Close context menu on click anywhere -->
<svelte:window onclick={closeContextMenu} />

<aside class="sidebar">
  <!-- Project header -->
  <div class="sidebar-header">
    {#if projectStore.isOpen}
      <span class="sidebar-project-name">{projectStore.name}</span>
      <div class="sidebar-actions">
        <button class="sidebar-icon-btn" onclick={startCreateFile} title="New File">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
        </button>
        <button class="sidebar-icon-btn" onclick={startCreateFolder} title="New Folder">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h4l2 2h6v7H2z"/><path d="M8 8v4M6 10h4"/></svg>
        </button>
      </div>
    {:else}
      <button class="sidebar-open-btn" onclick={openDirectory}>Open Folder</button>
    {/if}
  </div>

  {#if projectStore.isOpen}
    <div class="sidebar-files">
      <!-- Inline new item input -->
      {#if creatingFile || creatingFolder}
        <div class="sidebar-input-row">
          <input
            bind:this={newItemInput}
            bind:value={newItemName}
            onkeydown={handleCreateKeydown}
            onblur={confirmCreate}
            class="sidebar-input"
            placeholder={creatingFolder ? 'Folder name...' : 'File name...'}
          />
        </div>
      {/if}

      {#each sortedFiles() as entry}
        {#if renaming && renaming.path === entry.path}
          <div class="sidebar-input-row">
            <input
              bind:this={renameInput}
              bind:value={renameValue}
              onkeydown={handleRenameKeydown}
              onblur={confirmRename}
              class="sidebar-input"
            />
          </div>
        {:else if entry.is_dir}
          <div
            class="sidebar-item sidebar-item-dir"
            oncontextmenu={(e) => handleContextMenu(e, entry)}
          >
            <svg class="sidebar-item-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h4l2 2h6v7H2z"/></svg>
            <span class="sidebar-item-name">{entry.name}</span>
          </div>
        {:else if isTextFile(entry.name)}
          <button
            class="sidebar-item"
            class:sidebar-item-active={tabsStore.activeTab?.filePath === entry.path}
            onclick={() => openFile(entry)}
            oncontextmenu={(e) => handleContextMenu(e, entry)}
          >
            <svg class="sidebar-item-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
            <span class="sidebar-item-name">{entry.name.replace(/\.(md|markdown|txt)$/i, '')}</span>
            <span class="sidebar-item-ext">.{entry.name.split('.').pop()}</span>
          </button>
        {:else}
          <div
            class="sidebar-item sidebar-item-disabled"
            oncontextmenu={(e) => handleContextMenu(e, entry)}
          >
            <svg class="sidebar-item-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
            <span class="sidebar-item-name">{entry.name}</span>
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="sidebar-empty">
      <p>No project open</p>
      <button class="sidebar-open-btn" onclick={openDirectory}>Open Folder</button>
    </div>
  {/if}
</aside>

<!-- Context menu -->
{#if contextMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="context-menu"
    style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    <button class="context-menu-item" onclick={() => startRename(contextMenu!.entry)}>Rename</button>
    <button class="context-menu-item context-menu-item-danger" onclick={() => handleDelete(contextMenu!.entry)}>Delete</button>
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
    -webkit-app-region: drag;
    user-select: none;
  }

  .sidebar-project-name {
    font-size: 0.8rem;
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
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    transition: background 100ms, color 100ms;
  }
  .sidebar-icon-btn:hover {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-text);
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
  .sidebar-files::-webkit-scrollbar {
    width: 4px;
  }
  .sidebar-files::-webkit-scrollbar-thumb {
    background: var(--novelist-border);
    border-radius: 2px;
  }

  .sidebar-item {
    display: flex;
    align-items: center;
    width: 100%;
    padding: 5px 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-sidebar-text);
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
    white-space: nowrap;
    overflow: hidden;
    gap: 6px;
  }
  .sidebar-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .sidebar-item-active {
    background: var(--novelist-sidebar-active) !important;
    color: var(--novelist-text);
  }
  .sidebar-item-dir {
    cursor: default;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
  }
  .sidebar-item-disabled {
    cursor: default;
    opacity: 0.35;
  }

  .sidebar-item-icon {
    flex-shrink: 0;
    opacity: 0.5;
  }
  .sidebar-item-active .sidebar-item-icon {
    opacity: 0.75;
  }

  .sidebar-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sidebar-item-ext {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.72rem;
    flex-shrink: 0;
  }
  .sidebar-item-active .sidebar-item-ext {
    color: var(--novelist-text-secondary);
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

  .context-menu {
    position: fixed;
    z-index: 50;
    min-width: 140px;
    padding: 4px;
    border-radius: 8px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    color: var(--novelist-text);
  }
  .context-menu-item {
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
  .context-menu-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .context-menu-item-danger:hover {
    background: #e5484d18;
    color: #e5484d;
  }
</style>
