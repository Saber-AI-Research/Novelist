<script lang="ts">
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import { projectStore } from '$lib/stores/project.svelte';
  import {
    createStyledCopyController,
    type StyledCopyControllerError,
    type StyledCopyControllerOptions,
    type StyledCopyControllerState,
    type StyledCopySource,
  } from '$lib/services/styled-copy';
  import { WECHAT_STYLE_MAPS } from '$lib/utils/styled-copy/themes';
  import type {
    StyledCopyAssetFailureReason,
    StyledCopyWarning,
    WechatTheme,
  } from '$lib/utils/styled-copy/types';
  import { t } from '$lib/i18n';

  interface Props {
    source: StyledCopySource;
  }

  let { source }: Props = $props();
  // The dialog source is deliberately frozen for this controller session.
  // svelte-ignore state_referenced_locally
  const controller = createStyledCopyController({
    source,
    projectActiveHostId: projectStore.config?.active_image_host_id,
  });
  let state = $state<StyledCopyControllerState>(controller.getState());

  const themes: WechatTheme[] = ['minimal', 'magazine', 'technical'];
  const busy = $derived(
    state.status === 'converting'
      || state.status === 'finalizing-assets'
      || state.status === 'copying',
  );
  const canCopy = $derived(Boolean(state.previewSrcdoc) && !busy && state.status !== 'error');

  onMount(() => {
    const unsubscribe = controller.subscribe((nextState) => {
      state = nextState;
    });
    void controller.requestPreview();
    return () => {
      unsubscribe();
      controller.destroy();
    };
  });

  function updateOptions(options: Partial<StyledCopyControllerOptions>): void {
    void controller.setOptions(options);
  }

  function swatchStyle(theme: WechatTheme): string {
    const map = WECHAT_STYLE_MAPS[theme];
    const ink = map.article.color ?? 'var(--novelist-text)';
    const accent = map['heading-2'].color ?? 'var(--novelist-accent)';
    const surface = map['code-block']['background-color'] ?? 'var(--novelist-bg-secondary)';
    return `--swatch-ink:${ink};--swatch-accent:${accent};--swatch-surface:${surface}`;
  }

  function warningMessage(warning: Readonly<StyledCopyWarning>): string {
    switch (warning.code) {
      case 'math_visual_degraded': return t('styledCopy.warning.math');
      case 'table_structure_degraded': return t('styledCopy.warning.table');
      case 'malformed_footnote':
      case 'duplicate_footnote': return t('styledCopy.warning.footnote');
      case 'malformed_image': return t('styledCopy.warning.image');
      case 'unsafe_link_removed':
      case 'relative_link_removed':
      case 'malformed_link': return t('styledCopy.warning.link');
    }
  }

  function failureReason(reason: StyledCopyAssetFailureReason): string {
    switch (reason) {
      case 'unsafe_source': return t('styledCopy.assetFailure.unsafeSource');
      case 'malformed_source': return t('styledCopy.assetFailure.malformedSource');
      case 'malformed_source_encoding': return t('styledCopy.assetFailure.malformedEncoding');
      case 'unresolved_source': return t('styledCopy.assetFailure.unresolvedSource');
      case 'unsupported_image_type': return t('styledCopy.assetFailure.unsupportedType');
      case 'invalid_image_bytes': return t('styledCopy.assetFailure.invalidBytes');
      case 'mermaid_source_too_large': return t('styledCopy.assetFailure.mermaidTooLarge');
      case 'mermaid_unsafe_svg': return t('styledCopy.assetFailure.mermaidUnsafe');
      case 'mermaid_invalid_dimensions': return t('styledCopy.assetFailure.mermaidDimensions');
      case 'mermaid_render_failed': return t('styledCopy.assetFailure.mermaidRender');
      case 'upload_failed': return t('styledCopy.assetFailure.upload');
      case 'invalid_hosted_url': return t('styledCopy.assetFailure.hostedUrl');
    }
  }

  function errorMessage(error: Readonly<StyledCopyControllerError>): string {
    switch (error.code) {
      case 'source_stale': return t('styledCopy.error.sourceStale');
      case 'rope_snapshot_unavailable': return t('styledCopy.error.ropeUnavailable');
      case 'pandoc_not_found': return t('styledCopy.error.pandocNotFound');
      case 'unsupported_pandoc_extensions':
        return t('styledCopy.error.pandocExtensions', {
          extensions: error.extensions.length > 0 ? error.extensions.join(', ') : t('styledCopy.error.pandocExtensionsUnknown'),
        });
      case 'pandoc_timeout': return t('styledCopy.error.pandocTimeout');
      case 'pandoc_input_too_large':
      case 'pandoc_output_too_large': return t('styledCopy.error.tooLarge');
      case 'pandoc_conversion_failed': return t('styledCopy.error.conversion');
      case 'document_too_complex': return t('styledCopy.error.tooComplex');
      case 'malformed_document': return t('styledCopy.error.malformedDocument');
      case 'malformed_table': return t('styledCopy.error.malformedTable');
      case 'sanitizer_failure': return t('styledCopy.error.sanitizer');
      case 'unresolved_asset': return t('styledCopy.error.unresolvedAsset');
      case 'resolved_asset_mode_mismatch': return t('styledCopy.error.assetMode');
      case 'image_host_unavailable': return t('styledCopy.error.imageHost');
      case 'asset_resolution_failed': return t('styledCopy.error.assets');
      case 'asset_upload_failed': return t('styledCopy.error.upload');
      case 'clipboard_write_failed': return t('styledCopy.error.clipboard');
      case 'invalid_clipboard_payload': return t('styledCopy.error.clipboardPayload');
    }
  }
