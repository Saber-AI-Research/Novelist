<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { RecentProject } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  interface Props {
    onOpenDirectory: () => void;
    onOpenRecent: (path: string) => void;
    onNewFile: () => void;
    onNewProject?: () => void;
  }
  let { onOpenDirectory, onOpenRecent, onNewFile, onNewProject }: Props = $props();

  let recentProjects = $state<RecentProject[]>([]);
  let draggingPath = $state<string | null>(null);
  let dragOverPath = $state<string | null>(null);

  onMount(async () => {
    await refresh();
  });

  async function refresh() {
    const result = await commands.getRecentProjects();
    if (result.status === 'ok') {
      recentProjects = result.data;
    }
  }

  async function removeProject(e: Event, path: string) {
    e.stopPropagation();
    await commands.removeRecentProject(path);
    recentProjects = recentProjects.filter(p => p.path !== path);
  }

  async function togglePin(e: Event, project: RecentProject) {
    e.stopPropagation();
    await commands.setProjectPinned(project.path, !project.pinned);
    await refresh();
  }

  function onDragStart(e: DragEvent, path: string) {
    draggingPath = path;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', path);
    }
  }

  function onDragOver(e: DragEvent, path: string) {
    if (!draggingPath || draggingPath === path) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverPath = path;
  }

  function onDragLeave(path: string) {
    if (dragOverPath === path) dragOverPath = null;
  }

  async function onDrop(e: DragEvent, targetPath: string) {
    e.preventDefault();
    const source = draggingPath;
    draggingPath = null;
    dragOverPath = null;
    if (!source || source === targetPath) return;

    const next = [...recentProjects];
    const fromIdx = next.findIndex(p => p.path === source);
    const toIdx = next.findIndex(p => p.path === targetPath);
    if (fromIdx < 0 || toIdx < 0) return;

    // Can't cross pinned/unpinned boundary — pinning is a separate action.
    if (next[fromIdx].pinned !== next[toIdx].pinned) return;

    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);

    // Optimistic update then persist.
    recentProjects = next;
    await commands.reorderRecentProjects(next.map(p => p.path));
  }

  function onDragEnd() {
    draggingPath = null;
    dragOverPath = null;
  }

  function displayPath(path: string): string {
    const home = '/Users/';
    if (path.startsWith(home)) {
      const rest = path.slice(home.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx !== -1) {
        return '~' + rest.slice(slashIdx);
      }
      return '~';
    }
    const homeLinux = '/home/';
    if (path.startsWith(homeLinux)) {
      const rest = path.slice(homeLinux.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx !== -1) {
        return '~' + rest.slice(slashIdx);
      }
      return '~';
    }
    return path;
  }
</script>

