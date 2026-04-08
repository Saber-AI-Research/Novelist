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

  async function openDirectory() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;

    const dirPath = selected as string;
    projectStore.isLoading = true;

    // Stop watching previous project before opening new one
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

    // Start watching new project directory
    const watchResult = await commands.startFileWatcher(dirPath);
    if (watchResult.status !== 'ok') {
      console.error('Failed to start file watcher:', watchResult.error);
    }
  }

  async function openFile(entry: FileEntry) {
    if (entry.is_dir || !isTextFile(entry.name)) return;

    const result = await commands.readFile(entry.path);
    if (result.status === 'ok') {
      tabsStore.openTab(entry.path, result.data);
      // Register file for change detection
      const regResult = await commands.registerOpenFile(entry.path);
      if (regResult.status !== 'ok') {
        console.error('Failed to register open file:', regResult.error);
      }
    } else {
      console.error('Failed to read file:', result.error);
    }
  }
</script>

<aside class="h-full flex flex-col overflow-hidden" style="background: var(--novelist-sidebar-bg); color: var(--novelist-sidebar-text);">
  <div class="p-2 flex items-center" style="border-bottom: 1px solid var(--novelist-border);">
    <button
      class="w-full text-left px-2 py-1 text-xs rounded hover:opacity-80 cursor-pointer"
      style="background: var(--novelist-accent); color: #fff;"
      onclick={openDirectory}
    >
      Open Folder
    </button>
  </div>

  {#if projectStore.isOpen}
    <div class="px-3 py-2 text-xs font-semibold truncate" style="color: var(--novelist-text-secondary);">
      {projectStore.name}
    </div>

    <div class="flex-1 overflow-y-auto">
      {#each sortedFiles() as entry}
        {#if entry.is_dir}
          <div
            class="flex items-center px-3 py-1 text-xs"
            style="color: var(--novelist-text-secondary);"
          >
            <span class="mr-1">&#x1F4C1;</span>
            <span class="truncate">{entry.name}</span>
          </div>
        {:else if isTextFile(entry.name)}
          <button
            class="flex items-center w-full px-3 py-1 text-xs text-left cursor-pointer hover:opacity-80"
            style="background: {tabsStore.activeTab?.filePath === entry.path ? 'var(--novelist-accent)' : 'transparent'}; color: {tabsStore.activeTab?.filePath === entry.path ? '#fff' : 'var(--novelist-sidebar-text)'};"
            onclick={() => openFile(entry)}
          >
            <span class="mr-1">&#x1F4C4;</span>
            <span class="truncate">{entry.name}</span>
          </button>
        {:else}
          <div
            class="flex items-center px-3 py-1 text-xs opacity-40"
          >
            <span class="mr-1">&#x1F4C4;</span>
            <span class="truncate">{entry.name}</span>
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="flex-1 flex items-center justify-center p-4">
      <p class="text-xs text-center" style="color: var(--novelist-text-secondary);">
        No project open.<br />Click "Open Folder" to get started.
      </p>
    </div>
  {/if}
</aside>
