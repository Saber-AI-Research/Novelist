<script lang="ts">
  import { onDestroy } from 'svelte';
  import { hasPluginPermission, type UIExtension } from '$lib/stores/extensions.svelte';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { collectPluginThemeVars } from '$lib/utils/plugin-theme';
  import {
    PLUGIN_IFRAME_SANDBOX,
    PluginFrameConnection,
    type PluginMessage,
  } from '$lib/services/plugin-host-channel';

  let { extension, onNavigate }: { extension: UIExtension; onNavigate?: (from: number) => void } = $props();

  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  let connected = $state(false);

  const connection = new PluginFrameConnection(handleMessage);

  // A new entry document is host-initiated: its load gets a fresh port, and
  // the previous document's port is closed.
  $effect(() => {
    extension.entryUrl;
    connection.expectLoad();
    connected = false;
  });

  onDestroy(() => connection.close());

  function handleLoad() {
    // `navigated`: the plugin replaced its own document. Nothing loaded that
    // way is trusted, so it never receives a port.
    connected = connection.handleLoad(iframeEl) === 'connected';
  }

  // Document text is only shared with panels holding the `read` permission.
  $effect(() => {
    const tab = tabsStore.activeTab;
    if (!connected || !tab || !hasPluginPermission(extension.permissions, 'read')) return;
    const view = getEditorView(tab.id);
    const content = view?.state.doc.toString() ?? tab.content ?? '';
    connection.post({ type: 'content-update', content });
  });

  // Send theme updates
  $effect(() => {
    // Track theme changes
    const _theme = uiStore.themeId;
    const _typography = uiStore.editorSettings;
    if (!connected) return;
    connection.post({ type: 'theme-update', theme: collectPluginThemeVars() });
  });

  function handleMessage(data: PluginMessage) {
    if (data.type === 'navigate' && typeof data.position === 'number') {
      onNavigate?.(data.position);
    }
  }
</script>

<div class="plugin-panel">
  <!-- Sandboxed without allow-same-origin: every plugin document gets an
       opaque origin, so it can script neither the host nor sibling plugins.
       Messaging uses the per-document MessagePort from PluginFrameConnection. -->
  {#key extension.entryUrl}
    <iframe
      bind:this={iframeEl}
      src={extension.entryUrl}
      title={extension.label}
      sandbox={PLUGIN_IFRAME_SANDBOX}
      onload={handleLoad}
    ></iframe>
  {/key}
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
