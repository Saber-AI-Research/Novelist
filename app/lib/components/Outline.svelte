<script lang="ts">
  import type { HeadingItem } from '$lib/editor/outline';
  import { t } from '$lib/i18n';
  import { platform } from '$lib/stores/platform.svelte';
  import { longPress, type LongPressEvent } from '$lib/actions/long-press';
  import { clampToViewport } from '$lib/actions/clamp-to-viewport';
  import { portal } from '$lib/actions/portal';

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

  // --- Touch: long-press menu replaces HTML5 drag (iOS would lift the row) ---
  let sectionMenu = $state<{ x: number; y: number; index: number } | null>(null);

  /** Nearest earlier heading of the same level under the same parent, or -1. */
  function previousSiblingIndex(index: number): number {
    const level = headings[index].level;
    for (let i = index - 1; i >= 0; i--) {
      if (headings[i].level < level) return -1;
      if (headings[i].level === level) return i;
    }
    return -1;
  }

  /** Nearest later heading of the same level under the same parent, or -1. */
  function nextSiblingIndex(index: number): number {
    const level = headings[index].level;
    for (let i = index + 1; i < headings.length; i++) {
      if (headings[i].level < level) return -1;
      if (headings[i].level === level) return i;
    }
    return -1;
  }

  function openSectionMenu(e: LongPressEvent, index: number) {
    if (!onMoveSection) return;
    const zoom = parseFloat(document.documentElement.style.transform.match(/scale\(([^)]+)\)/)?.[1] || '1');
    sectionMenu = { x: e.clientX / zoom, y: e.clientY / zoom, index };
  }

  // Up: insert this section before its previous sibling.
  function moveSectionUp(index: number) {
    const prev = previousSiblingIndex(index);
    sectionMenu = null;
    if (prev >= 0) onMoveSection?.(headings[index].from, headings[prev].from);
  }

  // Down: insert the next sibling before this section (a swap that needs no
  // end-of-document target).
  function moveSectionDown(index: number) {
    const next = nextSiblingIndex(index);
    sectionMenu = null;
    if (next >= 0) onMoveSection?.(headings[next].from, headings[index].from);
  }
</script>

<svelte:window onclick={() => { sectionMenu = null; }} />

<div class="outline-panel" data-testid="outline-panel">
  <div class="outline-header">
    <span>{t('outline.title')}</span>
  </div>

  {#if headings.length === 0}
    <div class="outline-empty">{t('outline.empty')}</div>
  {:else}
    <ul class="outline-list">
      {#each headings as heading, i}
        <li
          class:drag-over={dragOverIndex === i && dragSourceIndex !== i}
          draggable={onMoveSection != null && !platform.isMobile ? "true" : "false"}
          ondragstart={(e) => handleDragStart(e, i)}
          ondragover={(e) => handleDragOver(e, i)}
          ondragenter={(e) => handleDragEnter(e, i)}
          ondragleave={(e) => handleDragLeave(e)}
          ondrop={(e) => handleDrop(e, i)}
          ondragend={handleDragEnd}
          role="listitem"
          use:longPress={{ onLongPress: (e) => openSectionMenu(e, i) }}
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

{#if sectionMenu && headings[sectionMenu.index]}
  {@const index = sectionMenu.index}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="menu"
    tabindex="-1"
    class="context-menu"
    data-testid="outline-section-menu"
    use:portal
    use:clampToViewport={{ enabled: true, x: sectionMenu.x, y: sectionMenu.y }}
    style="left: {sectionMenu.x}px; top: {sectionMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    <button
      role="menuitem"
      class="context-menu-item"
      data-testid="outline-move-section-up"
      disabled={previousSiblingIndex(index) < 0}
      onclick={() => moveSectionUp(index)}
    >{t('touch.moveSectionUp')}</button>
    <button
      role="menuitem"
      class="context-menu-item"
      data-testid="outline-move-section-down"
      disabled={nextSiblingIndex(index) < 0}
      onclick={() => moveSectionDown(index)}
    >{t('touch.moveSectionDown')}</button>
  </div>
{/if}

<style>
  .outline-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
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

  .context-menu-item:disabled {
    opacity: 0.4;
    cursor: default;
  }

  @media (pointer: coarse) {
    .outline-list li {
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }
    .context-menu-item {
      display: flex;
      align-items: center;
      min-height: 44px;
    }
  }
</style>
