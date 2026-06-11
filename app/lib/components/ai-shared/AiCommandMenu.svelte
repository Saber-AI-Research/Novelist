<script lang="ts">
  import type { SlashCommandId } from './context';
  import type { SlashMenuItem } from './menu-items';

  type Props = {
    items: readonly SlashMenuItem[];
    activeIndex: number;
    onPick: (id: SlashCommandId) => void;
  };

  let { items, activeIndex, onPick }: Props = $props();
</script>

{#if items.length > 0}
  <div class="menu" data-testid="ai-command-menu">
    {#each items as cmd, i (cmd.id)}
      <button
        type="button"
        class:active={i === activeIndex}
        data-active={i === activeIndex || undefined}
        onclick={() => onPick(cmd.id)}
      >
        <strong>{cmd.label}</strong>
        <span>{cmd.hint}</span>
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
