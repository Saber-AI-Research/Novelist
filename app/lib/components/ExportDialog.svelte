<script lang="ts">
  import { onMount } from 'svelte';
  import { save } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { collectExportFiles } from '$lib/utils/export-files';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { EXPORT_CSS_STAGE_ERROR, stageThemeCssForExport } from '$lib/services/export-css';
  import { formatCleanupWarning, formatExportError } from '$lib/utils/export-errors';
  import { t } from '$lib/i18n';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  let pandocAvailable = $state(false);
  let pandocVersion = $state('');
  let pandocResolvedPath = $state('');
  let format = $state('html');
  let includeTheme = $state(true);
  let status = $state<'idle' | 'exporting' | 'success' | 'warning' | 'error'>('idle');
  let message = $state('');
  let exportFileCount = $state(0);
  let activeExportRequestId = $state<string | null>(null);
  let cancelRequested = $state(false);
  let backendExportStarted = $state(false);
  let backendCancelDecision: Promise<boolean> | null = null;
  let preflightActive = $state(false);
  let preflightGeneration = 0;
  let busy = $derived(preflightActive || status === 'exporting');

  const formats = [
    { value: 'html', label: 'HTML' },
    { value: 'pdf', label: 'PDF' },
    { value: 'docx', label: 'DOCX (Word)' },
    { value: 'epub', label: 'EPUB' },
  ];

  onMount(async () => {
    const result = await commands.checkPandoc();
    if (result.status === 'ok') {
      pandocAvailable = result.data.available;
      pandocVersion = result.data.version || '';
      pandocResolvedPath = result.data.resolved_path || '';
    }
  });

  async function doExport() {
    if (busy) return;
    preflightActive = true;
    const generation = ++preflightGeneration;
    try {
      await performExport(generation);
    } catch {
      if (generation !== preflightGeneration) return;
      activeExportRequestId = null;
      backendExportStarted = false;
      backendCancelDecision = null;
      cancelRequested = false;
      status = 'error';
      message = formatExportError('');
    } finally {
      if (generation === preflightGeneration) preflightActive = false;
    }
  }

  async function performExport(generation: number) {
    if (!await tabsStore.saveAllDirty()) {
      if (generation !== preflightGeneration) return;
      status = 'error';
      message = t('export.saveFailed');
      return;
    }
    if (generation !== preflightGeneration) return;
    // Project mode → all markdown files; standalone mode → the active file.
    const files = collectExportFiles(projectStore.dirPath, projectStore.files, tabsStore.activeTab);

    if (files.length === 0 && !projectStore.dirPath) {
      message = projectStore.dirPath ? t('export.noFiles') : t('export.noActiveFile');
      status = 'error';
      return;
    }

    // Ask for output path
    const ext = format === 'html' ? 'html' : format;
    const outputPath = await save({
      defaultPath: `export.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (generation !== preflightGeneration) return;
    if (!outputPath) return;

    status = 'exporting';
    message = '';
    exportFileCount = files.length;
    cancelRequested = false;
    backendCancelDecision = null;
    const requestId = makeExportRequestId();
    activeExportRequestId = requestId;

    // Build extra args for the backend-owned HTML theme header.
    const extraArgs: string[] = [];
    if (format === 'html' && includeTheme) {
      const cssStage = await stageThemeCssForExport(uiStore.currentTheme, {
        stageCss: commands.stageExportCss,
        deleteItem: commands.deleteItem,
        requestId,
        isCancelled: () => activeExportRequestId !== requestId || cancelRequested,
        warn: (warning) => console.warn(warning),
      });
      if (cssStage.status === 'cancelled') {
        activeExportRequestId = null;
        cancelRequested = false;
        status = cssStage.warning ? 'warning' : 'idle';
        message = cssStage.warning ?? '';
        return;
      }
      if (cssStage.status === 'error') {
        activeExportRequestId = null;
        cancelRequested = false;
        status = 'error';
        message = EXPORT_CSS_STAGE_ERROR;
        return;
      }
      extraArgs.push(...cssStage.args);
    }

    if (activeExportRequestId !== requestId || cancelRequested) {
      activeExportRequestId = null;
      cancelRequested = false;
      status = 'idle';
      return;
    }

    backendExportStarted = true;
    const result = await commands.exportProject(
      files,
      outputPath,
      format,
      extraArgs,
      requestId,
      projectStore.dirPath,
    );
    backendExportStarted = false;
    const cancellationAccepted = backendCancelDecision ? await backendCancelDecision : false;
    if (activeExportRequestId !== requestId) return;
    activeExportRequestId = null;
    backendCancelDecision = null;
    if (cancellationAccepted) {
      cancelRequested = false;
      status = 'idle';
      message = '';
      return;
    }
    cancelRequested = false;
    if (result.status === 'ok') {
      if (result.data.warning) {
        status = 'warning';
        message = formatCleanupWarning(result.data.message, result.data.warning);
      } else {
        status = 'success';
        message = result.data.message;
      }
    } else {
      status = 'error';
      message = formatExportError(result.error);
    }
  }

  async function cancelExport() {
    if (!activeExportRequestId || cancelRequested) return;
    cancelRequested = true;
    message = '';
    if (!backendExportStarted) return;
    const decision = commands.cancelExportProject(activeExportRequestId).then((result) => {
      if (result.status === 'error') {
        console.warn('Export cancellation request failed; waiting for the export result.');
        return false;
      }
      return result.data;
    });
    backendCancelDecision = decision;
    const accepted = await decision;
    if (backendCancelDecision !== decision) return;
    if (!accepted) {
      cancelRequested = false;
    }
  }

  function closeOrCancel() {
    if (status === 'exporting') {
      void cancelExport();
      return;
    }
    if (preflightActive) {
      preflightGeneration += 1;
      preflightActive = false;
    }
    onClose();
  }

  function makeExportRequestId(): string {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `export-${random}`;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeOrCancel();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Overlay -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  role="dialog"
  aria-modal="true"
  aria-labelledby="export-dialog-title"
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-lg shadow-xl p-6 w-full mx-4"
    style="
      max-width: 420px;
      background: var(--novelist-bg);
      color: var(--novelist-text);
      border: 1px solid var(--novelist-border);
    "
    onclick={(e) => e.stopPropagation()}
  >
    <h2 id="export-dialog-title" class="text-base font-semibold mb-4">
      {t('export.title')}
    </h2>

    <!-- Pandoc status -->
    <div
      class="rounded px-3 py-2 mb-5 text-sm"
      style="
        background: var(--novelist-bg-secondary);
        border: 1px solid var(--novelist-border);
      "
    >
      {#if pandocAvailable}
        <span style="color: #4ade80;">&#x2713; {t('export.pandocAvailable')}</span>
        {#if pandocVersion}
          <span style="color: var(--novelist-text-secondary);"> &mdash; {pandocVersion}</span>
        {/if}
        {#if pandocResolvedPath}
          <span class="pandoc-resolved-path">{pandocResolvedPath}</span>
        {/if}
      {:else}
        <span style="color: #f87171;">&#x2717; {t('export.pandocNotFound')}</span>
        <p class="mt-1" style="color: var(--novelist-text-secondary);">
          {t('export.pandocInstall')}
        </p>
      {/if}
    </div>

    <!-- Format selector -->
    <div class="mb-5">
      <p class="block text-sm mb-2" style="color: var(--novelist-text-secondary);">
        {t('export.format')}
      </p>
      <div class="flex gap-2 flex-wrap">
        {#each formats as f}
          <button
            class="px-3 py-1 rounded text-sm cursor-pointer"
            style="
              border: 1px solid {format === f.value ? 'var(--novelist-accent)' : 'var(--novelist-border)'};
              background: {format === f.value ? 'color-mix(in srgb, var(--novelist-accent) 20%, transparent)' : 'transparent'};
              color: {format === f.value ? 'var(--novelist-accent)' : 'var(--novelist-text)'};
  opacity: {busy ? '0.5' : '1'};
  cursor: {busy ? 'not-allowed' : 'pointer'};
            "
            onclick={() => { format = f.value; status = 'idle'; message = ''; }}
  disabled={busy}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Theme option (HTML) -->
    {#if format === 'html'}
      <label class="flex items-center gap-2 mb-4 text-sm cursor-pointer" style="color: var(--novelist-text-secondary);">
        <input
          type="checkbox"
          bind:checked={includeTheme}
          class="cursor-pointer"
    disabled={busy}
        />
        {t('export.includeTheme')} ({uiStore.currentTheme.name})
      </label>
    {/if}

    <!-- Status message -->
    {#if status === 'exporting'}
      <div class="mb-4">
        <p class="text-sm mb-2" style="color: var(--novelist-text-secondary);">
          {t('export.exporting', { count: exportFileCount })}&hellip;
        </p>
        <div class="export-progress-track">
          <div class="export-progress-bar"></div>
        </div>
      </div>
    {:else if status === 'success'}
      <p data-testid="export-status-success" class="text-sm mb-4 whitespace-pre-wrap" style="color: #4ade80;">
        {message}
      </p>
    {:else if status === 'warning'}
      <p data-testid="export-status-warning" class="text-sm mb-4 whitespace-pre-wrap" style="color: #fbbf24;">
        {message}
      </p>
    {:else if status === 'error'}
      <p data-testid="export-status-error" class="text-sm mb-4 whitespace-pre-wrap" style="color: #f87171;">
        {message}
      </p>
    {/if}

    <!-- Actions -->
    <div class="flex gap-3 justify-end">
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="
          background: var(--novelist-bg-secondary);
          color: var(--novelist-text);
          border: 1px solid var(--novelist-border);
        "
        onclick={closeOrCancel}
      >
        {status === 'exporting' ? (cancelRequested ? t('export.cancelling') : t('export.cancel')) : t('export.close')}
      </button>
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="
          background: var(--novelist-accent);
          color: #fff;
  opacity: {!pandocAvailable || busy ? '0.5' : '1'};
  cursor: {!pandocAvailable || busy ? 'not-allowed' : 'pointer'};
        "
  disabled={!pandocAvailable || busy}
        onclick={doExport}
      >
        {status === 'exporting' ? t('export.exportingButton') : t('export.export')}
      </button>
    </div>
  </div>
</div>

<style>
  .export-progress-track {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--novelist-bg-secondary);
    overflow: hidden;
  }

  .pandoc-resolved-path {
    display: block;
    margin-top: 0.25rem;
    color: var(--novelist-text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }

  .export-progress-bar {
    width: 40%;
    height: 100%;
    border-radius: 2px;
    background: var(--novelist-accent);
    animation: export-indeterminate 1.4s ease-in-out infinite;
  }

  @keyframes export-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    50% {
      transform: translateX(150%);
    }
    100% {
      transform: translateX(-100%);
    }
  }
</style>
