<script lang="ts">
  import { onMount } from 'svelte';
  import { commands, type ChannelConfig } from '$lib/ipc/commands';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commandRegistry } from '$lib/stores/commands.svelte';
  import { t } from '$lib/i18n';
  import PublishDialog from './PublishDialog.svelte';

  let menuOpen = $state(false);
  let dialogChannel = $state<ChannelConfig | null>(null);
  let channels = $state<ChannelConfig[]>([]);
  let buttonEl = $state<HTMLButtonElement | null>(null);

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

  async function toggleMenu() {
    if (!menuOpen) await reloadChannels();
    menuOpen = !menuOpen;
  }

  function runCommand(id: string) {
    menuOpen = false;
    commandRegistry.execute(id);
  }

  async function openPublishDialog(c: ChannelConfig) {
    menuOpen = false;
    const tab = tabsStore.activeTab;
    if (!tab) return;
    // Read current document content from the editor — fall back to the
    // tab's stored content if the editor view isn't ready.
    dialogChannel = c;
    activeDoc = await loadActiveDoc(tab.filePath);
  }

  let activeDoc = $state<{ dir: string; text: string } | null>(null);

  async function loadActiveDoc(filePath: string): Promise<{ dir: string; text: string } | null> {
    const r = await commands.readFile(filePath);
    if (r.status !== 'ok') return null;
    const dir = filePath.split('/').slice(0, -1).join('/');
    return { dir, text: r.data };
  }

  function closeDialog() {
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

{#if dialogChannel && activeDoc}
  <PublishDialog channel={dialogChannel} doc={activeDoc} onClose={closeDialog} />
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
