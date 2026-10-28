<script lang="ts" module>
  export interface PanelBarEntry {
    key: string;
    label: string;
    active: boolean;
    testId: string;
    onSelect: () => void;
  }
</script>

<script lang="ts">
  import { t } from '$lib/i18n';

  /**
   * Horizontal, scrollable panel switcher for the touch shell. Replaces the
   * desktop 20px vertical rail; entries (and their data-testids) are built
   * by App.svelte so both surfaces toggle the same store state.
   */
  interface Props {
    entries: PanelBarEntry[];
  }
  let { entries }: Props = $props();
</script>

<nav class="mobile-panel-bar" aria-label={t('mobile.panels')} data-testid="mobile-panel-bar">
  {#each entries as entry (entry.key)}
    <button
      type="button"
      class="mobile-panel-chip"
      class:active={entry.active}
      data-testid={entry.testId}
      aria-pressed={entry.active}
      onclick={entry.onSelect}
    >
      {entry.label}
    </button>
  {/each}
</nav>

<style>
  .mobile-panel-bar {
    flex-shrink: 0;
    display: flex;
    gap: 6px;
    align-items: center;
    min-height: 44px;
    padding: 0 max(8px, env(safe-area-inset-right, 0px)) 0 max(8px, env(safe-area-inset-left, 0px));
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    background: var(--novelist-bg);
    border-top: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .mobile-panel-bar::-webkit-scrollbar {
    display: none;
  }
  .mobile-panel-chip {
    flex: 0 0 auto;
    min-height: 36px;
    min-width: 44px;
    padding: 0 14px;
    border: 1px solid var(--novelist-border);
    border-radius: 18px;
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 14px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  @media (pointer: coarse) {
    .mobile-panel-chip {
      min-height: 44px;
      border-radius: 22px;
    }
  }
  .mobile-panel-chip.active {
    border-color: color-mix(in srgb, var(--novelist-accent) 55%, var(--novelist-border));
    background: color-mix(in srgb, var(--novelist-accent) 12%, transparent);
    color: var(--novelist-accent);
  }
  .mobile-panel-chip:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--novelist-accent) 45%, transparent);
    outline-offset: 1px;
  }
</style>
