<script lang="ts">
  import type { UIExtension } from '$lib/stores/extensions.svelte';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';

  let { extension, onNavigate }: { extension: UIExtension; onNavigate?: (from: number) => void } = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);

  // Send content updates to the plugin iframe
  $effect(() => {
    const tab = tabsStore.activeTab;
    if (!tab || !iframeEl?.contentWindow) return;
    const view = getEditorView(tab.id);
    const content = view?.state.doc.toString() ?? tab.content ?? '';
    iframeEl.contentWindow.postMessage({ type: 'content-update', content }, '*');
  });

  // Send theme updates
  $effect(() => {
    // Track theme changes
    const _theme = uiStore.themeId;
    if (!iframeEl?.contentWindow) return;
    const styles = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const prop of ['--novelist-bg', '--novelist-bg-secondary', '--novelist-text', '--novelist-text-secondary', '--novelist-accent', '--novelist-border']) {
      vars[prop] = styles.getPropertyValue(prop);
    }
    iframeEl.contentWindow.postMessage({ type: 'theme-update', theme: vars }, '*');
  });

  function handleMessage(event: MessageEvent) {
    if (event.source !== iframeEl?.contentWindow) return;
    const data = event.data;
    if (data?.type === 'navigate' && typeof data.position === 'number') {
      onNavigate?.(data.position);
    }
  }
</script>

<svelte:window onmessage={handleMessage} />

<div class="plugin-panel">
  <!--
    No `sandbox` attribute: WKWebView blocks custom-protocol main-resource loads
    from sandboxed iframes, which breaks plugins whose `entry` is served from
    Tauri's asset protocol. Plugins are trusted (local install or marketplace-vetted).
  -->
  <iframe
    bind:this={iframeEl}
    src={extension.entryUrl}
    title={extension.label}
  ></iframe>
</div>

<style>
  .plugin-panel {
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
