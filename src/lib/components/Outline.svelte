<script lang="ts">
  import type { HeadingItem } from '$lib/editor/outline';

  interface Props {
    headings: HeadingItem[];
    onNavigate: (from: number) => void;
    onMoveSection?: (sourceFrom: number, targetFrom: number) => void;
  }

  let { headings, onNavigate, onMoveSection }: Props = $props();

  let dragSourceIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);

  function handleDragStart(e: DragEvent, index: number) {
    dragSourceIndex = index;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
    }
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    if (dragSourceIndex !== null && index !== dragSourceIndex) {
      dragOverIndex = index;
    }
  }

  function handleDragEnter(e: DragEvent, index: number) {
    e.preventDefault();
    if (dragSourceIndex !== null && index !== dragSourceIndex) {
      dragOverIndex = index;
    }
  }

  function handleDragLeave(e: DragEvent) {
    // Only clear if leaving the list item entirely
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !e.currentTarget || !(e.currentTarget as HTMLElement).contains(related)) {
      dragOverIndex = null;
    }
  }

  function handleDrop(e: DragEvent, index: number) {
    e.preventDefault();
    if (dragSourceIndex !== null && dragSourceIndex !== index && onMoveSection) {
      onMoveSection(headings[dragSourceIndex].from, headings[index].from);
    }
    dragSourceIndex = null;
    dragOverIndex = null;
  }

  function handleDragEnd() {
    dragSourceIndex = null;
    dragOverIndex = null;
  }
</script>

<div class="outline-panel">
  <div class="outline-header">
    <span>OUTLINE</span>
  </div>

  {#if headings.length === 0}
    <div class="outline-empty">No headings found</div>
  {:else}
    <ul class="outline-list">
      {#each headings as heading, i}
        <li
          class:drag-over={dragOverIndex === i && dragSourceIndex !== i}
          draggable={onMoveSection != null ? "true" : "false"}
          ondragstart={(e) => handleDragStart(e, i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondragenter={(e) => handleDragEnter(e, i)}
          ondragleave={(e) => handleDragLeave(e)}
          ondrop={(e) => handleDrop(e, i)}
          ondragend={handleDragEnd}
          role="listitem"
        >
          <button
            class="outline-item"
            class:dragging={dragSourceIndex === i}
            style="padding-left: {8 + (heading.level - 1) * 16}px"
            onclick={() => onNavigate(heading.from)}
          >
            {heading.text}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .outline-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 200px;
    border-left: 1px solid var(--novelist-border);
    background: var(--novelist-bg);
    overflow: hidden;
  }

  .outline-header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--novelist-text-secondary);
    border-bottom: 1px solid var(--novelist-border);
    flex-shrink: 0;
    user-select: none;
  }

  .outline-empty {
    padding: 16px 12px;
    font-size: 0.8rem;
    color: var(--novelist-text-secondary);
    font-style: italic;
  }

  .outline-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .outline-list li {
    margin: 0;
    padding: 0;
    border-top: 2px solid transparent;
    transition: border-color 100ms ease;
  }

  .outline-list li.drag-over {
    border-top: 2px solid var(--novelist-accent, #4a9eff);
  }

  .outline-item {
    display: block;
    width: 100%;
    padding-top: 4px;
    padding-bottom: 4px;
    padding-right: 12px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.82rem;
    color: var(--novelist-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 100ms ease, opacity 150ms ease;
  }

  .outline-item.dragging {
    opacity: 0.5;
  }

  .outline-item:hover {
    background: var(--novelist-hover-bg, rgba(128, 128, 128, 0.12));
    color: var(--novelist-text);
  }

  .outline-item:focus-visible {
    outline: 2px solid var(--novelist-accent, #4a9eff);
    outline-offset: -2px;
  }
</style>
