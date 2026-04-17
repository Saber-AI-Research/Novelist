<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { projectStore } from '$lib/stores/project.svelte';
  import { t } from '$lib/i18n';

  interface SnapshotMeta {
    id: string;
    name: string;
    timestamp: number;
    file_count: number;
    total_bytes: number;
  }

  let snapshots = $state<SnapshotMeta[]>([]);
  let newName = $state('');
  let loading = $state(false);
  let error = $state('');
  let confirmRestoreId = $state<string | null>(null);

  async function refresh() {
    if (!projectStore.dirPath) return;
    try {
      snapshots = await invoke<SnapshotMeta[]>('list_snapshots', {
        projectDir: projectStore.dirPath,
      });
    } catch (e) {
      console.error('Failed to list snapshots:', e);
    }
  }

  async function handleCreate() {
    if (!projectStore.dirPath || !newName.trim()) return;
    loading = true;
    error = '';
    try {
      await invoke('create_snapshot', {
        projectDir: projectStore.dirPath,
        name: newName.trim(),
      });
      newName = '';
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function handleRestore(id: string) {
    if (!projectStore.dirPath) return;
    loading = true;
    error = '';
    try {
      await invoke('restore_snapshot', {
        projectDir: projectStore.dirPath,
        snapshotId: id,
      });
      confirmRestoreId = null;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function handleDelete(id: string) {
    if (!projectStore.dirPath) return;
    try {
      await invoke('delete_snapshot', {
        projectDir: projectStore.dirPath,
        snapshotId: id,
      });
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }

  function formatDate(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  $effect(() => {
    if (projectStore.dirPath) {
      refresh();
    }
  });
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="shrink-0 px-3 py-1.5"
    style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border)); background: var(--novelist-bg);">
    <span style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-secondary); font-weight: 600;">
      {t('snapshot.title')}
    </span>
  </div>

  <!-- Create form -->
  <div class="shrink-0 p-2" style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
    <div class="flex gap-1">
      <input
        type="text"
        bind:value={newName}
        placeholder={t('snapshot.namePlaceholder')}
        class="flex-1 min-w-0"
        style="
          padding: 4px 8px;
          font-size: 12px;
          border: 1px solid var(--novelist-border);
          border-radius: 4px;
          background: var(--novelist-editor-bg);
          color: var(--novelist-text);
          outline: none;
        "
        onkeydown={(e) => { if (e.key === 'Enter') handleCreate(); }}
      />
      <button
        onclick={handleCreate}
        disabled={loading || !newName.trim()}
        class="cursor-pointer"
        style="
          padding: 4px 10px;
          font-size: 11px;
          border: 1px solid var(--novelist-accent);
          border-radius: 4px;
          background: var(--novelist-accent);
          color: white;
          opacity: {loading || !newName.trim() ? '0.5' : '1'};
          white-space: nowrap;
        "
      >
        {t('snapshot.create')}
      </button>
    </div>
    {#if error}
      <p style="font-size: 11px; color: #e55; margin-top: 4px;">{error}</p>
    {/if}
  </div>

  <!-- Snapshot list -->
  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if snapshots.length === 0}
      <div class="p-3" style="font-size: 12px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-align: center;">
        {t('snapshot.empty')}
      </div>
    {:else}
      {#each snapshots as snap (snap.id)}
        <div class="px-3 py-2" style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));">
          <div style="font-size: 12px; font-weight: 500; color: var(--novelist-text);">
            {snap.name}
          </div>
          <div style="font-size: 10px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); margin-top: 2px;">
            {formatDate(snap.timestamp)} &middot; {snap.file_count} files &middot; {formatBytes(snap.total_bytes)}
          </div>

          {#if confirmRestoreId === snap.id}
            <div style="margin-top: 6px; font-size: 11px; color: var(--novelist-text-secondary);">
              {t('snapshot.restoreConfirm')}
              <div class="flex gap-1 mt-1">
                <button
                  class="cursor-pointer"
                  style="padding: 2px 8px; font-size: 10px; border: 1px solid #e55; border-radius: 3px; background: #e55; color: white;"
                  onclick={() => handleRestore(snap.id)}
                >
                  {t('snapshot.yesRestore')}
                </button>
                <button
                  class="cursor-pointer"
                  style="padding: 2px 8px; font-size: 10px; border: 1px solid var(--novelist-border); border-radius: 3px; background: transparent; color: var(--novelist-text-secondary);"
                  onclick={() => { confirmRestoreId = null; }}
                >
                  {t('snapshot.cancel')}
                </button>
              </div>
            </div>
          {:else}
            <div class="flex gap-1 mt-1">
              <button
                class="cursor-pointer"
                style="padding: 2px 8px; font-size: 10px; border: 1px solid var(--novelist-border); border-radius: 3px; background: transparent; color: var(--novelist-text-secondary); transition: color 100ms;"
                onclick={() => { confirmRestoreId = snap.id; }}
              >
                {t('snapshot.restore')}
              </button>
              <button
                class="cursor-pointer"
                style="padding: 2px 8px; font-size: 10px; border: 1px solid var(--novelist-border); border-radius: 3px; background: transparent; color: var(--novelist-text-secondary); transition: color 100ms;"
                onclick={() => handleDelete(snap.id)}
              >
                {t('snapshot.delete')}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