</script>

<div class="styled-panel">
  <div class="controls">
    <fieldset>
      <legend>{t('styledCopy.target')}</legend>
      <div class="segment-group">
        <label class:active={state.options.target === 'wechat'}>
          <input
            type="radio"
            name="styled-target"
            data-testid="styled-target-wechat"
            checked={state.options.target === 'wechat'}
            onchange={() => updateOptions({ target: 'wechat' })}
          />
          <span>{t('styledCopy.target.wechat')}</span>
        </label>
        <label class:active={state.options.target === 'zhihu'}>
          <input
            type="radio"
            name="styled-target"
            data-testid="styled-target-zhihu"
            checked={state.options.target === 'zhihu'}
            onchange={() => updateOptions({ target: 'zhihu' })}
          />
          <span>{t('styledCopy.target.zhihu')}</span>
        </label>
      </div>
    </fieldset>

    <fieldset>
      <legend>{t('styledCopy.scope')}</legend>
      <div class="segment-group">
        <label class:active={state.options.scope === 'selection'} class:disabled={!state.selectionAvailable}>
          <input
            type="radio"
            name="styled-scope"
            data-testid="styled-scope-selection"
            checked={state.options.scope === 'selection'}
            disabled={!state.selectionAvailable}
            onchange={() => updateOptions({ scope: 'selection' })}
          />
          <span>{t('styledCopy.scope.selection')}</span>
        </label>
        <label class:active={state.options.scope === 'full-document'}>
          <input
            type="radio"
            name="styled-scope"
            data-testid="styled-scope-full"
            checked={state.options.scope === 'full-document'}
            onchange={() => updateOptions({ scope: 'full-document' })}
          />
          <span>{t('styledCopy.scope.full')}</span>
        </label>
      </div>
    </fieldset>

    {#if state.options.target === 'wechat'}
      <fieldset>
        <legend>{t('styledCopy.theme')}</legend>
        <div class="theme-group">
          {#each themes as theme}
            <label class="theme-option" class:active={state.options.wechatTheme === theme} style={swatchStyle(theme)}>
              <input
                type="radio"
                name="styled-theme"
                data-testid="styled-theme-{theme}"
                checked={state.options.wechatTheme === theme}
                onchange={() => updateOptions({ wechatTheme: theme })}
              />
              <span class="theme-swatch" aria-hidden="true">
                <span></span><span></span><span></span>
              </span>
              <span>{t(`styledCopy.theme.${theme}`)}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    {/if}

    <label class="select-field">
      <span>{t('styledCopy.linkMode')}</span>
      <select
        data-testid="styled-link-mode"
        value={state.options.linkMode}
        onchange={(event) => updateOptions({
          linkMode: event.currentTarget.value as StyledCopyControllerOptions['linkMode'],
        })}
      >
        <option value="target-default">
          {state.options.target === 'wechat'
            ? t('styledCopy.linkMode.targetDefaultReferences')
            : t('styledCopy.linkMode.targetDefaultAnchors')}
        </option>
        <option value="anchors">{t('styledCopy.linkMode.anchors')}</option>
        <option value="end-references">{t('styledCopy.linkMode.endReferences')}</option>
      </select>
    </label>

    <div class="messages" aria-live="polite">
      {#each state.warnings as warning}
        <div class="message warning" data-testid="styled-copy-warning">{warningMessage(warning)}</div>
      {/each}
      {#if state.error}
        <div class="message error" data-testid="styled-copy-error">
          <div>{errorMessage(state.error)}</div>
          {#if 'failures' in state.error}
            {#each state.error.failures as failure}
              <div>{t('styledCopy.assetFailure', { id: failure.assetId, reason: failureReason(failure.reason) })}</div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <button
      type="button"
      class="novelist-btn novelist-btn-primary copy-button"
      data-testid="styled-copy-copy"
      disabled={!canCopy}
      onclick={() => { void controller.copy(); }}
    >
      {#if busy}
        <LoaderCircle class="spin" size={14} aria-hidden="true" />
        <span>{state.status === 'converting' ? t('styledCopy.converting') : t('styledCopy.copying')}</span>
      {:else if state.status === 'copied'}
        <Check size={14} aria-hidden="true" />
        <span>{t('styledCopy.copied')}</span>
      {:else}
        <Copy size={14} aria-hidden="true" />
        <span>{t('styledCopy.copy')}</span>
      {/if}
    </button>
  </div>

  <div class="preview-region">
    {#if state.previewSrcdoc}
      <iframe
        data-testid="styled-copy-preview"
        title={t('styledCopy.preview')}
        srcdoc={state.previewSrcdoc}
        sandbox=""
        referrerpolicy="no-referrer"
      ></iframe>
    {:else}
      <div class="preview-status">{state.status === 'error' ? t('styledCopy.previewUnavailable') : t('styledCopy.converting')}</div>
    {/if}
  </div>
</div>

<style>
  .styled-panel {
    height: min(620px, calc(100vh - 100px));
    min-height: 420px;
    display: grid;
    grid-template-columns: 224px minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
    box-sizing: border-box;
  }

  .controls {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend,
  .select-field > span {
    display: block;
    margin-bottom: 4px;
    color: var(--novelist-text-secondary);
    font-size: 11px;
  }

  .segment-group {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    padding: 2px;
    border-radius: 5px;
    background: var(--novelist-bg-tertiary);
  }

  .segment-group label,
  .theme-option {
    position: relative;
    cursor: pointer;
  }

  .segment-group label {
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    color: var(--novelist-text-secondary);
    font-size: 11px;
  }

  .segment-group label.active {
    color: var(--novelist-accent);
    background: var(--novelist-bg);
  }

  .segment-group label.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .segment-group input,
  .theme-option input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }

  .theme-group {
    display: grid;
    gap: 4px;
  }

  .theme-option {
    height: 34px;
    display: grid;
    grid-template-columns: 46px 1fr;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    color: var(--novelist-text-secondary);
    font-size: 11px;
    box-sizing: border-box;
  }

  .theme-option.active {
    border-color: var(--novelist-accent);
    color: var(--novelist-text);
    background: var(--novelist-accent-soft);
  }

  .theme-swatch {
    height: 20px;
    display: grid;
    grid-template-columns: 5px 1fr;
    grid-template-rows: repeat(2, 1fr);
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--novelist-border);
    background: var(--swatch-surface);
    box-sizing: border-box;
  }

  .theme-swatch span:first-child {
    grid-row: 1 / 3;
    background: var(--swatch-accent);
  }

  .theme-swatch span:nth-child(2) {
    background: var(--swatch-ink);
  }

  .theme-swatch span:last-child {
    background: var(--swatch-accent);
  }

  .select-field select {
    width: 100%;
    height: 30px;
    padding: 0 24px 0 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    font-size: 11px;
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .message {
    padding: 6px 8px;
    border-left: 3px solid var(--novelist-accent);
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text-secondary);
    font-size: 11px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--novelist-text);
  }

  .copy-button {
    width: 112px;
    height: 32px;
    flex: 0 0 32px;
    align-self: flex-end;
    margin-top: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 12px;
  }

  .copy-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  :global(.spin) {
    animation: spin 800ms linear infinite;
  }

  .preview-region {
    min-width: 0;
    min-height: 0;
    display: flex;
    border-left: 1px solid var(--novelist-border);
    padding-left: 12px;
  }

  iframe {
    width: 100%;
    min-height: 0;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
  }

  .preview-status {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--novelist-text-secondary);
    font-size: 12px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.spin) { animation: none; }
  }
</style>
