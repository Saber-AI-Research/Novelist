<script lang="ts">
  import { onMount } from 'svelte';
  import { Transformer } from 'markmap-lib';
  import { Markmap } from 'markmap-view';
  import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';

  interface Props {
    onNavigate?: (from: number) => void;
  }
  let { onNavigate }: Props = $props();

  let svgEl: SVGSVGElement;
  let mm: Markmap | null = null;
  const transformer = new Transformer();
  let updateTimer: ReturnType<typeof setTimeout> | null = null;
  let lastContent = '';

  function getActiveContent(): string {
    const tab = tabsStore.activeTab;
    if (!tab) return '';
    const view = getEditorView(tab.id);
    if (view) return view.state.doc.toString();
    return tab.content;
  }

  function updateMindmap() {
    const content = getActiveContent();
    if (content === lastContent && mm) return;
    lastContent = content;

    const { root } = transformer.transform(content);
    if (mm) {
      mm.setData(root);
      mm.fit();
    }
  }

  function scheduleUpdate() {
    if (updateTimer) clearTimeout(updateTimer);
    updateTimer = setTimeout(updateMindmap, 300);
  }

  $effect(() => {
    const _tab = tabsStore.activeTab;
    const _dirty = _tab?.isDirty;
    scheduleUpdate();
  });

  onMount(() => {
    mm = Markmap.create(svgEl, {
      autoFit: true,
      duration: 300,
      zoom: true,
      pan: true,
    });
    updateMindmap();

    return () => {
      if (updateTimer) clearTimeout(updateTimer);
      if (mm) { mm.destroy(); mm = null; }
    };
  });
</script>

<div class="mindmap-panel">
  <div class="mindmap-header">
    <span class="mindmap-title">Mindmap</span>
    <button
      class="mindmap-fit-btn"
      onclick={() => mm?.fit()}
      title="Fit to view"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 6h12M6 2v12"/></svg>
    </button>
  </div>
  <div class="mindmap-content">
    <svg bind:this={svgEl} class="mindmap-svg"></svg>
  </div>
</div>

<style>
  .mindmap-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .mindmap-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
  }

  .mindmap-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--novelist-text-secondary);
  }

  .mindmap-fit-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    cursor: pointer;
  }
  .mindmap-fit-btn:hover {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
  }

  .mindmap-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .mindmap-svg {
    width: 100%;
    height: 100%;
  }
</style>
