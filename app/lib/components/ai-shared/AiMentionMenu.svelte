<script lang="ts">
  import type { AiContextAttachment } from './attachments';
  import type { MentionMenuItem } from './menu-items';

  type Props = {
    items: readonly MentionMenuItem[];
    activeIndex: number;
    onPick: (token: string, attachment?: AiContextAttachment) => void;
  };

  let { items, activeIndex, onPick }: Props = $props();
</script>

{#if items.length > 0}
  <div class="menu" data-testid="ai-mention-menu">
    {#each items as mention, i (mention.token)}
      <button
        type="button"
        class:active={i === activeIndex}
        data-active={i === activeIndex || undefined}
        onclick={() => onPick(mention.token, mention.attachment)}
      >
        <strong>{mention.label}</strong>
        <span>{mention.hint}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .menu {
    border: 1px solid var(--novelist-border);
    background: var(--novelist-bg);
    border-radius: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    overflow: hidden;
  }
  button {
    display: flex;
    width: 100%;
    gap: 8px;
    align-items: baseline;
    border: 0;
    background: transparent;
    color: var(--novelist-text);
    padding: 5px 8px;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    text-align: left;
  }
  button:hover,
  button.active { background: var(--novelist-bg-secondary); }
  span { color: var(--novelist-text-secondary); }
</style>
