<script lang="ts">
  import type { AiContextItem } from './context';
  import { IconClose, IconDocument } from '../icons';

  type Props = {
    items: readonly AiContextItem[];
    onRemove: (id: string) => void;
    onClear: () => void;
  };

  let { items, onRemove, onClear }: Props = $props();
  let expandedId = $state<string | null>(null);
</script>

{#if items.length > 0}
  <div class="context-bar" data-testid="ai-context-bar">
    <div class="chips">
      {#each items as item (item.id)}
        <div class="chip" data-testid="ai-context-chip-{item.id}">
          <button
            type="button"
            class="chip-main"
            title={item.path ?? item.label}
            onclick={() => (expandedId = expandedId === item.id ? null : item.id)}
          >
            <IconDocument size={12} />
            <span>{item.label}</span>
            {#if item.truncated}<em>truncated</em>{/if}
          </button>
          <button
            type="button"
            class="chip-close"
            aria-label="Remove context"
            onclick={() => onRemove(item.id)}
          ><IconClose size={11} /></button>
        </div>
      {/each}
    </div>
    <button type="button" class="clear" onclick={onClear}>Clear context</button>
    {#if expandedId}
      {@const item = items.find((x) => x.id === expandedId)}
      {#if item}
        <pre class="preview">{item.content.slice(0, 1600)}{item.content.length > 1600 ? '\n…' : ''}</pre>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .context-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg-secondary);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    background: var(--novelist-bg);
    overflow: hidden;
  }
  .chip-main {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--novelist-text);
    font: inherit;
    font-size: 11px;
    padding: 3px 6px;
    cursor: pointer;
  }
  .chip-main span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 180px;
  }
  .chip-main em {
    color: var(--novelist-text-secondary);
    font-style: normal;
    font-size: 10px;
  }
  .chip-close,
  .clear {
    border: 0;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
  }
  .chip-close {
    display: inline-flex;
    align-items: center;
    padding: 3px 5px;
  }
  .clear {
    align-self: flex-start;
    font-size: 11px;
    padding: 0;
  }
  .clear:hover,
  .chip-close:hover { color: var(--novelist-text); }
  .preview {
    max-height: 140px;
    overflow: auto;
    margin: 0;
    padding: 6px;
    border-radius: 3px;
    background: var(--novelist-bg);
    color: var(--novelist-text-secondary);
    white-space: pre-wrap;
    font-size: 11px;
  }
  @media (pointer: coarse) {
    .chip-main { min-height: 44px; }
    .chip-close {
      justify-content: center;
      min-width: 44px;
      min-height: 44px;
    }
    .clear { min-height: 44px; }
  }
</style>
