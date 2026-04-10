<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import type { RecentProject } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  interface Props {
    onOpenDirectory: () => void;
    onOpenRecent: (path: string) => void;
  }
  let { onOpenDirectory, onOpenRecent }: Props = $props();

  let recentProjects = $state<RecentProject[]>([]);

  onMount(async () => {
    const result = await commands.getRecentProjects();
    if (result.status === 'ok') {
      recentProjects = result.data;
    }
  });

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

<div class="welcome-root" data-tauri-drag-region>
  <div class="welcome-card">
    <div class="welcome-header">
      <h1 class="welcome-title">{t('app.name')}</h1>
      <p class="welcome-subtitle">{t('app.subtitle')}</p>
    </div>

    {#if recentProjects.length > 0}
      <div class="recent-section">
        <h2 class="recent-heading">{t('welcome.recentProjects')}</h2>
        <ul class="recent-list">
          {#each recentProjects as project}
            <li>
              <button
                class="recent-item"
                onclick={() => onOpenRecent(project.path)}
              >
                <span class="recent-name">{project.name}</span>
                <span class="recent-path">{displayPath(project.path)}</span>
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
      <button class="open-btn" onclick={onOpenDirectory}>
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

  .welcome-header {
    text-align: center;
  }

  .welcome-title {
    font-size: 2rem;
    font-weight: 300;
    letter-spacing: 0.05em;
    margin: 0 0 0.25rem 0;
    color: var(--novelist-text);
  }

  .welcome-subtitle {
    font-size: 0.85rem;
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

  .recent-heading {
    font-size: 0.75rem;
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

  .recent-item {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    border-radius: 4px;
    color: var(--novelist-text);
    transition: background 0.1s;
  }

  .recent-item:hover {
    background: var(--novelist-bg-secondary);
  }

  .recent-name {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .recent-path {
    font-size: 0.75rem;
    color: var(--novelist-text-secondary);
    margin-top: 0.15rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-state {
    text-align: center;
    padding: 1.5rem 0;
    color: var(--novelist-text-secondary);
    font-size: 0.85rem;
  }

  .welcome-actions {
    display: flex;
    justify-content: center;
  }

  .open-btn {
    padding: 0.5rem 1.5rem;
    background: var(--novelist-accent);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
    transition: opacity 0.1s;
  }

  .open-btn:hover {
    opacity: 0.85;
  }
</style>
