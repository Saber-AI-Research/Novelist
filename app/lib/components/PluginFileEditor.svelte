<script lang="ts">
  import type { UIExtension } from '$lib/stores/extensions.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { t } from '$lib/i18n';

  let { extension, paneId = 'pane-1' }: { extension: UIExtension; paneId?: string } = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  let loaded = $state(false);

  let tab = $derived(tabsStore.getPaneActiveTab(paneId));

  // Send file content to plugin when tab changes or iframe loads
  $effect(() => {
    if (!tab || !iframeEl?.contentWindow || !loaded) return;
    iframeEl.contentWindow.postMessage({
      type: 'file-open',
      filePath: tab.filePath,
      content: tab.content ?? '',
    }, '*');
  });

  // Send theme updates
  $effect(() => {
    const _theme = uiStore.themeId;
    if (!iframeEl?.contentWindow || !loaded) return;
    const styles = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const prop of ['--novelist-bg', '--novelist-bg-secondary', '--novelist-text', '--novelist-text-secondary', '--novelist-accent', '--novelist-border']) {
      vars[prop] = styles.getPropertyValue(prop);
    }
    iframeEl.contentWindow.postMessage({ type: 'theme-update', theme: vars }, '*');
  });

  async function handleMessage(event: MessageEvent) {
    if (event.source !== iframeEl?.contentWindow) return;
    const data = event.data;

    if (data?.type === 'file-save' && data.filePath && typeof data.content === 'string') {
      await commands.registerWriteIgnore(data.filePath);
      await commands.writeFile(data.filePath, data.content);
      const activeTab = tab;
      if (activeTab) {
        tabsStore.updateContent(activeTab.id, data.content);
        tabsStore.markSaved(activeTab.id);
      }
    } else if (data?.type === 'mark-dirty') {
      if (tab) tabsStore.markDirty(tab.id);
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
    onload={() => loaded = true}
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
