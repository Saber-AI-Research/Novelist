<script lang="ts">
  import { commands } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';
  import { isImeComposing } from '$lib/utils/ime';

  interface Props {
    existingIds: string[];
    onCancel: () => void;
    onCreated: (pluginPath: string) => void;
  }
  let { existingIds, onCancel, onCreated }: Props = $props();

  let id = $state('');
  let name = $state('');
  let busy = $state(false);
  let errorMsg = $state('');

  const idPattern = /^[a-z0-9][a-z0-9-]*$/;

  let validation = $derived.by<string>(() => {
    if (id.length === 0) return '';
    if (!idPattern.test(id)) return t('settings.plugins.scaffold.invalidId');
    if (existingIds.includes(id)) return t('settings.plugins.scaffold.idTaken');
    return '';
  });

  let canSubmit = $derived(id.length > 0 && validation === '' && !busy);

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    errorMsg = '';
    const result = await commands.scaffoldPlugin(id, name.trim() || null);
    busy = false;
    if (result.status === 'ok') {
      onCreated(result.data);
    } else {
      errorMsg = typeof result.error === 'string' ? result.error : 'Unknown error';
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (isImeComposing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Enter' && canSubmit) { e.preventDefault(); submit(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="scaffold-overlay" onkeydown={onKeydown} role="dialog" aria-modal="true" tabindex="-1">
  <div class="scaffold-panel" data-testid="plugin-scaffold-dialog">
    <h4 class="scaffold-title">{t('settings.plugins.scaffold.title')}</h4>

    <label class="scaffold-label" for="scaffold-id">{t('settings.plugins.scaffold.id')}</label>
    <input
      id="scaffold-id"
      class="scaffold-input"
      bind:value={id}
      placeholder="my-plugin"
      autocomplete="off"
      data-testid="plugin-scaffold-id"
    />
    {#if validation}
      <p class="scaffold-hint">{validation}</p>
    {/if}

    <label class="scaffold-label" for="scaffold-name">{t('settings.plugins.scaffold.name')}</label>
    <input
      id="scaffold-name"
      class="scaffold-input"
      bind:value={name}
      placeholder={id || 'My Plugin'}
      autocomplete="off"
    />

    {#if errorMsg}
      <p class="scaffold-error">{errorMsg}</p>
    {/if}

    <div class="scaffold-actions">
      <button class="scaffold-btn" onclick={onCancel} disabled={busy}>{t('settings.plugins.scaffold.cancel')}</button>
      <button
        class="scaffold-btn scaffold-btn-primary"
        onclick={submit}
        disabled={!canSubmit}
        data-testid="plugin-scaffold-create"
      >{t('settings.plugins.scaffold.create')}</button>
    </div>
  </div>
</div>

<style>
  .scaffold-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .scaffold-panel {
    min-width: 320px;
    padding: 16px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    color: var(--novelist-text);
  }
  .scaffold-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 12px; }
  .scaffold-label { display: block; font-size: 0.75rem; margin-top: 8px; margin-bottom: 4px; color: var(--novelist-text-secondary); }
  .scaffold-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 0.85rem;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    outline: none;
  }
  .scaffold-input:focus { border-color: var(--novelist-accent); }
  .scaffold-hint { color: #e5484d; font-size: 0.72rem; margin-top: 4px; }
  .scaffold-error { color: #e5484d; font-size: 0.72rem; margin-top: 8px; }
  .scaffold-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .scaffold-btn {
    padding: 5px 12px;
    font-size: 0.78rem;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text);
    cursor: pointer;
  }
  .scaffold-btn:hover:not(:disabled) { border-color: var(--novelist-accent); }
  .scaffold-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .scaffold-btn-primary {
    background: var(--novelist-accent);
    color: #fff;
    border-color: var(--novelist-accent);
  }
</style>
