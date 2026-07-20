<script lang="ts">
  import { onMount } from 'svelte';
  import { commandRegistry, getSecondaryLabel } from '$lib/stores/commands.svelte';
  import { formatShortcut } from '$lib/stores/shortcuts.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl: HTMLInputElement;

  const results = $derived(commandRegistry.search(query));

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, results.length - 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, 0); }
    if (e.key === 'Enter' && results[selectedIndex]) {
      commandRegistry.execute(results[selectedIndex].id);
      onClose();
    }
  }

  // Reset selection on query change
  $effect(() => { query; selectedIndex = 0; });

  onMount(() => {
    inputEl?.focus();
  });
</script>

<div class="palette-backdrop" data-testid="command-palette" role="presentation" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="palette-container" onclick={(e) => e.stopPropagation()}>
    <input
      bind:this={inputEl}
      bind:value={query}
      onkeydown={handleKeydown}
      placeholder={t('palette.placeholder')}
      class="palette-input"
      data-testid="palette-input"
    />
    <ul class="palette-list">
      {#each results as cmd, i}
        {@const sec = getSecondaryLabel(cmd)}
        <li>
          <button
            class="palette-item"
            class:selected={i === selectedIndex}
            data-testid="palette-result-{i}"
            onclick={() => { commandRegistry.execute(cmd.id); onClose(); }}
            onmouseenter={() => { selectedIndex = i; }}
          >
            <span class="palette-labels">
              <span class="palette-primary">{cmd.label}</span>
              {#if sec}
                <span class="palette-secondary">{sec}</span>
              {/if}
            </span>
            {#if cmd.shortcut}
              <span class="shortcut">{formatShortcut(cmd.shortcut)}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .palette-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    padding-top: 80px;
  }

  .palette-container {
    width: 500px;
    max-height: 400px;
    background: var(--novelist-bg-secondary, #1e1e2e);
    border: 1px solid var(--novelist-border, #333);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .palette-input {
    width: 100%;
    padding: 12px 16px;
    border: none;
    border-bottom: 1px solid var(--novelist-border, #333);
    background: transparent;
    color: var(--novelist-text, #e0e0e0);
    font-size: 14px;
    outline: none;
  }

  .palette-input::placeholder {
    color: var(--novelist-text-secondary, #888);
  }

  .palette-list {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow-y: auto;
    flex: 1;
  }

  .palette-list li {
    margin: 0;
    padding: 0;
  }

  .palette-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--novelist-text, #e0e0e0);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
  }

  .palette-labels {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .palette-primary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .palette-secondary {
    font-size: 10.5px;
    color: var(--novelist-text-secondary, #888);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .palette-item:hover,
  .palette-item.selected {
    background: color-mix(in srgb, var(--novelist-accent, #7c3aed) 20%, transparent);
  }

  .shortcut {
    font-size: 12px;
    color: var(--novelist-text-secondary, #888);
    background: rgba(255, 255, 255, 0.08);
    padding: 2px 6px;
    border-radius: 3px;
    /* Apple shortcut symbols (⇧⌘⌥⌃) render poorly in the default monospace
       stacks on macOS — they get the system fallback at a smaller weight
       than the surrounding letter and look washed out. Use the UI font
       (which has hand-tuned glyphs for these) and a slightly heavier
       weight so the modifiers stay legible next to the letter. */
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
</style>
