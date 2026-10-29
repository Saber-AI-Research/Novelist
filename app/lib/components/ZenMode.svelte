<script lang="ts">
  import { onMount } from 'svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { t } from '$lib/i18n';

  import type { Snippet } from 'svelte';

  interface Props {
    wordCount?: number;
    children: Snippet;
  }
  let { wordCount = 0, children }: Props = $props();

  let hudVisible = $state(true);
  let hudTimer: ReturnType<typeof setTimeout>;

  function resetHudTimer() {
    hudVisible = true;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => { hudVisible = false; }, 3000);
  }

  onMount(() => {
    resetHudTimer();
    return () => clearTimeout(hudTimer);
  });
</script>

<div
  class="zen-overlay"
  data-testid="zen-mode"
  role="presentation"
  onmousemove={resetHudTimer}
  onpointerdown={resetHudTimer}
  onkeydown={resetHudTimer}
>
  <!-- Drag region for window movement -->
  <div data-tauri-drag-region class="zen-drag-strip"></div>

  <!-- The editor is rendered inside here by App.svelte -->
  {@render children()}

  {#if hudVisible}
    <div class="zen-hud">
      {t('zen.words', { count: wordCount.toLocaleString() })}
    </div>
  {/if}

  <button class="zen-exit-btn" onclick={() => uiStore.toggleZen()}>
    {t('zen.exit')}
  </button>
</div>

<style>
  .zen-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #1a1a2e;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .zen-drag-strip {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 38px;
    z-index: 1;
    -webkit-app-region: drag;
  }

  .zen-hud {
    position: fixed;
    bottom: 16px;
    right: 16px;
    color: rgba(224, 224, 224, 0.5);
    font-size: 12px;
    transition: opacity 300ms;
  }

  .zen-exit-btn {
    position: fixed;
    top: 8px;
    right: 8px;
    background: transparent;
    border: none;
    color: rgba(224, 224, 224, 0.3);
    font-size: 11px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 300ms;
  }
  .zen-overlay:hover .zen-exit-btn { opacity: 1; }
  /* No hover on touch: keep the exit button reachable. */
  @media (hover: none) {
    .zen-exit-btn { opacity: 1; }
  }
  @media (pointer: coarse) {
    .zen-exit-btn {
      min-height: 44px;
      padding: 0 12px;
    }
  }

  /* Mobile: no window to drag; keep the chrome clear of notch, home indicator
     and on-screen keyboard (anchored to the visual viewport's bottom edge). */
  :global(html[data-mobile='true']) .zen-drag-strip {
    display: none;
  }
  :global(html[data-mobile='true']) .zen-exit-btn {
    top: calc(8px + env(safe-area-inset-top));
    right: calc(8px + env(safe-area-inset-right));
  }
  :global(html[data-mobile='true']) .zen-hud {
    bottom: auto;
    top: calc(var(--novelist-vv-top, 0px) + var(--novelist-vv-height, 100vh) - 16px - env(safe-area-inset-bottom));
    right: calc(16px + env(safe-area-inset-right));
    transform: translateY(-100%);
  }
  :global(html[data-mobile='true'][data-keyboard='open']) .zen-hud {
    top: calc(var(--novelist-vv-top, 0px) + var(--novelist-vv-height, 100vh) - 16px);
  }
</style>
