<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import { moveItemAfterSidecarFlush } from '$lib/services/rename-coordinator';
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { pathBasename, pathDirname, pathIsWithin } from '$lib/utils/path';
  import { t } from '$lib/i18n';
  import { isImeComposing } from '$lib/utils/ime';

  /**
   * Move-file palette. Opens via Cmd+M. Lists every directory in the project
   * (including the root) and calls `moveItem` on the active tab's file — or,
   * when `sourcePath` is given (sidebar "Move to…", see `move-file-palette.ts`),
   * on that file or folder.
   *
   * Selection rendering mirrors CommandPalette so muscle memory carries over.
   */
  interface Props {
    onClose: () => void;
    /** File or folder to move; defaults to the active tab's file. */
    sourcePath?: string;
  }
  let { onClose, sourcePath }: Props = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement;

  const activeTab = $derived(tabsStore.activeTab);
  const subjectPath = $derived(sourcePath ?? activeTab?.filePath ?? null);
  const subjectName = $derived(sourcePath ? pathBasename(sourcePath) : activeTab?.fileName ?? '');

  /** Walk projectStore.files into a flat list of directory entries (+ root). */
  function collectDirs(): Array<{ path: string; label: string }> {
    const out: Array<{ path: string; label: string }> = [];
    if (!projectStore.dirPath) return out;

    // Root always first.
    out.push({ path: projectStore.dirPath, label: '/ (' + t('movePalette.root') + ')' });

    const rootLen = projectStore.dirPath.length + 1;
    function walk(nodes: FileNode[] | undefined) {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.is_dir) {
          const rel = n.path.startsWith(projectStore.dirPath!)
            ? n.path.slice(rootLen)
            : n.path;
          out.push({ path: n.path, label: rel });
          walk(n.children);
        }
      }
    }
    walk(projectStore.files);
    return out;
  }

  const allDirs = $derived(collectDirs());

  /** Filter on substring match of the relative path (case-insensitive). */
  const results = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const currentParent = subjectPath ? pathDirname(subjectPath) : null;
    // Drop the entry's current parent so "move to same folder" isn't offered,
    // and (for a folder) the folder itself and everything beneath it.
    const filtered = allDirs.filter(d =>
      d.path !== currentParent && !(sourcePath && pathIsWithin(d.path, sourcePath))
    );
    if (!q) return filtered;
    return filtered.filter(d => d.label.toLowerCase().includes(q));
  });

  function handleKeydown(e: KeyboardEvent) {
    if (isImeComposing(e)) return;
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, results.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); }
    if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault();
      void confirm(results[selectedIndex].path);
    }
  }

  async function confirm(targetDir: string) {
    const srcPath = subjectPath;
    if (!srcPath) { onClose(); return; }
    const result = await moveItemAfterSidecarFlush(
      projectStore.dirPath,
      srcPath,
      targetDir,
    );
    if (result.status === 'ok') {
      const newPath = result.data.new_path;
      // A sidebar entry may be a folder: re-point every open tab beneath it.
      if (sourcePath) await tabsStore.retargetOpenPathTree(srcPath, newPath, { broadcast: false });
      else await tabsStore.retargetOpenPath(srcPath, newPath, { broadcast: false });
      // Refresh both affected folders so the tree catches up immediately.
      const oldParent = pathDirname(srcPath);
      await projectStore.refreshFolder(oldParent).catch(() => {});
      await projectStore.refreshFolder(targetDir).catch(() => {});
    } else {
      console.error('[MovePalette] moveItem failed:', result.error);
      if (sourcePath) {
        window.dispatchEvent(new CustomEvent('novelist-operation-error', {
          detail: { message: t('touch.moveFailed', { name: subjectName, error: result.error }) },
        }));
      }
    }
    onClose();
  }

  // Reset selection on query change
  $effect(() => { query; selectedIndex = 0; });

  onMount(() => {
    inputEl?.focus();
  });
</script>

<div class="palette-backdrop" data-testid="move-palette" role="presentation" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-container" onclick={(e) => e.stopPropagation()}>
    <div class="palette-header">
      <span class="palette-title">{t('movePalette.title')}</span>
      {#if subjectPath}
        <span class="palette-subject">{subjectName}</span>
      {/if}
    </div>
    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={handleKeydown}
      placeholder={t('movePalette.placeholder')}
      class="palette-input"
      data-testid="move-palette-input"
    />
    {#if !subjectPath}
      <div class="palette-empty">{t('movePalette.noActiveTab')}</div>
    {:else if results.length === 0}
      <div class="palette-empty">{t('movePalette.noMatches')}</div>
    {:else}
      <ul class="palette-list">
        {#each results as dir, i (dir.path)}
          <li>
            <button
              class="palette-item"
              class:selected={i === selectedIndex}
              data-testid="move-palette-result-{i}"
              onclick={() => confirm(dir.path)}
              onmouseenter={() => { selectedIndex = i; }}
            >
              <span>{dir.label}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    padding-top: 80px;
  }

  .palette-container {
    width: 520px;
    max-height: 420px;
    background: var(--novelist-bg-secondary, #1e1e2e);
    border: 1px solid var(--novelist-border, #333);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .palette-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 16px 6px 16px;
    border-bottom: 1px solid var(--novelist-border, #333);
  }

  .palette-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--novelist-text-secondary, #888);
  }

  .palette-subject {
    font-size: 14px;
    color: var(--novelist-text, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .palette-input {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-bottom: 1px solid var(--novelist-border, #333);
    background: transparent;
    color: var(--novelist-text, #e0e0e0);
    font-size: 14px;
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--novelist-text-secondary, #888);
  }

  .palette-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .palette-list li {
    margin: 0;
    padding: 0;
  }

  .palette-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--novelist-text, #e0e0e0);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }

  .palette-item:hover,
  .palette-item.selected {
    background: color-mix(in srgb, var(--novelist-accent, #7c3aed) 20%, transparent);
  }

  .palette-empty {
    padding: 20px 16px;
    color: var(--novelist-text-secondary, #888);
    font-size: 14px;
    text-align: center;
  }

  /* Mobile layouts: lay the backdrop over the visual viewport so the palette
     stays above the on-screen keyboard. */
  :global(html[data-layout='phone']) .palette-backdrop,
  :global(html[data-layout='tablet']) .palette-backdrop {
    bottom: auto;
    top: var(--novelist-vv-top, 0px);
    height: var(--novelist-vv-height, 100vh);
  }

  /* Phone: bottom sheet. */
  :global(html[data-layout='phone']) .palette-backdrop {
    align-items: flex-end;
    padding-top: 0;
  }
  :global(html[data-layout='phone']) .palette-container {
    width: 100%;
    max-height: calc(var(--novelist-vv-height, 100vh) * 0.7);
    border-bottom: none;
    border-radius: 12px 12px 0 0;
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
  }
  :global(html[data-layout='phone'][data-keyboard='open']) .palette-container {
    padding-bottom: 0;
  }

  :global(html[data-layout='tablet']) .palette-container {
    width: min(560px, calc(100vw - 32px));
    max-height: min(420px, calc(var(--novelist-vv-height, 100vh) - 96px));
  }

  @media (pointer: coarse) {
    .palette-item {
      min-height: 44px;
    }
    /* ≥16px keeps iOS from zooming the page when the input gains focus. */
    .palette-input {
      font-size: 16px;
    }
  }
</style>
