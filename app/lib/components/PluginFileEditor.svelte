<script lang="ts">
  import { untrack } from 'svelte';
  import type { UIExtension } from '$lib/stores/extensions.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { pathJoin, pathStartsWithChild } from '$lib/utils/path';
  import {
    normalizeSafeProjectRelativePath,
    parsePluginFileRevision,
    shouldMarkPluginFileSaved,
  } from '$lib/services/plugin-file-protocol';
  import { t } from '$lib/i18n';

  let { extension, paneId = 'pane-1' }: { extension: UIExtension; paneId?: string } = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  let loaded = $state(false);
  let lastFileOpenKey = '';
  const issuedDocuments = new Map<string, string>();
  const documentSessions = new Map<string, {
    token: string;
    version: number;
    filePath: string;
    projectPath: string | null;
  }>();
  const latestDocumentTokenByTab = new Map<string, string>();
  const latestRevisionByDocument = new Map<string, number>();
  const saveQueues = new Map<string, Promise<void>>();

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));

  // Send file content to plugin when tab changes or iframe loads
  $effect(() => {
    const activeTab = tab;
    const projectPath = projectStore.dirPath;
    if (!activeTab || !iframeEl?.contentWindow || !loaded) return;
    const openKey = JSON.stringify([
      activeTab.id,
      activeTab.version,
      activeTab.filePath,
      projectPath,
    ]);
    if (openKey === lastFileOpenKey) return;
    lastFileOpenKey = openKey;
    const existingSession = documentSessions.get(activeTab.id);
    const session = existingSession
      && existingSession.version === activeTab.version
      && existingSession.filePath === activeTab.filePath
      && existingSession.projectPath === projectPath
      ? existingSession
      : {
          token: crypto.randomUUID(),
          version: activeTab.version,
          filePath: activeTab.filePath,
          projectPath,
        };
    documentSessions.set(activeTab.id, session);
    const documentToken = session.token;
    issuedDocuments.set(documentToken, activeTab.id);
    latestDocumentTokenByTab.set(activeTab.id, documentToken);
    const revision = latestRevisionByDocument.get(documentToken) ?? 0;
    latestRevisionByDocument.set(documentToken, revision);
    iframeEl.contentWindow.postMessage({
      type: 'file-open',
      documentId: documentToken,
      revision,
      filePath: activeTab.filePath,
      content: untrack(() => activeTab.content ?? ''),
      projectPath,
    }, '*');
  });

  // Send theme updates
  $effect(() => {
    const _theme = uiStore.themeId;
    if (!iframeEl?.contentWindow || !loaded) return;
    const styles = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const prop of [
      '--novelist-bg',
      '--novelist-bg-secondary',
      '--novelist-bg-tertiary',
      '--novelist-text',
      '--novelist-text-secondary',
      '--novelist-text-tertiary',
      '--novelist-accent',
      '--novelist-border',
      '--novelist-error',
    ]) {
      vars[prop] = styles.getPropertyValue(prop);
    }
    iframeEl.contentWindow.postMessage({ type: 'theme-update', theme: vars }, '*');
  });

  function resolveMessageTab(data: Record<string, unknown>) {
    if (typeof data.documentId === 'string') {
      const tabId = issuedDocuments.get(data.documentId);
      if (!tabId) return null;
      return tabsStore.allTabs.find((candidate) => candidate.id === tabId) ?? null;
    }
    return tab;
  }

  async function enqueueSave(tabId: string, task: () => Promise<void>) {
    const previous = saveQueues.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    saveQueues.set(tabId, next);
    try {
      await next;
    } finally {
      if (saveQueues.get(tabId) === next) saveQueues.delete(tabId);
    }
  }

  function postSaveResult(
    documentId: string | undefined,
    revision: number | null,
    ok: boolean,
    saved: boolean,
    error: string | null,
  ) {
    iframeEl?.contentWindow?.postMessage({
      type: 'file-save-result',
      documentId,
      revision,
      ok,
      saved,
      error,
    }, '*');
  }

  async function handleMessage(event: MessageEvent) {
    if (event.source !== iframeEl?.contentWindow) return;
    const data = event.data as Record<string, unknown>;

    if (data?.type === 'file-state' && typeof data.content === 'string') {
      const targetTab = resolveMessageTab(data);
      if (!targetTab) return;
      const revision = parsePluginFileRevision(data.revision);
      if (typeof data.documentId === 'string' && revision !== null) {
        const latest = latestRevisionByDocument.get(data.documentId) ?? -1;
        if (revision < latest) return;
        latestRevisionByDocument.set(data.documentId, revision);
      }
      tabsStore.updateContent(targetTab.id, data.content);
    } else if (data?.type === 'file-save' && typeof data.content === 'string') {
      const targetTab = resolveMessageTab(data);
      if (!targetTab) return;
      const tabId = targetTab.id;
      const documentId = typeof data.documentId === 'string' ? data.documentId : undefined;
      const revision = parsePluginFileRevision(data.revision);
      if (documentId && revision !== null) {
        const latest = latestRevisionByDocument.get(documentId) ?? -1;
        latestRevisionByDocument.set(documentId, Math.max(latest, revision));
      }
      await enqueueSave(tabId, async () => {
        const liveTab = tabsStore.allTabs.find((candidate) => candidate.id === tabId);
        if (!liveTab) {
          postSaveResult(documentId, revision, false, false, 'Plugin document is no longer open');
          return;
        }
        if (
          documentId
          && (
            latestDocumentTokenByTab.get(tabId) !== documentId
            || (revision !== null && (latestRevisionByDocument.get(documentId) ?? revision) > revision)
          )
        ) {
          postSaveResult(documentId, revision, true, false, null);
          return;
        }
        await commands.registerWriteIgnore(liveTab.filePath);
        const result = await commands.writeFile(liveTab.filePath, data.content as string);
        const saved = result.status === 'ok' && (
          documentId
            ? shouldMarkPluginFileSaved(
                latestDocumentTokenByTab.get(tabId),
                documentId,
                latestRevisionByDocument.get(documentId),
                revision,
                liveTab.content,
                data.content as string,
              )
            : liveTab.content === data.content
        );
        if (saved) tabsStore.markSaved(tabId);
        postSaveResult(
          documentId,
          revision,
          result.status === 'ok',
          saved,
          result.status === 'error' ? result.error : null,
        );
      });
    } else if (data?.type === 'mark-dirty') {
      if (tab) tabsStore.markDirty(tab.id);
    } else if (data?.type === 'open-project-file' && typeof data.relativePath === 'string') {
      const projectPath = projectStore.dirPath;
      const relativePath = normalizeSafeProjectRelativePath(data.relativePath);
      if (!projectPath || !relativePath) return;
      const targetPath = pathJoin(projectPath, relativePath);
      if (targetPath !== projectPath && !pathStartsWithChild(targetPath, projectPath)) return;
      const result = await commands.readFile(targetPath);
      if (result.status !== 'ok') return;
      tabsStore.openTab(targetPath, result.data);
      await commands.registerOpenFile(targetPath);
    }
  }
</script>

<svelte:window onmessage={handleMessage} />

<div class="plugin-file-editor">
  <!-- No sandbox: WKWebView blocks custom-protocol main-resource loads from
       sandboxed iframes, which breaks file-handler plugins served via asset://. -->
  <iframe
    bind:this={iframeEl}
    src={extension.entryUrl}
    title={extension.label}
    onload={() => {
      loaded = true;
      lastFileOpenKey = '';
      issuedDocuments.clear();
      documentSessions.clear();
      latestDocumentTokenByTab.clear();
      latestRevisionByDocument.clear();
    }}
  ></iframe>
</div>

<style>
  .plugin-file-editor {
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
</style>
