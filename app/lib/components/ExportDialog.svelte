<script lang="ts">
  import { onMount } from 'svelte';
  import { save } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { collectExportFiles } from '$lib/utils/export-files';
  import { isScratchFile } from '$lib/utils/scratch';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { platform } from '$lib/stores/platform.svelte';
  import { shareFile } from '$lib/services/share';
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

  /**
   * Mobile has no pandoc (no external processes): the current document is
   * exported as Markdown/HTML, or the project as a .zip, into the share
   * staging dir and handed to the native share sheet.
   */
  const shareExport = platform.isMobile;
  type ShareFormat = 'markdown' | 'html';
  type ExportPathResult = { status: 'ok'; data: string } | { status: 'error'; error: string };
  const shareFormats: { value: ShareFormat; label: string }[] = [
    { value: 'markdown', label: 'Markdown' },
    { value: 'html', label: 'HTML' },
  ];
  let documentFormat = $state<ShareFormat>('markdown');
  let shareStatus = $state<'idle' | 'preparing' | 'sharing' | 'error'>('idle');
  let shareError = $state('');
  let shareBusy = $derived(shareStatus === 'preparing' || shareStatus === 'sharing');
  let shareableDocument = $derived.by(() => {
    const tab = tabsStore.activeTab;
    if (!tab?.filePath || isScratchFile(tab.filePath) || !/\.(?:md|markdown)$/i.test(tab.filePath)) return null;
    return tab;
  });

  onMount(async () => {
    if (shareExport) return;
    const result = await commands.checkPandoc();
    if (result.status === 'ok') {
      pandocAvailable = result.data.available;
      pandocVersion = result.data.version || '';
      pandocResolvedPath = result.data.resolved_path || '';
    }
  });

  function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }

  function failShare(text: string) {
    shareStatus = 'error';
    shareError = text;
  }

  /** Save edits, export into the share staging dir, then open the share sheet. */
  async function runShareExport(exportFile: () => Promise<ExportPathResult>) {
    if (shareBusy) return;
    shareStatus = 'preparing';
    shareError = '';
    let exported: ExportPathResult;
    try {
      if (!await tabsStore.saveAllDirty()) {
        failShare(t('export.saveFailed'));
        return;
      }
      exported = await exportFile();
    } catch (cause) {
      failShare(t('export.exportFailed', { error: errorText(cause) }));
      return;
    }
    if (exported.status === 'error') {
      failShare(t('export.exportFailed', { error: exported.error }));
      return;
    }
    shareStatus = 'sharing';
    try {
      // Completed / cancelled / dismissed are all neutral: the sheet closed, nothing to report.
      await shareFile(exported.data);
    } catch (cause) {
      failShare(t('export.shareFailed', { error: errorText(cause) }));
      return;
    }
    shareStatus = 'idle';
  }

  function shareDocument() {
    void runShareExport(async () => {
      // Read the path after saving: an H1 rename on save can move the file.
      const filePath = tabsStore.activeTab?.filePath;
      if (!filePath) return { status: 'error', error: t('export.noActiveFile') };
      return commands.exportLibraryDocument(filePath, documentFormat);
    });
  }

  function shareProjectZip() {
    const projectDir = projectStore.dirPath;
    if (!projectDir) return;
    void runShareExport(() => commands.exportLibraryProject(projectDir));
  }

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
        discardStagedCss: commands.discardStagedExportCss,
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
      if (extraArgs.length > 0) void commands.discardStagedExportCss(requestId);
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
    // The share export has no cancel: keep the dialog until the sheet settles.
    if (shareBusy) return;
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
  class="export-overlay fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  role="dialog"
  aria-modal="true"
  aria-labelledby="export-dialog-title"
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="export-card rounded-lg shadow-xl p-6 w-full mx-4"
    style="
      background: var(--novelist-bg);
      color: var(--novelist-text);
      border: 1px solid var(--novelist-border);
    "
    onclick={(e) => e.stopPropagation()}
  >
    <h2 id="export-dialog-title" class="text-base font-semibold mb-4">
      {t(shareExport ? 'export.shareTitle' : 'export.title')}
    </h2>

    {#if shareExport}
      {#if shareableDocument}
        <div class="mb-5" data-testid="export-share-document-section">
          <p class="block text-sm mb-2" style="color: var(--novelist-text-secondary);">
            {t('export.currentDocument')}
          </p>
          <p class="share-file-name text-sm mb-2">{shareableDocument.fileName}</p>
          <div class="flex gap-2 flex-wrap mb-3">
            {#each shareFormats as f}
              <button
                class="px-3 py-1 rounded text-sm cursor-pointer"
                style="
                  border: 1px solid {documentFormat === f.value ? 'var(--novelist-accent)' : 'var(--novelist-border)'};
                  background: {documentFormat === f.value ? 'color-mix(in srgb, var(--novelist-accent) 20%, transparent)' : 'transparent'};
                  color: {documentFormat === f.value ? 'var(--novelist-accent)' : 'var(--novelist-text)'};
                  opacity: {shareBusy ? '0.5' : '1'};
                "
                data-testid="export-document-format-{f.value}"
                aria-pressed={documentFormat === f.value}
                disabled={shareBusy}
                onclick={() => { documentFormat = f.value; }}
              >
                {f.label}
              </button>
            {/each}
          </div>
          <button
            class="share-action-btn px-4 py-2 text-sm rounded cursor-pointer"
            style="background: var(--novelist-accent); color: #fff; opacity: {shareBusy ? '0.5' : '1'};"
            data-testid="export-share-document"
            disabled={shareBusy}
            onclick={shareDocument}
          >
            {t('export.shareDocument')}
          </button>
        </div>
      {/if}

      {#if projectStore.dirPath}
        <div class="mb-5">
          <p class="block text-sm mb-2" style="color: var(--novelist-text-secondary);">
            {t('export.wholeProject')}
          </p>
          <button
            class="share-action-btn px-4 py-2 text-sm rounded cursor-pointer"
            style="background: var(--novelist-accent); color: #fff; opacity: {shareBusy ? '0.5' : '1'};"
            data-testid="export-share-project-zip"
            disabled={shareBusy}
            onclick={shareProjectZip}
          >
            {t('export.shareProjectZip')}
          </button>
        </div>
      {/if}

      {#if !shareableDocument && !projectStore.dirPath}
        <p class="text-sm mb-4" style="color: var(--novelist-text-secondary);">{t('export.nothingToShare')}</p>
      {/if}

      {#if shareBusy}
        <div class="mb-4" data-testid="export-share-progress">
          <p class="text-sm mb-2" style="color: var(--novelist-text-secondary);">
            {shareStatus === 'sharing' ? t('export.sharing') : t('export.preparingShare')}
          </p>
          <div class="export-progress-track">
            <div class="export-progress-bar"></div>
          </div>
        </div>
      {:else if shareStatus === 'error'}
        <p data-testid="export-status-error" role="alert" class="text-sm mb-4 whitespace-pre-wrap" style="color: #f87171;">
          {shareError}
        </p>
      {/if}

      <div class="flex gap-3 justify-end">
        <button
          class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
          style="
            background: var(--novelist-bg-secondary);
            color: var(--novelist-text);
            border: 1px solid var(--novelist-border);
            opacity: {shareBusy ? '0.5' : '1'};
          "
          disabled={shareBusy}
          onclick={closeOrCancel}
        >
          {t('export.close')}
        </button>
      </div>
    {:else}

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
    {/if}
  </div>
</div>

<style>
  .export-card {
    max-width: 420px;
  }

  .share-file-name {
    color: var(--novelist-text);
    overflow-wrap: anywhere;
  }

  .share-action-btn {
    width: 100%;
  }
  .share-action-btn:disabled {
    cursor: not-allowed;
  }

  /* Mobile: the overlay tracks the visual viewport; phones get a bottom sheet. */
  :global(html[data-mobile='true']) .export-overlay {
    top: var(--novelist-vv-top, 0px);
    bottom: auto;
    height: var(--novelist-vv-height, 100dvh);
  }
  :global(html[data-mobile='true']) .export-card {
    max-height: calc(100% - 32px);
    overflow-y: auto;
  }
  :global(html[data-mobile='true']) .export-card button {
    min-height: 44px;
  }
  :global(html[data-layout='phone']) .export-overlay {
    align-items: flex-end;
  }
  :global(html[data-layout='phone']) .export-card {
    max-width: none;
    max-height: 100%;
    margin: 0;
    overflow-y: auto;
    border-radius: 12px 12px 0 0;
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
  }

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
