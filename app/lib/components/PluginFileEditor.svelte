<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { hasPluginPermission, type UIExtension } from '$lib/stores/extensions.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { collectPluginThemeVars } from '$lib/utils/plugin-theme';
  import { projectStore } from '$lib/stores/project.svelte';
  import { pathJoin, pathStartsWithChild } from '$lib/utils/path';
  import {
    normalizeSafeProjectRelativePath,
    parsePluginFileRevision,
  } from '$lib/services/plugin-file-protocol';
  import {
    pluginDocumentSessions,
    type PluginDocumentConflict,
  } from '$lib/services/plugin-document-sessions';
  import {
    PLUGIN_IFRAME_SANDBOX,
    PluginFrameConnection,
    type PluginMessage,
  } from '$lib/services/plugin-host-channel';
  import { i18n, t } from '$lib/i18n';
  import { isTranslationReferenceAbort, requestTranslationReference } from '$lib/services/translation-reference';

  const FIRST_PARTY_FILE_HANDLERS = new Set(['literary-commentary', 'book-translation']);

  let { extension, paneId = 'pane-1' }: { extension: UIExtension; paneId?: string } = $props();

  /** Identifies this iframe to the shared plugin document sessions. */
  const ownerId = crypto.randomUUID();
  /** The only trusted path to the plugin document (see plugin-host-channel.ts). */
  const connection = new PluginFrameConnection((data) => void handleMessage(data));

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  let loaded = $state(false);
  let loadFailed = $state(false);
  let iframeRevision = $state(0);
  let conflict = $state<PluginDocumentConflict | null>(null);
  let restoringConflict = $state(false);
  /** The plugin announced it applies `file-sync` in place (see plugin-system.md). */
  let supportsFileSync = false;
  /** In-flight translation references; aborted when their plugin document goes away. */
  const referenceRequests = new Set<AbortController>();

  // Host-verified bundled plugins only; manifest fields alone are not trusted.
  let firstParty = $derived(extension.builtin === true && FIRST_PARTY_FILE_HANDLERS.has(extension.pluginId));
  let canRead = $derived(hasPluginPermission(extension.permissions, 'read'));
  let canWrite = $derived(hasPluginPermission(extension.permissions, 'write'));

  function releasePluginDocument() {
    pluginDocumentSessions.release(ownerId);
    for (const controller of referenceRequests) controller.abort();
    referenceRequests.clear();
  }

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));
  // A rejected edit is only offered for the exact tab, path, and project it
  // came from; anything else (closed tab, rename, project switch) hides it.
  let visibleConflict = $derived(
    conflict
      && tab?.id === conflict.tabId
      && tab.filePath === conflict.filePath
      && projectStore.dirPath === conflict.projectPath
      ? conflict
      : null,
  );

  // Extension reloads hand this component a new descriptor object for the same
  // plugin. Only an actual entry URL change (or a retry) loads a new plugin
  // document; re-running on descriptor identity would leave a live iframe
  // stuck "loading" with every token revoked.
  let entryUrl = $derived(extension.entryUrl);

  $effect(() => {
    entryUrl;
    iframeRevision;
    // A newly loading plugin document never inherits tokens of the old one.
    connection.expectLoad();
    releasePluginDocument();
    supportsFileSync = false;
    loaded = false;
    loadFailed = false;
    const timeout = window.setTimeout(() => {
      if (!loaded) loadFailed = true;
    }, 6000);
    return () => window.clearTimeout(timeout);
  });

  onDestroy(() => {
    connection.close();
    releasePluginDocument();
  });

  function markPluginLoaded() {
    if (loaded) return;
    loaded = true;
    loadFailed = false;
    releasePluginDocument();
  }

  function handleFrameLoad() {
    const outcome = connection.handleLoad(iframeEl);
    if (outcome === 'navigated') {
      // The plugin replaced its own document; that document gets no port.
      releasePluginDocument();
      loaded = false;
      loadFailed = true;
      return;
    }
    // First-party file handlers explicitly announce readiness after their
    // application code mounts. Keep load as compatibility for external
    // plugins that predate the handshake.
    if (outcome === 'connected' && !firstParty) markPluginLoaded();
  }

  // Send the active tab's live snapshot when the tab, its reload version, its
  // project, or the shared content changes. A snapshot this iframe already
  // displays stays live through its own edits and is not re-sent; any other
  // change (sibling pane edit, reload, adoption) yields a new documentId. A
  // sibling edit of the tab already shown goes out as `file-sync` to plugins
  // that apply it in place, so the other pane keeps caret, mode and focus.
  $effect(() => {
    const activeTab = tab;
    if (!activeTab || !loaded || !canRead) return;
    activeTab.version;
    activeTab.filePath;
    activeTab.content;
    projectStore.dirPath;
    untrack(() => {
      const opened = pluginDocumentSessions.open(ownerId, activeTab.id);
      if (!opened) return;
      connection.post({
        type: opened.sync && supportsFileSync ? 'file-sync' : 'file-open',
        documentId: opened.token,
        revision: opened.revision,
        filePath: opened.filePath,
        content: opened.content,
        projectPath: opened.projectPath,
        locale: i18n.locale,
      });
    });
  });

  // Send theme updates
  $effect(() => {
    const _theme = uiStore.themeId;
    const _typography = uiStore.editorSettings;
    if (!loaded) return;
    connection.post({ type: 'theme-update', theme: collectPluginThemeVars() });
  });

  // Keep plugin chrome in sync when the host locale changes without
  // reopening the current document and resetting its editor mode.
  $effect(() => {
    const locale = i18n.locale;
    if (!loaded) return;
    connection.post({ type: 'locale-update', locale });
  });

  function postTranslationReferenceResult(
    generation: number,
    requestId: string,
    documentId: string,
    segmentId: string,
    provider: 'google' | 'llm',
    ok: boolean,
    reference: string | null,
    error: string | null,
  ) {
    connection.post({
      type: 'translation-reference-result',
      requestId,
      documentId,
      segmentId,
      provider,
      ok,
      reference,
      error,
    }, generation);
  }

  async function handleTranslationReferenceRequest(data: PluginMessage) {
    const generation = connection.generation;
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    const documentId = typeof data.documentId === 'string' ? data.documentId : '';
    const segmentId = typeof data.segmentId === 'string' ? data.segmentId : '';
    const provider = data.provider === 'google' || data.provider === 'llm' ? data.provider : null;
    const source = typeof data.source === 'string' ? data.source : null;
    const sourceLanguage = data.sourceLanguage === null || typeof data.sourceLanguage === 'string'
      ? data.sourceLanguage
      : undefined;
    const targetLanguage = typeof data.targetLanguage === 'string' ? data.targetLanguage : null;
    const requestTarget = documentId ? pluginDocumentSessions.target(ownerId, documentId) : null;
    // Spending the user's translation credentials is reserved for the bundled
    // book-translation plugin, verified by the host rather than its manifest.
    const allowed = extension.builtin === true
      && extension.pluginId === 'book-translation'
      && hasPluginPermission(extension.permissions, 'ai:http');

    if (
      !allowed
      || !requestId
      || !segmentId
      || !provider
      || !source
      || [...source].length > 30_000
      || sourceLanguage === undefined
      || !targetLanguage
      || !requestTarget
    ) {
      if (requestId && documentId && segmentId && provider) {
        postTranslationReferenceResult(
          generation,
          requestId,
          documentId,
          segmentId,
          provider,
          false,
          null,
          'Invalid translation reference request',
        );
      }
      return;
    }

    const controller = new AbortController();
    referenceRequests.add(controller);
    let outcome: { reference: string; error: null } | { reference: null; error: string };
    try {
      const reference = await requestTranslationReference({
        provider,
        source,
        sourceLanguage,
        targetLanguage,
      }, controller.signal);
      outcome = { reference, error: null };
    } catch (cause) {
      if (isTranslationReferenceAbort(cause)) return;
      outcome = { reference: null, error: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      referenceRequests.delete(controller);
    }
    // A sibling pane may have synced new content into this document while the
    // request ran; deliver under the token the iframe holds now. Anything else
    // (another tab, reload, iframe replaced) drops the result.
    const currentDocumentId = pluginDocumentSessions.displayedToken(ownerId, requestTarget);
    if (!currentDocumentId) return;
    postTranslationReferenceResult(
      generation,
      requestId,
      currentDocumentId,
      segmentId,
      provider,
      outcome.error === null,
      outcome.reference,
      outcome.error,
    );
  }

  async function openProjectFile(documentId: unknown, requestedPath: string) {
    // Navigation belongs to the session that asked for it: resolve against
    // that document's project, and drop it if the project changed meanwhile.
    const projectPath = pluginDocumentSessions.target(ownerId, documentId)?.projectPath;
    const relativePath = normalizeSafeProjectRelativePath(requestedPath);
    if (!projectPath || !relativePath) return;
    const targetPath = pathJoin(projectPath, relativePath);
    if (targetPath !== projectPath && !pathStartsWithChild(targetPath, projectPath)) return;
    const generation = projectStore.generation;
    const result = await commands.readFile(targetPath);
    if (
      result.status !== 'ok'
      || projectStore.generation !== generation
      || projectStore.dirPath !== projectPath
    ) return;
    tabsStore.openTab(targetPath, result.data);
    await commands.registerOpenFile(targetPath);
  }

  async function restoreConflict() {
    const target = visibleConflict;
    if (!target || restoringConflict) return;
    restoringConflict = true;
    try {
      const result = await pluginDocumentSessions.restore(target);
      if (!result.ok && result.error) {
        window.dispatchEvent(new CustomEvent('novelist-operation-error', {
          detail: { message: result.error },
        }));
      }
    } finally {
      restoringConflict = false;
      if (conflict === target) conflict = null;
    }
  }

  async function handleMessage(data: PluginMessage) {
    if (data.type === 'plugin-ready') {
      supportsFileSync = Array.isArray(data.capabilities) && data.capabilities.includes('file-sync');
      markPluginLoaded();
    } else if (data.type === 'translation-reference-request') {
      await handleTranslationReferenceRequest(data);
    } else if (data.type === 'file-state' && typeof data.content === 'string') {
      if (!canWrite) return;
      const result = pluginDocumentSessions.applyState(ownerId, data.documentId, data.revision, data.content);
      if (result.conflict) conflict = result.conflict;
    } else if (data.type === 'file-save' && typeof data.content === 'string') {
      const documentId = typeof data.documentId === 'string' ? data.documentId : undefined;
      const revision = parsePluginFileRevision(data.revision);
      const generation = connection.generation;
      if (!canWrite) {
        connection.post({
          type: 'file-save-result', documentId, revision, ok: false, saved: false, error: 'Plugin lacks write permission',
        });
        return;
      }
      const result = await pluginDocumentSessions.save(ownerId, data.documentId, data.revision, data.content);
      if (result.conflict) conflict = result.conflict;
      if (result.saved && firstParty && extension.pluginId === 'literary-commentary') {
        window.dispatchEvent(new CustomEvent('novelist:literary-study-saved', {
          detail: { filePath: result.filePath },
        }));
      }
      connection.post({
        type: 'file-save-result',
        documentId,
        revision,
        ok: result.ok,
        saved: result.saved,
        error: result.error,
      }, generation);
    } else if (data.type === 'mark-dirty') {
      if (canWrite) pluginDocumentSessions.markDirty(ownerId, data.documentId);
    } else if (data.type === 'open-project-file' && typeof data.relativePath === 'string') {
      await openProjectFile(data.documentId, data.relativePath);
    }
  }
</script>

<div class="plugin-file-editor">
  <!-- Sandboxed without allow-same-origin: every plugin document gets an
       opaque origin, so it can script neither the host nor sibling plugin
       frames. Messaging runs over the MessagePort handed over on load. -->
  {#key iframeRevision}
    <iframe
      bind:this={iframeEl}
      src={entryUrl}
      title={extension.label}
      sandbox={PLUGIN_IFRAME_SANDBOX}
      onload={handleFrameLoad}
    ></iframe>
  {/key}
  {#if visibleConflict}
    <div class="conflict-banner" role="alert" data-testid="plugin-file-conflict">
      <p>{t('pluginEditor.conflict')}</p>
      <div class="conflict-actions">
        <button
          type="button"
          data-testid="plugin-file-conflict-restore"
          disabled={restoringConflict}
          onclick={restoreConflict}
        >{t('pluginEditor.conflictRestore')}</button>
        <button
          type="button"
          data-testid="plugin-file-conflict-dismiss"
          disabled={restoringConflict}
          onclick={() => { conflict = null; }}
        >{t('pluginEditor.conflictDismiss')}</button>
      </div>
    </div>
  {/if}
  {#if !loaded}
    <div class="load-state" role={loadFailed ? 'alert' : 'status'} data-testid="plugin-file-load-state">
      {#if loadFailed}
        <p>{t('pluginEditor.loadFailed')}</p>
        <button type="button" onclick={() => iframeRevision += 1}>{t('pluginEditor.retry')}</button>
      {:else}
        <span class="spinner" aria-hidden="true"></span>
        <p>{t('pluginEditor.loading')}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .plugin-file-editor {
    position: relative;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  iframe {
    flex: 1;
    width: 100%;
    border: none;
    background: var(--novelist-bg);
  }
  .conflict-banner {
    position: absolute;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100% - 24px));
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-accent);
    border-radius: 8px;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.16);
  }
  .conflict-banner p {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .conflict-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  .load-state {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    color: var(--novelist-text-secondary);
    background: var(--novelist-bg);
    text-align: center;
  }
  .load-state p {
    margin: 0;
    font-size: 0.82rem;
  }
  .load-state button,
  .conflict-actions button {
    min-height: 32px;
    padding: 0 14px;
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  .load-state button:hover,
  .conflict-actions button:hover:not(:disabled) {
    border-color: var(--novelist-accent);
  }
  .conflict-actions button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--novelist-border);
    border-top-color: var(--novelist-accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation: none; }
  }
</style>
