<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
  let error = $state<Error | null>(null);
  let resetFn = $state<(() => void) | null>(null);

  function handleReload() {
    location.reload();
  }

  function handleReset() {
    error = null;
    resetFn?.();
  }
</script>

<svelte:boundary onerror={(e, reset) => { error = e instanceof Error ? e : new Error(String(e)); resetFn = reset; }}>
  {#if error}
    <div class="error-boundary">
      <div class="error-boundary-content">
        <h2 class="error-boundary-title">{t('error.title')}</h2>
        <p class="error-boundary-message">{t('error.message')}</p>
        <pre class="error-boundary-detail">{error.message}</pre>
        <div class="error-boundary-actions">
          <button class="error-boundary-btn secondary" onclick={handleReset}>{t('error.tryAgain')}</button>
          <button class="error-boundary-btn primary" onclick={handleReload}>{t('error.reload')}</button>
        </div>
      </div>
    </div>
  {:else}
    {@render children()}
  {/if}
</svelte:boundary>

<style>
  .error-boundary {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
    background: var(--novelist-bg);
    color: var(--novelist-text);
  }

  .error-boundary-content {
    text-align: center;
    max-width: 420px;
    padding: 2rem;
  }

  .error-boundary-title {
    font-size: 1.2rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
    color: var(--novelist-text);
  }

  .error-boundary-message {
    font-size: 0.85rem;
    margin: 0 0 1rem;
    opacity: 0.7;
  }

  .error-boundary-detail {
    font-size: 0.75rem;
    background: color-mix(in srgb, var(--novelist-border) 30%, transparent);
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    padding: 0.75rem;
    margin: 0 0 1.25rem;
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
    max-height: 120px;
    overflow-y: auto;
  }

  .error-boundary-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
  }

  .error-boundary-btn {
    padding: 0.4rem 1rem;
    border-radius: 6px;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid var(--novelist-border);
    transition: background 100ms, color 100ms;
  }

  .error-boundary-btn.primary {
    background: var(--novelist-accent);
    color: #fff;
    border-color: var(--novelist-accent);
  }

  .error-boundary-btn.primary:hover {
    opacity: 0.9;
  }

  .error-boundary-btn.secondary {
    background: transparent;
    color: var(--novelist-text);
  }

  .error-boundary-btn.secondary:hover {
    background: color-mix(in srgb, var(--novelist-border) 40%, transparent);
  }
</style>
