<script lang="ts">
  import { t } from '$lib/i18n';
  import { projectStore } from '$lib/stores/project.svelte';
  import { templatesStore } from '$lib/stores/templates.svelte';
  import type { TemplateMode } from '$lib/ipc/commands';
  import { IconClose } from './icons';

  interface Props {
    /** If set, the dialog edits an existing template; otherwise it creates. */
    initialId?: string | null;
    initialName?: string;
    initialBody?: string;
    initialMode?: TemplateMode;
    initialDefaultFilename?: string;
    initialDescription?: string;
    onClose: () => void;
  }
  let {
    initialId = null,
    initialName = '',
    initialBody = '',
    initialMode = 'insert' as TemplateMode,
    initialDefaultFilename = '',
    initialDescription = '',
    onClose,
  }: Props = $props();

  // Prop values are intentionally snapshot once on mount so user edits
  // aren't clobbered if the parent re-renders with the same initialX.
  /* eslint-disable svelte/valid-compile */
  // svelte-ignore state_referenced_locally
  let name = $state(initialName);
  // svelte-ignore state_referenced_locally
  let mode = $state<TemplateMode>(initialMode);
  // svelte-ignore state_referenced_locally
  let defaultFilename = $state(initialDefaultFilename);
  // svelte-ignore state_referenced_locally
  let description = $state(initialDescription);
  // svelte-ignore state_referenced_locally
  let body = $state(initialBody);
  /* eslint-enable svelte/valid-compile */
  let error = $state<string>('');
  let saving = $state(false);

  const isEditing = $derived(!!initialId);

  function slugify(s: string): string {
    const base = s.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (base.length === 0) return `template-${Date.now()}`;
    // first char must be alnum
    return /^[a-z0-9]/.test(base) ? base : `t-${base}`;
  }

  const canSave = $derived(
    name.trim().length > 0 &&
      (mode === 'insert' || defaultFilename.trim().length > 0) &&
      !!projectStore.dirPath
  );

  async function save() {
    if (!canSave) return;
    const pd = projectStore.dirPath;
    if (!pd) return;
    saving = true;
    error = '';
    try {
      const id = initialId ?? slugify(name);
      await templatesStore.create(
        pd,
        id,
        {
          name: name.trim(),
          mode,
          description: description.trim() ? description.trim() : null,
          defaultFilename: mode === 'new-file' && defaultFilename.trim() ? defaultFilename.trim() : null,
        },
        body,
      );
      onClose();
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      saving = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); return; }
  }
</script>

<svelte:window onkeydown={onKey} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tmpl-backdrop" data-testid="template-dialog" onclick={onClose}>
  <div class="tmpl-card" onclick={(e) => e.stopPropagation()}>
    <div class="tmpl-head">
      <span>{isEditing ? t('template.dialogEditTitle') : t('template.dialogNewTitle')}</span>
      <button type="button" class="tmpl-x" onclick={onClose} aria-label={t('template.dialogCancel')}><IconClose size={14} /></button>
    </div>

    <div class="tmpl-body">
      <label class="tmpl-label">
        {t('template.dialogName')}
        <input data-testid="template-dialog-name" type="text" bind:value={name} autocomplete="off" />
      </label>

      <div class="tmpl-label">
        {t('template.dialogMode')}
        <div class="tmpl-radios" role="radiogroup">
          <label class="tmpl-radio">
            <input type="radio" value="insert" bind:group={mode} />
            <span>{t('template.modeInsert')}</span>
          </label>
          <label class="tmpl-radio">
            <input type="radio" value="new-file" bind:group={mode} />
            <span>{t('template.modeNewFile')}</span>
          </label>
        </div>
      </div>

      {#if mode === 'new-file'}
        <label class="tmpl-label">
          {t('template.dialogFilename')}
          <input data-testid="template-dialog-filename" type="text" bind:value={defaultFilename} placeholder="例如：人物设定.md" />
        </label>
      {/if}

      <label class="tmpl-label">
        {t('template.dialogDescription')}
        <input data-testid="template-dialog-description" type="text" bind:value={description} autocomplete="off" />
      </label>

      <label class="tmpl-label">
        {t('template.dialogBody')}
        <textarea data-testid="template-dialog-body" bind:value={body} rows="10"></textarea>
      </label>

      {#if error}
        <div class="tmpl-err">{error}</div>
      {/if}
    </div>

    <div class="tmpl-foot">
      <button type="button" class="tmpl-btn tmpl-btn-ghost" onclick={onClose}>
        {t('template.dialogCancel')}
      </button>
      <button
        type="button"
        class="tmpl-btn tmpl-btn-primary"
        data-testid="template-dialog-save"
        disabled={!canSave || saving}
        onclick={save}
      >
        {saving ? '…' : t('template.dialogSave')}
      </button>
    </div>
  </div>
</div>

<style>
  .tmpl-backdrop {
    position: fixed; inset: 0;
    background: color-mix(in srgb, #000 35%, transparent);
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .tmpl-card {
    width: 100%;
    max-width: 560px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.25);
    display: flex;
    flex-direction: column;
    max-height: 90vh;
  }
  .tmpl-head {
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border));
    font-size: 13px;
    font-weight: 600;
    color: var(--novelist-text);
  }
  .tmpl-x {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 14px;
    color: var(--novelist-text-secondary);
    padding: 2px 6px;
  }
  .tmpl-body {
    padding: 12px 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tmpl-label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: var(--novelist-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tmpl-label input[type="text"],
  .tmpl-label textarea {
    font-size: 13px;
    color: var(--novelist-text);
    background: var(--novelist-editor-bg, var(--novelist-bg));
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    padding: 6px 8px;
    outline: none;
    text-transform: none;
    letter-spacing: 0;
    font-family: inherit;
  }
  .tmpl-label textarea {
    font-family: var(--novelist-mono, "JetBrains Mono", monospace);
    resize: vertical;
    min-height: 120px;
  }
  .tmpl-radios {
    display: flex;
    gap: 12px;
    text-transform: none;
    font-size: 12px;
    color: var(--novelist-text);
  }
  .tmpl-radio {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .tmpl-err {
    font-size: 12px;
    color: #e55;
  }
  .tmpl-foot {
    padding: 10px 14px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    border-top: 1px solid var(--novelist-border-subtle, var(--novelist-border));
  }
  .tmpl-btn {
    padding: 5px 14px;
    border-radius: 4px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--novelist-border);
    background: transparent;
    color: var(--novelist-text);
  }
  .tmpl-btn-primary {
    background: var(--novelist-accent);
    border-color: var(--novelist-accent);
    color: white;
  }
  .tmpl-btn-primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .tmpl-btn-ghost {
    color: var(--novelist-text-secondary);
  }
</style>
