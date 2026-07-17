<script lang="ts">
  import type { ChannelConfig } from '$lib/ipc/commands';
  import type { StyledCopySource } from '$lib/services/styled-copy';
  import { t } from '$lib/i18n';
  import { IconClose } from './icons';
  import OnlinePublishPanel from './OnlinePublishPanel.svelte';
  import StyledCopyPanel from './StyledCopyPanel.svelte';

  export type PublishDialogMode = 'online' | 'styled';
  export interface OnlinePublishDocument {
    dir: string;
    text: string;
    projectDir: string;
    filePath: string;
  }

  interface Props {
    initialMode: PublishDialogMode;
    channels: ChannelConfig[];
    source: StyledCopySource | null;
    channel?: ChannelConfig | null;
    doc?: OnlinePublishDocument | null;
    loadOnlineDoc: (channel: ChannelConfig) => Promise<OnlinePublishDocument | null>;
    onClose: () => void;
  }

  let {
    initialMode,
    channels,
    source,
    channel = null,
    doc = null,
    loadOnlineDoc,
    onClose,
  }: Props = $props();
  // svelte-ignore state_referenced_locally
  let mode = $state<PublishDialogMode>(initialMode);
  // svelte-ignore state_referenced_locally
  let onlineChannel = $state<ChannelConfig | null>(channel);
  // svelte-ignore state_referenced_locally
  let onlineDoc = $state<OnlinePublishDocument | null>(doc);
  let onlinePanel = $state<OnlinePublishPanel>();
  let publishing = $state(false);
  let loadingOnline = $state(false);
  let onlineLoadError = $state(false);
  let switchingMode = $state(false);
  let onlineLoadGeneration = 0;

  function invalidateOnlineLoad(): number {
    loadingOnline = false;
    return ++onlineLoadGeneration;
  }

  function requestClose(): void {
    if (switchingMode) return;
    invalidateOnlineLoad();
    if (mode === 'online' && onlinePanel) {
      if (!publishing) onlinePanel.requestClose();
      return;
    }
    onClose();
  }

  async function switchMode(nextMode: PublishDialogMode): Promise<void> {
    if (publishing || switchingMode || mode === nextMode) return;
    const generation = invalidateOnlineLoad();
    onlineLoadError = false;

    if (nextMode === 'styled') {
      if (mode === 'online' && onlinePanel) {
        switchingMode = true;
        const canSwitch = await onlinePanel.prepareForModeSwitch();
        switchingMode = false;
        if (generation !== onlineLoadGeneration || !canSwitch) return;
      }
      if (generation === onlineLoadGeneration) mode = 'styled';
      return;
    }

    mode = 'online';
    if ((onlineChannel && onlineDoc) || channels.length === 0) return;

    loadingOnline = true;
    const nextChannel = channels[0];
    try {
      const nextDoc = await loadOnlineDoc(nextChannel);
      if (generation !== onlineLoadGeneration || mode !== 'online') return;
      if (!nextDoc) {
        onlineLoadError = true;
        return;
      }
      onlineChannel = nextChannel;
      onlineDoc = nextDoc;
    } catch {
      if (generation === onlineLoadGeneration && mode === 'online') {
        onlineLoadError = true;
      }
    } finally {
      if (generation === onlineLoadGeneration) loadingOnline = false;
    }
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') requestClose(); }} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-backdrop"
  onclick={(event) => { if (event.target === event.currentTarget) requestClose(); }}
>
  <div class="modal" class:styled-modal={mode === 'styled'} role="dialog" aria-modal="true" aria-label={t('publish.dialogTitle')} tabindex="-1">
    <div class="mode-bar">
      <div class="mode-group" role="radiogroup" aria-label={t('publish.modeLabel')}>
        <label class:active={mode === 'online'}>
          <input
            type="radio"
            name="publish-mode"
            value="online"
            checked={mode === 'online'}
            disabled={publishing || switchingMode}
            data-testid="publish-mode-online"
            onchange={() => { void switchMode('online'); }}
          />
          <span>{t('publish.mode.online')}</span>
        </label>
        <label class:active={mode === 'styled'}>
          <input
            type="radio"
            name="publish-mode"
            value="styled"
            checked={mode === 'styled'}
            disabled={publishing || switchingMode}
            data-testid="publish-mode-styled"
            onchange={() => { void switchMode('styled'); }}
          />
          <span>{t('publish.mode.styled')}</span>
        </label>
      </div>
      <button class="close-button" type="button" onclick={requestClose} disabled={switchingMode} aria-label={t('publish.closeDialog')}>
        <IconClose size={14} />
      </button>
    </div>

    <div class:styled-body={mode === 'styled'} class="modal-body">
      {#if mode === 'online'}
        {#if onlineChannel && onlineDoc}
          <OnlinePublishPanel
            bind:this={onlinePanel}
            channel={onlineChannel}
            doc={onlineDoc}
            {onClose}
            onPublishingChange={(value) => { publishing = value; }}
          />
        {:else if loadingOnline}
          <div class="mode-status">{t('publish.loadingOnline')}</div>
        {:else if onlineLoadError}
          <div class="mode-status" data-testid="publish-online-load-error">{t('publish.loadOnlineFailed')}</div>
        {:else}
          <div class="mode-status">{t('share.noChannels')}</div>
        {/if}
      {:else if source}
        <StyledCopyPanel {source} />
      {:else}
        <div class="mode-status" data-testid="styled-copy-error">{t('styledCopy.error.sourceUnavailable')}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--novelist-text) 40%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
  }

  .modal {
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    width: 720px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal.styled-modal {
    width: 860px;
  }

  .mode-bar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 10px;
    border-bottom: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }

  .mode-group {
    display: flex;
    gap: 1px;
    padding: 2px;
    border-radius: 5px;
    background: var(--novelist-bg-tertiary);
  }

  .mode-group label {
    position: relative;
    min-width: 112px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    color: var(--novelist-text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .mode-group label.active {
    color: var(--novelist-accent);
    background: var(--novelist-bg);
  }

  .mode-group input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .mode-group input:disabled {
    cursor: not-allowed;
  }

  .close-button {
    width: 26px;
    height: 26px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
  }

  .close-button:hover {
    color: var(--novelist-text);
    background: var(--novelist-bg-tertiary);
  }

  .modal-body {
    min-height: 0;
    padding: 16px;
    overflow-y: auto;
  }

  .modal-body.styled-body {
    padding: 0;
    overflow: hidden;
  }

  .mode-status {
    padding: 24px 16px;
    color: var(--novelist-text-secondary);
    font-size: 12px;
    text-align: center;
  }
</style>
