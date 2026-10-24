<script lang="ts">
  import { Handle, Position, NodeResizer } from '@xyflow/svelte';
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';

  interface Props {
    data: {
      filePath: string;
      onOpen?: (filePath: string) => void;
      onResize?: () => void;
    };
    selected?: boolean;
  }
  let { data, selected = false }: Props = $props();

  let preview = $state<string>('');
  let loading = $state(true);
  let error = $state(false);

  const fileName = $derived(basename(data.filePath));

  function basename(p: string): string {
    if (!p) return '';
    const slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(slash + 1) : p;
  }

  async function loadPreview() {
    loading = true;
    error = false;
    try {
      const r = await commands.readFile(data.filePath);
      if (r.status === 'ok') {
        preview = r.data.slice(0, 1500);
      } else {
        error = true;
      }
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  }

  onMount(() => { loadPreview(); });

  $effect(() => {
    // Reload if filePath changes
    data.filePath;
    loadPreview();
  });

  function handleOpen() {
    data.onOpen?.(data.filePath);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpen(); }
  }
</script>

<NodeResizer minWidth={180} minHeight={100} isVisible={selected} lineClass="rs-line" handleClass="rs-handle" onResizeEnd={() => data.onResize?.()} />
<!-- One handle per JSON Canvas side; the canvas uses loose connections so any side can start or end an edge. -->
<Handle type="source" id="left" position={Position.Left} />
<Handle type="source" id="right" position={Position.Right} />
<Handle type="source" id="top" position={Position.Top} />
<Handle type="source" id="bottom" position={Position.Bottom} />

<div class="node">
  <button type="button" class="header" onclick={handleOpen} ondblclick={handleOpen} onkeydown={onKey} title={data.filePath}>
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" class="icon">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
    <span class="filename">{fileName}</span>
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="open-icon">
      <path d="M6 3h7v7M13 3l-8 8" />
    </svg>
  </button>

  <div class="body nowheel" class:dim={loading || error}>
    {#if loading}
      <span class="hint">Loading…</span>
    {:else if error}
      <span class="hint">File unavailable</span>
    {:else}
      {preview}
    {/if}
  </div>
</div>

<style>
  .node {
    width: 100%;
    height: 100%;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 1px 3px color-mix(in srgb, var(--novelist-text) 8%, transparent);
    color: var(--novelist-text);
    font-size: 0.85rem;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: var(--novelist-bg-secondary);
    border: none;
    border-bottom: 1px solid var(--novelist-border);
    color: var(--novelist-text);
    font-size: 0.8rem;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }
  .header:hover { background: color-mix(in srgb, var(--novelist-accent) 10%, var(--novelist-bg-secondary)); }
  .icon { flex-shrink: 0; opacity: 0.7; }
  .filename {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open-icon { flex-shrink: 0; opacity: 0.5; }
  .body {
    flex: 1;
    padding: 10px 12px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
    color: var(--novelist-text-secondary);
    font-size: 0.8rem;
  }
  .body.dim { color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); font-style: italic; }
  .hint { opacity: 0.6; }
  :global(.rs-line) {
    border-color: var(--novelist-accent) !important;
  }
  :global(.rs-handle) {
    background: var(--novelist-accent) !important;
    border: 1px solid var(--novelist-bg) !important;
  }
</style>
