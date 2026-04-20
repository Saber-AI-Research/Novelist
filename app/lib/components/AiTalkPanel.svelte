<script lang="ts">
  // Thin async shim. Loads the actual AI Talk implementation lazily so its
  // bundle (chat history, OpenAI helpers, settings UI) only ships to users
  // who open the panel — same pattern as CanvasFileEditor / KanbanFileEditor.

  import { onMount } from 'svelte';
  import type { Component } from 'svelte';

  let Impl = $state<Component | null>(null);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      const mod = await import('./ai-talk/AiTalkImpl.svelte');
      Impl = mod.default as unknown as Component;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      console.error('[ai-talk] failed to load:', e);
    }
  });
</script>

<div class="ai-talk-wrapper">
  {#if Impl}
    <Impl />
  {:else if loadError}
    <div class="state">
      <p class="state-title">Failed to load AI Talk</p>
      <p class="state-hint">{loadError}</p>
    </div>
  {:else}
    <div class="state">
      <span class="spinner" aria-hidden="true"></span>
      <p class="state-hint">Loading…</p>
    </div>
  {/if}
</div>

<style>
  .ai-talk-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }
  .state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--novelist-text-secondary);
  }
  .state-title { font-size: 0.95rem; font-weight: 500; margin: 0; }
  .state-hint { font-size: 0.8rem; margin: 0; opacity: 0.8; }
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid color-mix(in srgb, var(--novelist-text) 18%, transparent);
    border-top-color: var(--novelist-accent);
    border-radius: 50%;
    animation: spin 720ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
