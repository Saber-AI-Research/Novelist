<script lang="ts">
  import { onMount, tick, onDestroy } from 'svelte';
  import { Transformer } from 'markmap-lib';
  import { Markmap } from 'markmap-view';
  import { t } from '$lib/i18n';
  import { applyFoldLevel, type MindmapNode } from '$lib/utils/mindmap';
  import { IconMap, IconClose } from './icons';

  interface Props {
    content: string;
    onClose: () => void;
  }
  let { content, onClose }: Props = $props();

  let svgEl: SVGSVGElement | undefined = $state();
  let miniSvgEl: SVGSVGElement | undefined = $state();
  let mm: Markmap | null = null;
  let miniMm: Markmap | null = null;
  let miniMapVisible = $state(true);
  let expandLevel = $state<number | null>(null); // null = expand all
  const transformer = new Transformer();

  function render(text: string) {
    if (!svgEl || !mm) return;
    const { root } = transformer.transform(text || '# ');
    applyFoldLevel(root as MindmapNode, expandLevel);
    mm.setData(root);
    mm.fit();
    // Mirror to minimap — always fully expanded for overview.
    if (miniMm) {
      const { root: miniRoot } = transformer.transform(text || '# ');
      applyFoldLevel(miniRoot as MindmapNode, null);
      miniMm.setData(miniRoot);
      miniMm.fit();
    }
  }

  onMount(async () => {
    await tick();
    if (!svgEl) return;
    mm = Markmap.create(svgEl, { autoFit: false, duration: 250, zoom: true, pan: true });
    if (miniSvgEl) {
      miniMm = Markmap.create(miniSvgEl, { autoFit: true, duration: 0, zoom: false, pan: false });
    }
    render(content);
  });

  onDestroy(() => {
    try { mm?.destroy(); } catch {}
    try { miniMm?.destroy(); } catch {}
  });

  $effect(() => { render(content); });

  function setLevel(level: number | null) {
    expandLevel = level;
    render(content);
  }

  function fit() { mm?.fit(); }
  function reset() {
    // Reset zoom to 1:1 and recenter by re-fitting.
    mm?.rescale(1);
    requestAnimationFrame(() => mm?.fit());
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); fit(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setLevel(1); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setLevel(2); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setLevel(3); return; }
  }

  const levels: Array<{ n: number | null; label: string; title: string }> = $derived([
    { n: 1, label: '1', title: t('mindmap.expandLevel', { level: 1 }) },
    { n: 2, label: '2', title: t('mindmap.expandLevel', { level: 2 }) },
    { n: 3, label: '3', title: t('mindmap.expandLevel', { level: 3 }) },
    { n: null, label: '∞', title: t('mindmap.expandAll') },
  ]);
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" data-testid="mindmap-overlay" onclick={onClose}>
  <div class="frame" onclick={(e) => e.stopPropagation()}>
    <div class="header">
      <span class="title">{t('mindmap.title')}</span>
      <div class="actions">
        <div class="level-group" role="group" aria-label={t('mindmap.expandAll')}>
          {#each levels as lv}
            <button
              type="button"
              class="btn level-btn"
              class:active={expandLevel === lv.n}
              title={lv.title}
              aria-label={lv.title}
              onclick={() => setLevel(lv.n)}
              data-testid="mindmap-level-{lv.label}"
            >{lv.label}</button>
          {/each}
        </div>
        <span class="sep"></span>
        <button type="button" class="btn" onclick={fit} title={t('mindmap.fitToView')} aria-label={t('mindmap.fitToView')} data-testid="mindmap-fit">⤢</button>
        <button type="button" class="btn" onclick={reset} title={t('mindmap.reset')} aria-label={t('mindmap.reset')} data-testid="mindmap-reset">⌂</button>
        <button
          type="button"
          class="btn"
          class:active={miniMapVisible}
          onclick={() => { miniMapVisible = !miniMapVisible; }}
          title={t('mindmap.miniMap')}
          aria-label={t('mindmap.miniMap')}
          data-testid="mindmap-minimap-toggle"
        ><IconMap size={14} /></button>
        <span class="sep"></span>
        <button type="button" class="btn" onclick={onClose} title={t('mindmap.close')} aria-label={t('mindmap.close')} data-testid="mindmap-close"><IconClose size={14} /></button>
      </div>
    </div>
    <div class="content">
      <svg bind:this={svgEl}></svg>
      <div class="minimap" class:hidden={!miniMapVisible} aria-label={t('mindmap.miniMap')}>
        <svg bind:this={miniSvgEl}></svg>
      </div>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--novelist-bg) 92%, transparent);
    backdrop-filter: blur(4px);
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .frame {
    width: 100%;
    height: 100%;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 14px;
    border-bottom: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }
  .title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--novelist-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .actions { display: flex; gap: 4px; align-items: center; }
  .level-group {
    display: flex;
    background: var(--novelist-bg-tertiary, color-mix(in srgb, var(--novelist-text) 8%, transparent));
    border-radius: 5px;
    padding: 2px;
    gap: 1px;
  }
  .sep {
    width: 1px;
    height: 16px;
    background: var(--novelist-border);
    margin: 0 4px;
  }
  .btn {
    min-width: 26px;
    height: 26px;
    padding: 0 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .btn:hover {
    background: var(--novelist-bg-tertiary, color-mix(in srgb, var(--novelist-text) 8%, transparent));
    color: var(--novelist-text);
  }
  .btn.active {
    background: color-mix(in srgb, var(--novelist-accent) 18%, transparent);
    color: var(--novelist-accent);
  }
  .level-btn {
    min-width: 22px;
    height: 22px;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 3px;
  }
  .content {
    flex: 1;
    min-height: 0;
    padding: 12px;
    position: relative;
  }
  .content > svg {
    width: 100%;
    height: 100%;
    color: var(--novelist-text);
  }
  .minimap {
    position: absolute;
    right: 20px;
    bottom: 20px;
    width: 200px;
    height: 140px;
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    overflow: hidden;
    pointer-events: none;
  }
  .minimap.hidden { display: none; }
  .minimap > svg { width: 100%; height: 100%; color: var(--novelist-text); }

  /* Markmap theme bridge. */
  :global(.overlay .markmap-node > circle) {
    fill: var(--novelist-bg);
    stroke: var(--novelist-accent);
  }
  :global(.overlay .markmap-node > text) {
    fill: var(--novelist-text);
  }
  :global(.overlay .markmap-link) {
    stroke: color-mix(in srgb, var(--novelist-accent) 60%, transparent);
  }
  :global(.overlay .markmap-foreign) {
    color: var(--novelist-text);
  }
</style>
