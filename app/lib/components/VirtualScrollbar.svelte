<script lang="ts">
  import type { ViewportManager } from '$lib/editor/viewport';

  interface Props {
    viewportMgr: ViewportManager;
    onJumpToLine: (absLine: number) => void;
  }

  let { viewportMgr, onJumpToLine }: Props = $props();

  let trackElement: HTMLDivElement;
  let dragging = $state(false);

  /** Window's position as fraction of total document */
  let windowStart = $derived(viewportMgr.windowStartLine / Math.max(viewportMgr.totalLines, 1));
  let windowSize = $derived(
    (viewportMgr.windowEndLine - viewportMgr.windowStartLine) / Math.max(viewportMgr.totalLines, 1)
  );

  function handleTrackClick(e: MouseEvent) {
    if (!trackElement) return;
    const rect = trackElement.getBoundingClientRect();
    const fraction = (e.clientY - rect.top) / rect.height;
    const targetLine = Math.floor(fraction * viewportMgr.totalLines);
    onJumpToLine(Math.max(0, Math.min(targetLine, viewportMgr.totalLines - 1)));
  }

  function handleThumbDown(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;

    const onMove = (me: MouseEvent) => {
      if (!trackElement) return;
      const rect = trackElement.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (me.clientY - rect.top) / rect.height));
      const targetLine = Math.floor(fraction * viewportMgr.totalLines);
      onJumpToLine(Math.max(0, Math.min(targetLine, viewportMgr.totalLines - 1)));
    };

    const onUp = () => {
      dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function formatLines(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return `${n}`;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="virtual-scrollbar"
  bind:this={trackElement}
  onclick={handleTrackClick}
>
  <!-- Window indicator (thumb) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="virtual-scrollbar-thumb"
    class:dragging
    style="top: {windowStart * 100}%; height: {Math.max(windowSize * 100, 2)}%;"
    onmousedown={handleThumbDown}
  ></div>

  <!-- Line info tooltip -->
  <div class="virtual-scrollbar-info">
    {formatLines(viewportMgr.windowStartLine)}-{formatLines(viewportMgr.windowEndLine)} / {formatLines(viewportMgr.totalLines)}
  </div>
</div>

<style>
  .virtual-scrollbar {
    position: absolute;
    top: 0;
    right: 0;
    width: 28px;
    height: 100%;
    background: var(--novelist-bg-secondary);
    border-left: 1px solid var(--novelist-border);
    cursor: pointer;
    z-index: 10;
    opacity: 0.7;
    transition: opacity 150ms;
  }

  .virtual-scrollbar:hover {
    opacity: 1;
  }

  .virtual-scrollbar-thumb {
    position: absolute;
    left: 2px;
    right: 2px;
    background: var(--novelist-accent);
    border-radius: 3px;
    min-height: 8px;
    opacity: 0.5;
    transition: opacity 100ms;
  }

  .virtual-scrollbar-thumb:hover,
  .virtual-scrollbar-thumb.dragging {
    opacity: 0.8;
  }

  .virtual-scrollbar-info {
    position: absolute;
    bottom: 4px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 7px;
    color: var(--novelist-text-secondary);
    pointer-events: none;
    white-space: nowrap;
  }
</style>
