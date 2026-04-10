<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';

  interface Props {
    data: { content: string; width?: number; height?: number };
  }
  let { data }: Props = $props();

  let editing = $state(false);
  let editContent = $state(data.content);

  function startEdit() {
    editContent = data.content;
    editing = true;
  }

  function finishEdit() {
    data.content = editContent;
    editing = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      editing = false;
    }
    // Stop propagation so SvelteFlow doesn't intercept
    e.stopPropagation();
  }
</script>

<Handle type="target" position={Position.Left} />
<Handle type="source" position={Position.Right} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="canvas-text-node"
  ondblclick={startEdit}
>
  {#if editing}
    <textarea
      class="canvas-node-textarea"
      bind:value={editContent}
      onblur={finishEdit}
      onkeydown={handleKeydown}
      autofocus
    ></textarea>
  {:else}
    <div class="canvas-node-content">
      {data.content}
    </div>
  {/if}
</div>

<style>
  .canvas-text-node {
    padding: 10px 14px;
    background: var(--novelist-bg, #fff);
    border: 1px solid var(--novelist-border, #ddd);
    border-radius: 6px;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--novelist-text, #333);
    min-width: 120px;
    min-height: 40px;
    cursor: default;
  }

  .canvas-node-content {
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .canvas-node-textarea {
    width: 100%;
    min-height: 60px;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    resize: vertical;
    outline: none;
  }
</style>
