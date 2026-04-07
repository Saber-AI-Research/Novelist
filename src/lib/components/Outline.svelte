<script lang="ts">
  import type { HeadingItem } from '$lib/editor/outline';

  interface Props {
    headings: HeadingItem[];
    onNavigate: (from: number) => void;
  }

  let { headings, onNavigate }: Props = $props();
</script>

<div class="outline-panel">
  <div class="outline-header">
    <span>OUTLINE</span>
  </div>

  {#if headings.length === 0}
    <div class="outline-empty">No headings found</div>
  {:else}
    <ul class="outline-list">
      {#each headings as heading}
        <li>
          <button
            class="outline-item"
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
    transition: background 100ms ease;
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