<div class="welcome-root" data-testid="welcome-screen" data-tauri-drag-region>
  <div class="welcome-card">
    <div class="welcome-header">
      <h1 class="welcome-title">{t('app.name')}</h1>
      <p class="welcome-subtitle">{t('app.subtitle')}</p>
    </div>

    {#if recentProjects.length > 0}
      <div class="recent-section">
        <div class="recent-header">
          <h2 class="recent-heading">{t('welcome.recentProjects')}</h2>
        </div>
        <ul class="recent-list">
          {#each recentProjects as project, index (project.path)}
            <li
              class="recent-row"
              class:pinned={project.pinned}
              class:dragging={draggingPath === project.path}
              class:drag-over={dragOverPath === project.path && draggingPath !== project.path}
              draggable="true"
              ondragstart={(e) => onDragStart(e, project.path)}
              ondragover={(e) => onDragOver(e, project.path)}
              ondragleave={() => onDragLeave(project.path)}
              ondrop={(e) => onDrop(e, project.path)}
              ondragend={onDragEnd}
            >
              <span class="drag-handle" title={t('welcome.dragToReorder')} aria-hidden="true">⋮⋮</span>
              <button
                class="recent-item"
                data-testid="recent-project-{index}"
                onclick={() => onOpenRecent(project.path)}
              >
                <span class="recent-name">{project.name}</span>
                <span class="recent-path">{displayPath(project.path)}</span>
              </button>
              <button
                class="recent-action-btn"
                class:active={project.pinned}
                data-testid="recent-project-pin-{index}"
                onclick={(e) => togglePin(e, project)}
                title={project.pinned ? t('welcome.unpinProject') : t('welcome.pinProject')}
                aria-label={project.pinned ? t('welcome.unpinProject') : t('welcome.pinProject')}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill={project.pinned ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 2l4 4-3 1-1 4-4-4 4-1 0-4zM6 10l-3 4"/>
                </svg>
              </button>
              <button
                class="recent-action-btn recent-remove-btn"
                onclick={(e) => removeProject(e, project.path)}
                title={t('sidebar.removeProject')}
                aria-label={t('sidebar.removeProject')}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <div class="empty-state">
        <p>{t('welcome.noRecent')}</p>
      </div>
    {/if}

    <div class="welcome-actions">
      {#if onNewProject}
        <button class="new-file-btn" onclick={onNewProject}>
          {t('welcome.newProject')}
        </button>
      {/if}
      <button class="open-btn" data-testid="welcome-new-file" onclick={onNewFile}>
        {t('welcome.newFile')}
      </button>
      <button class="open-btn" data-testid="welcome-open-folder" onclick={onOpenDirectory}>
        {t('welcome.openDirectory')}
      </button>
    </div>
  </div>
</div>

<style>
  .welcome-root {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    background: var(--novelist-bg);
  }

  .welcome-card {
    width: 480px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .welcome-header { text-align: center; }
  .welcome-title {
    font-size: 2.4rem;
    font-weight: 300;
    letter-spacing: 0.05em;
    margin: 0 0 0.25rem 0;
    color: var(--novelist-text);
  }
  .welcome-subtitle {
    font-size: 0.95rem;
    margin: 0;
    color: var(--novelist-text-secondary);
  }

  .recent-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    overflow: hidden;
  }
  .recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .recent-heading {
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0;
    color: var(--novelist-text-secondary);
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    max-height: 320px;
  }
  .recent-list li + li {
    border-top: 1px solid var(--novelist-border);
  }

  .recent-row {
    display: flex;
    align-items: center;
    position: relative;
    padding: 0 4px 0 0;
    transition: background 0.1s, border-color 0.1s;
  }
  .recent-row.pinned {
    background: color-mix(in srgb, var(--novelist-accent) 4%, transparent);
  }
  .recent-row.dragging { opacity: 0.4; }
  .recent-row.drag-over {
    box-shadow: inset 0 2px 0 0 var(--novelist-accent);
  }

  .drag-handle {
    width: 18px;
    flex-shrink: 0;
    text-align: center;
    color: var(--novelist-text-tertiary, #b0b0b0);
    font-size: 12px;
    cursor: grab;
    opacity: 0;
    transition: opacity 0.12s;
    user-select: none;
    letter-spacing: -1px;
  }
  .recent-row:hover .drag-handle { opacity: 0.7; }
  .recent-row.dragging .drag-handle { cursor: grabbing; opacity: 1; }

  .recent-item {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    padding: 0.6rem 0.5rem;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    color: var(--novelist-text);
    transition: background 0.1s;
  }
  .recent-item:hover { background: var(--novelist-bg-secondary); }

  .recent-name {
    font-size: 1rem;
    font-weight: 500;
  }
  .recent-path {
    font-size: 0.82rem;
    color: var(--novelist-text-secondary);
    margin-top: 0.15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .recent-action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-tertiary, #b0b0b0);
    cursor: pointer;
    flex-shrink: 0;
    margin-left: 2px;
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, background 0.15s;
  }
  .recent-row:hover .recent-action-btn,
  .recent-action-btn.active {
    opacity: 1;
  }
  .recent-action-btn:hover {
    background: color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
  }
  .recent-action-btn.active {
    color: var(--novelist-accent);
  }
  .recent-remove-btn:hover {
    color: #e5484d;
    background: #e5484d12;
  }

  .empty-state {
    text-align: center;
    padding: 1.5rem 0;
    color: var(--novelist-text-secondary);
    font-size: 0.95rem;
  }

  .welcome-actions {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
  }

  .new-file-btn {
    padding: 0.5rem 1.5rem;
    background: var(--novelist-accent);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 0.95rem;
    cursor: pointer;
    transition: opacity 0.1s;
  }
  .new-file-btn:hover { opacity: 0.85; }

  .open-btn {
    padding: 0.5rem 1.5rem;
    background: transparent;
    color: var(--novelist-text-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    font-size: 0.95rem;
    cursor: pointer;
    transition: border-color 0.1s, color 0.1s;
  }
  .open-btn:hover {
    border-color: var(--novelist-accent);
    color: var(--novelist-text);
  }
</style>
