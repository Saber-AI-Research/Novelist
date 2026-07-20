<script lang="ts">
  import { onMount } from 'svelte';
  import { commands, type ChannelConfig } from '$lib/ipc/commands';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import {
    capturePublishDocumentSnapshot,
    type EditorPublishDocumentSnapshot,
    type RopePublishDocumentSnapshot,
  } from '$lib/services/publish-document-snapshot';
  import { t } from '$lib/i18n';
  import { pathDirname } from '$lib/utils/path';
  import PublishDialog, { type PublishDialogMode } from './PublishDialog.svelte';

  interface Props {
    paneId: string;
  }

  let { paneId }: Props = $props();

  let menuOpen = $state(false);
  let dialogChannel = $state<ChannelConfig | null>(null);
  let dialogMode = $state<PublishDialogMode | null>(null);
  let dialogSource = $state<EditorPublishDocumentSnapshot | RopePublishDocumentSnapshot | null>(null);
  let channels = $state<ChannelConfig[]>([]);
  let buttonEl = $state<HTMLButtonElement | null>(null);
  let openOperation = 0;

  onMount(() => {
    void reloadChannels();
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  });

  async function reloadChannels() {
    const r = await commands.getPublishSettings();
    if (r.status === 'ok') channels = r.data.channels ?? [];
  }

  function onClickOutside(e: MouseEvent) {
    if (!menuOpen) return;
    if (buttonEl && !buttonEl.parentElement?.contains(e.target as Node)) {
      menuOpen = false;
    }
  }

  function toggleMenu() {
    if (menuOpen) {
      menuOpen = false;
      return;
    }
    menuOpen = true;
    void reloadChannels();
  }

  function runCommand(id: string) {
    menuOpen = false;
    commandRegistry.execute(id);
  }

  async function openPublishDialog(c: ChannelConfig) {
    const operation = ++openOperation;
    menuOpen = false;
    const tab = tabsStore.getPaneActiveTab(paneId);
    if (!tab) return;
    // Online Publish intentionally remains disk-backed.
    const source = captureStyledCopySource();
    let doc: Awaited<ReturnType<typeof loadActiveDoc>>;
    try {
      doc = await loadActiveDoc(tab.filePath);
    } catch {
      return;
    }
    if (operation !== openOperation || !doc) return;
    dialogSource = source;
    dialogChannel = c;
    activeDoc = doc;
    dialogMode = 'online';
  }

  function openStyledCopyDialog() {
    openOperation += 1;
    menuOpen = false;
    dialogSource = captureStyledCopySource();
    dialogMode = 'styled';
    dialogChannel = null;
    activeDoc = null;
  }

  function captureStyledCopySource(): EditorPublishDocumentSnapshot | RopePublishDocumentSnapshot | null {
    const result = capturePublishDocumentSnapshot(paneId);
    return result.kind === 'editor' || result.kind === 'rope' ? result : null;
  }

  async function loadPaneActiveDoc() {
    const tab = tabsStore.getPaneActiveTab(paneId);
    return tab ? loadActiveDoc(tab.filePath) : null;
  }

  let activeDoc = $state<{ dir: string; text: string; projectDir: string; filePath: string } | null>(null);

  async function loadActiveDoc(
    filePath: string,
  ): Promise<{ dir: string; text: string; projectDir: string; filePath: string } | null> {
    const r = await commands.readFile(filePath);
    if (r.status !== 'ok') return null;
    const dir = pathDirname(filePath);
    const projectDir = projectStore.dirPath ?? dir;
    return { dir, text: r.data, projectDir, filePath };
  }

  function closeDialog() {
    openOperation += 1;
    dialogMode = null;
    dialogSource = null;
    dialogChannel = null;
    activeDoc = null;
  }
</script>

<button
  bind:this={buttonEl}
  class="share-btn"
  onclick={toggleMenu}
  title={t('share.button')}
  aria-label={t('share.button')}
  data-testid="share-menu-{paneId}"
>
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 8L8 4L12 8" />
    <path d="M8 4V12" />
    <path d="M3 12V13C3 13.5523 3.44772 14 4 14H12C12.5523 14 13 13.5523 13 13V12" />
  </svg>
</button>

{#if menuOpen}
  <div class="share-menu" role="menu">
    <button class="share-item" role="menuitem" onclick={() => runCommand('image-host.upload-all')}>
      {t('share.uploadImages')}
    </button>
    <div class="share-divider"></div>
    <button
      class="share-item"
      role="menuitem"
      data-testid="share-styled-copy"
      onclick={openStyledCopyDialog}
    >
      {t('share.styledCopy')}
    </button>
    {#if channels.length > 0}
      <div class="share-divider"></div>
      {#each channels as c (c.id)}
        <button class="share-item" role="menuitem" onclick={() => openPublishDialog(c)}>
          <span class="share-channel-name">{t('share.publishTo')} {c.name}</span>
          <span class="share-channel-platform">{c.platform}</span>
        </button>
      {/each}
    {:else}
      <div class="share-divider"></div>
      <div class="share-empty">{t('share.noChannels')}</div>
    {/if}
  </div>
{/if}

{#if dialogMode && (dialogMode === 'styled' || (dialogChannel && activeDoc))}
  <PublishDialog
    initialMode={dialogMode}
    {channels}
    source={dialogSource}
    channel={dialogChannel}
    doc={activeDoc}
    loadOnlineDoc={loadPaneActiveDoc}
    onClose={closeDialog}
  />
{/if}

<style>
  .share-btn {
    background: transparent;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    padding: 4px 6px;
    cursor: pointer;
    color: var(--novelist-text-secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .share-btn:hover {
    background: var(--novelist-sidebar-hover);
    color: var(--novelist-text);
  }
  .share-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 240px;
    padding: 4px 0;
    z-index: 200;
  }
  .share-item {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    text-align: left;
    padding: 6px 12px;
    border: none;
    background: transparent;
    color: var(--novelist-text);
    font-size: 14px;
    cursor: pointer;
  }
  .share-item:hover {
    background: var(--novelist-sidebar-hover);
  }
  .share-channel-platform {
    font-size: 10px;
    color: var(--novelist-text-secondary);
  }
  .share-divider {
    border-top: 1px solid var(--novelist-border);
    margin: 4px 0;
  }
  .share-empty {
    padding: 8px 12px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
  }
</style>
