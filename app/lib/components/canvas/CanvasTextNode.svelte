<script lang="ts">
  import { flushSync } from 'svelte';
  import { Handle, Position, NodeResizer } from '@xyflow/svelte';
  import { isImeComposing } from '$lib/utils/ime';
  import { isTapOnSelected, recordPress, type NodePress } from './node-tap';

  interface Props {
    data: {
      text: string;
      onChange?: (value: string) => void;
      onResize?: () => void;
    };
    selected?: boolean;
  }
  let { data, selected = false }: Props = $props();

  let editing = $state(false);
  let editValue = $state<string>('');
  let nodeEl = $state<HTMLDivElement | undefined>(undefined);
  let press: NodePress | null = null;

  function startEdit() {
    editValue = data.text ?? '';
    editing = true;
    // Render now and focus inside the gesture (mobile keyboards only open
    // then), caret at the end.
    flushSync();
    const textarea = nodeEl?.querySelector('textarea');
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function finishEdit() {
    if (editValue !== data.text) {
      data.text = editValue;
      data.onChange?.(editValue);
    }
    editing = false;
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (isImeComposing(e)) return;
    if (e.key === 'Escape') { editing = false; }
  }

  // Touch and pen have no reliable dblclick: tapping an already selected card
  // edits it. The first tap only selects, so dragging never opens the editor.
  function onClick(e: MouseEvent) {
    if (!editing && isTapOnSelected(press, e)) startEdit();
    press = null;
  }
</script>

<NodeResizer minWidth={140} minHeight={60} isVisible={selected} lineClass="rs-line" handleClass="rs-handle" onResizeEnd={() => data.onResize?.()} />
<!-- One handle per JSON Canvas side; the canvas uses loose connections so any side can start or end an edge. -->
<Handle type="source" id="left" position={Position.Left} />
<Handle type="source" id="right" position={Position.Right} />
<Handle type="source" id="top" position={Position.Top} />
<Handle type="source" id="bottom" position={Position.Bottom} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="node"
  bind:this={nodeEl}
  onpointerdown={(e) => { press = recordPress(e, selected); }}
  onclick={onClick}
  ondblclick={startEdit}
>
  {#if editing}
    <textarea
      class="edit nowheel nodrag"
      bind:value={editValue}
      onblur={finishEdit}
      onkeydown={onKey}
    ></textarea>
  {:else}
    <div class="view nowheel">{data.text}</div>
  {/if}
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
    font-size: 0.9rem;
    line-height: 1.55;
    overflow: hidden;
    display: flex;
  }
  .view {
    flex: 1;
    padding: 12px 14px;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
  }
  .edit {
    flex: 1;
    width: 100%;
    padding: 12px 14px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    resize: none;
    outline: none;
    overflow-y: auto;
  }
  :global(.rs-line) {
    border-color: var(--novelist-accent) !important;
  }
  :global(.rs-handle) {
    background: var(--novelist-accent) !important;
    border: 1px solid var(--novelist-bg) !important;
  }
</style>
