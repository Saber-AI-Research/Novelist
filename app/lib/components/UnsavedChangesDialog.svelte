<script lang="ts">
  import { t } from '$lib/i18n';

  interface Props {
    fileNames: string;
    saveLabel: string;
    onSave: () => void;
    onDontSave: () => void;
    onCancel: () => void;
  }

  let { fileNames, saveLabel, onSave, onDontSave, onCancel }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      onCancel();
    }
  }

  function focusPrimary(el: HTMLButtonElement) {
    requestAnimationFrame(() => el.focus());
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  onclick={handleBackdropClick}
  data-testid="unsaved-changes-dialog"
>
  <div
    class="rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
    style="background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="unsaved-dialog-title"
    tabindex="-1"
  >
    <h2 id="unsaved-dialog-title" class="text-base font-semibold mb-3">
      {t('dialog.unsavedChanges')}
    </h2>

    <p class="text-sm mb-5 whitespace-pre-line" style="color: var(--novelist-text-secondary);">
      {t('dialog.unsavedBeforeClose', { names: fileNames })}
    </p>

    <div class="flex gap-3 justify-end">
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: transparent; color: var(--novelist-text-secondary);"
        onclick={onCancel}
        data-testid="unsaved-cancel"
      >
        {t('dialog.unsavedCancel')}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
        onclick={onDontSave}
        data-testid="unsaved-dont-save"
      >
        {t('dialog.dontSave')}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-accent); color: #fff;"
        onclick={onSave}
        use:focusPrimary
        data-testid="unsaved-save"
      >
        {saveLabel}
      </button>
    </div>
  </div>
</div>
