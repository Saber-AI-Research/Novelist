<script lang="ts">
  // Thin async shim for the AI Agent panel — same lazy-load pattern as
  // AiTalkPanel and the canvas/kanban shims.

  import { onMount } from 'svelte';
  import type { Component } from 'svelte';

  let Impl = $state<Component | null>(null);
  let loadError = $state<string | null>(null);

  onMount(async () => {
    try {
      const mod = await import('./ai-agent/AiAgentImpl.svelte');
      Impl = mod.default as unknown as Component;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      console.error('[ai-agent] failed to load:', e);
    }
  });
</script>

<div class="ai-agent-wrapper" data-testid="ai-agent-panel">
  {#if Impl}
    <Impl />
  {:else if loadError}
    <div class="state">
      <p class="state-title">Failed to load AI Agent</p>
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
  .ai-agent-wrapper {
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
