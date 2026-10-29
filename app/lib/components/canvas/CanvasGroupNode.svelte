<script lang="ts">
  import { flushSync } from 'svelte';
  import { NodeResizer, NodeToolbar, Position } from '@xyflow/svelte';
  import { isImeComposing } from '$lib/utils/ime';
  import { isTapOnSelected, recordPress, type NodePress } from './node-tap';

  interface Props {
    data: {
      label: string;
      color?: string;
      palette?: string[];
      highlight?: boolean;
      onLabelChange?: (label: string) => void;
      onColorChange?: (color: string) => void;
      onResize?: () => void;
    };
    selected?: boolean;
  }
  let { data, selected = false }: Props = $props();

  let editing = $state(false);
  let editValue = $state<string>('');
  let headerEl = $state<HTMLDivElement | undefined>(undefined);
  let press: NodePress | null = null;

  const palette = $derived(data.palette ?? []);
  const color = $derived(data.color ?? 'var(--novelist-accent)');

  function startEdit(e: Event) {
    e.stopPropagation();
    editValue = data.label ?? '';
    editing = true;
    // Render now and focus inside the gesture so mobile keyboards open.
    flushSync();
    const input = headerEl?.querySelector('input');
    if (!input) return;
    input.focus();
    input.select();
  }

  // Touch/pen: tapping the header of an already selected group renames it.
  function onHeaderClick(e: MouseEvent) {
    if (!editing && isTapOnSelected(press, e)) startEdit(e);
    press = null;
  }

  function finishEdit() {
    if (editValue !== data.label) {
      data.label = editValue;
      data.onLabelChange?.(editValue);
    }
    editing = false;
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (isImeComposing(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); finishEdit(); }
    if (e.key === 'Escape') { editing = false; }
  }

  function stopMouse(e: MouseEvent) { e.stopPropagation(); }

  function pickColor(c: string) {
    data.color = c;
    data.onColorChange?.(c);
  }
</script>

<NodeResizer
  minWidth={200}
  minHeight={140}
  isVisible={selected}
  lineClass="rs-line"
  handleClass="rs-handle"
  onResizeEnd={() => data.onResize?.()}
/>

{#if selected && palette.length > 0}
  <NodeToolbar position={Position.Top} offset={8} isVisible>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="palette nodrag nopan" onmousedown={stopMouse} onclick={stopMouse}>
      {#each palette as c}
        <button
          type="button"
          class="swatch"
          class:active={c === data.color}
          style:background={c}
          title={c}
          aria-label="Set group color {c}"
          onclick={() => pickColor(c)}
        ></button>
      {/each}
    </div>
  </NodeToolbar>
{/if}

<div
  class="group"
  class:highlight={data.highlight}
  style:--group-color={color}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="header"
    bind:this={headerEl}
    onpointerdown={(e) => { press = recordPress(e, selected); }}
    onclick={onHeaderClick}
    ondblclick={startEdit}
    onmousedown={stopMouse}
  >
    {#if editing}
      <input
        class="label-input"
        bind:value={editValue}
        enterkeyhint="done"
        onblur={finishEdit}
        onkeydown={onKey}
      />
    {:else}
      <span class="label">{data.label || 'Group'}</span>
    {/if}
  </div>
  <div class="body"></div>
</div>

<style>
  .group {
    width: 100%;
    height: 100%;
    background: color-mix(in srgb, var(--group-color) 6%, transparent);
    border: 2px solid color-mix(in srgb, var(--group-color) 55%, transparent);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: background 120ms, border-color 120ms, box-shadow 120ms;
  }
  .group.highlight {
    background: color-mix(in srgb, var(--group-color) 14%, transparent);
    border-color: var(--group-color);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--group-color) 30%, transparent);
  }
  .header {
    flex: 0 0 auto;
    padding: 5px 10px;
    font-size: 0.78rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--group-color) 85%, var(--novelist-text));
    background: color-mix(in srgb, var(--group-color) 14%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--group-color) 35%, transparent);
    cursor: text;
    user-select: none;
    line-height: 1.4;
  }
  .label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .label-input {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    font: inherit;
    color: inherit;
    padding: 0;
  }
  .body {
    flex: 1;
    pointer-events: none;
  }

  /* --- NodeToolbar color palette -------------------------------------------- */
  .palette {
    display: flex;
    gap: 4px;
    padding: 5px 6px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    box-shadow: 0 4px 12px color-mix(in srgb, var(--novelist-text) 12%, transparent);
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid color-mix(in srgb, var(--novelist-text) 18%, transparent);
    padding: 0;
    cursor: pointer;
    transition: transform 80ms;
  }
  .swatch:hover { transform: scale(1.15); }
  .swatch.active {
    outline: 2px solid var(--novelist-text);
    outline-offset: 1px;
  }
  /* Touch: two rows of five 32px swatches on a 44px pitch; the ::after pad
     makes each a full 44px target without overlapping its neighbours. */
  @media (hover: none), (pointer: coarse) {
    .palette {
      flex-wrap: wrap;
      gap: 12px;
      padding: 10px 12px;
      max-width: calc(5 * 32px + 4 * 12px + 24px + 2px);
    }
    .swatch {
      position: relative;
      width: 32px;
      height: 32px;
      touch-action: manipulation;
    }
    .swatch::after {
      content: '';
      position: absolute;
      inset: -6px;
    }
  }

  :global(.rs-line) {
    border-color: var(--group-color) !important;
  }
  :global(.rs-handle) {
    background: var(--group-color) !important;
    border: 1px solid var(--novelist-bg) !important;
  }
</style>
