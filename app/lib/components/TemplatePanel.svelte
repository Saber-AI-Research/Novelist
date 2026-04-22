<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import { templatesStore } from '$lib/stores/templates.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import type { TemplateFileSummary, TemplateSource } from '$lib/ipc/commands';
  import TemplateDialog from '$lib/components/TemplateDialog.svelte';
  import { IconArrowInsert, IconDocument } from './icons';

  interface Props {
    /**
     * Executes a template row the user clicked on. Returns an error message on
     * failure, or null on success. App.svelte owns this because it needs the
     * active editor view (for insert) + the ability to open a newly created
     * file as a tab (for new-file mode).
     */
    onExecute: (summary: TemplateFileSummary) => Promise<string | null>;
    /** Open dialog with a particular pre-fill (used for "Save current file as template"). */
    openDialogRequest?: { id: string | null; prefill?: { name?: string; body?: string } } | null;
    onDialogHandled?: () => void;
  }
  let { onExecute, openDialogRequest = null, onDialogHandled }: Props = $props();

  // --- dialog state ---
  let dialogOpen = $state(false);
  let dialogInitialId = $state<string | null>(null);
  let dialogPrefill = $state<{ name?: string; body?: string } | undefined>(undefined);

  // --- context menu state ---
  let ctxMenu = $state<{ x: number; y: number; summary: TemplateFileSummary } | null>(null);

  // --- error / inline toast ---
  let toast = $state<string>('');

  onMount(() => { void templatesStore.refresh(projectStore.dirPath); });

  $effect(() => {
    // Refresh whenever the project path changes (reactive dep on dirPath).
    const pd = projectStore.dirPath;
    void templatesStore.refresh(pd);
  });

  $effect(() => {
    if (openDialogRequest) {
      dialogInitialId = openDialogRequest.id;
      dialogPrefill = openDialogRequest.prefill;
      dialogOpen = true;
      onDialogHandled?.();
    }
  });

  function startNew() {
    dialogInitialId = null;
    dialogPrefill = undefined;
    dialogOpen = true;
  }

  function showCtxMenu(e: MouseEvent, s: TemplateFileSummary) {
    e.preventDefault();
    ctxMenu = { x: e.clientX, y: e.clientY, summary: s };
  }

  function closeCtxMenu() { ctxMenu = null; }

  async function onRowClick(s: TemplateFileSummary) {
    toast = '';
    const err = await onExecute(s);
    if (err) toast = err;
  }

  async function onCtxExecute(s: TemplateFileSummary) {
    closeCtxMenu();
    await onRowClick(s);
  }

  async function onCtxEdit(s: TemplateFileSummary) {
    closeCtxMenu();
    try {
      const pd = projectStore.dirPath;
      if (!pd) return;
      const full = await templatesStore.read(s.source, s.id, pd);
      dialogInitialId = s.id;
      dialogPrefill = {
        name: full.summary.name,
        body: full.body,
      };
      dialogOpen = true;
    } catch (e: any) {
      toast = e?.message ?? String(e);
    }
  }

  async function onCtxDuplicate(s: TemplateFileSummary) {
    closeCtxMenu();
    const pd = projectStore.dirPath;
    if (!pd) { toast = t('template.needProject'); return; }
    try {
      await templatesStore.duplicateBundled(pd, s.id, null);
    } catch (e: any) {
      toast = e?.message ?? String(e);
    }
  }

  async function onCtxRename(s: TemplateFileSummary) {
    closeCtxMenu();
    const pd = projectStore.dirPath;
    if (!pd) return;
    const newId = window.prompt(t('template.renamePrompt'), s.id);
    if (!newId || newId === s.id) return;
    try {
      await templatesStore.rename(pd, s.id, newId);
    } catch (e: any) {
      toast = e?.message ?? String(e);
    }
  }

  async function onCtxDelete(s: TemplateFileSummary) {
    closeCtxMenu();
    const pd = projectStore.dirPath;
    if (!pd) return;
    const ok = window.confirm(t('template.confirmDelete', { name: s.name }));
    if (!ok) return;
    try {
      await templatesStore.remove(pd, s.id);
    } catch (e: any) {
      toast = e?.message ?? String(e);
    }
  }

  function sourceLabel(src: TemplateSource): string {
    return src === 'bundled' ? t('template.groupBuiltin') : t('template.groupProject');
  }
</script>

<svelte:window onclick={closeCtxMenu} />

<div class="flex flex-col h-full" data-testid="template-panel">
  <!-- Header -->
  <div class="shrink-0 px-3 py-1.5 flex items-center justify-between"
    style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border)); background: var(--novelist-bg);">
    <span style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-secondary); font-weight: 600;">
      {t('template.title')}
    </span>
    <button
      type="button"
      class="cursor-pointer"
      data-testid="template-new"
      disabled={!projectStore.dirPath}
      onclick={startNew}
      title={t('template.new')}
      style="
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--novelist-border);
        border-radius: 3px;
        background: transparent;
        color: {projectStore.dirPath ? 'var(--novelist-text-secondary)' : 'var(--novelist-text-tertiary, var(--novelist-text-secondary))'};
        opacity: {projectStore.dirPath ? 1 : 0.4};
      "
    >+ {t('template.new')}</button>
  </div>

  {#if toast}
    <div class="shrink-0 px-3 py-1.5" style="font-size: 11px; color: #e55; background: color-mix(in srgb, #e55 8%, transparent);">
      {toast}
    </div>
  {/if}

  <!-- Groups -->
  <div class="flex-1 min-h-0 overflow-y-auto">
    {#if templatesStore.loading && templatesStore.summaries.length === 0}
      <div class="p-3" style="font-size: 12px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); text-align: center;">
        …
      </div>
    {:else}
      {@const bundled = templatesStore.bundled()}
      {@const project = templatesStore.project()}

      <div class="px-3 pt-2" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
        {sourceLabel('bundled')}
      </div>
      {#if bundled.length === 0}
        <div class="px-3 py-1" style="font-size: 11px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">…</div>
      {:else}
        {#each bundled as s (s.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="template-row"
            data-testid="template-row-{s.source}-{s.id}"
            role="button"
            tabindex="0"
            onclick={() => onRowClick(s)}
            onkeydown={(e) => { if (e.key === 'Enter') onRowClick(s); }}
            oncontextmenu={(e) => showCtxMenu(e, s)}
          >
            <span class="template-mode" aria-hidden="true">
              {#if s.mode === 'insert'}
                <IconArrowInsert size={12} />
              {:else}
                <IconDocument size={12} />
              {/if}
            </span>
            <span class="template-name">{s.name}</span>
            {#if s.description}
              <span class="template-desc">{s.description}</span>
            {/if}
          </div>
        {/each}
      {/if}

      {#if projectStore.dirPath}
        <div class="px-3 pt-3" style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
          {sourceLabel('project')}
        </div>
        {#if project.length === 0}
          <div class="px-3 py-1" style="font-size: 11px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary));">
            {t('template.emptyProject')}
          </div>
        {:else}
          {#each project as s (s.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="template-row"
              data-testid="template-row-{s.source}-{s.id}"
              role="button"
              tabindex="0"
              onclick={() => onRowClick(s)}
              onkeydown={(e) => { if (e.key === 'Enter') onRowClick(s); }}
              oncontextmenu={(e) => showCtxMenu(e, s)}
            >
              <span class="template-mode" aria-hidden="true">
              {#if s.mode === 'insert'}
                <IconArrowInsert size={12} />
              {:else}
                <IconDocument size={12} />
              {/if}
            </span>
              <span class="template-name">{s.name}</span>
              {#if s.description}
                <span class="template-desc">{s.description}</span>
              {/if}
            </div>
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
</div>

<!-- Context menu -->
{#if ctxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="tmpl-ctx-menu"
    role="menu"
    tabindex="-1"
    data-testid="template-ctx-menu"
    style="left: {ctxMenu.x}px; top: {ctxMenu.y}px;"
    onclick={(e) => e.stopPropagation()}
  >
    <button role="menuitem" class="tmpl-ctx-item" onclick={() => onCtxExecute(ctxMenu!.summary)}>
      {ctxMenu.summary.mode === 'insert' ? t('template.ctx.insert') : t('template.ctx.createFile')}
    </button>
    {#if ctxMenu.summary.source === 'bundled'}
      <button role="menuitem" class="tmpl-ctx-item" data-testid="template-ctx-duplicate" onclick={() => onCtxDuplicate(ctxMenu!.summary)} disabled={!projectStore.dirPath}>
        {t('template.ctx.duplicateToProject')}
      </button>
    {:else}
      <button role="menuitem" class="tmpl-ctx-item" data-testid="template-ctx-edit" onclick={() => onCtxEdit(ctxMenu!.summary)}>
        {t('template.ctx.edit')}
      </button>
      <button role="menuitem" class="tmpl-ctx-item" data-testid="template-ctx-rename" onclick={() => onCtxRename(ctxMenu!.summary)}>
        {t('template.ctx.rename')}
      </button>
      <div class="tmpl-ctx-sep"></div>
      <button role="menuitem" class="tmpl-ctx-item tmpl-ctx-danger" data-testid="template-ctx-delete" onclick={() => onCtxDelete(ctxMenu!.summary)}>
        {t('template.ctx.delete')}
      </button>
    {/if}
  </div>
{/if}

{#if dialogOpen}
  <TemplateDialog
    initialId={dialogInitialId}
    initialName={dialogPrefill?.name ?? ''}
    initialBody={dialogPrefill?.body ?? ''}
    onClose={() => { dialogOpen = false; dialogInitialId = null; dialogPrefill = undefined; }}
  />
{/if}

<style>
  .template-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    cursor: pointer;
    border-left: 2px solid transparent;
    transition: background 80ms;
    user-select: none;
  }
  .template-row:hover {
    background: color-mix(in srgb, var(--novelist-text) 5%, transparent);
    border-left-color: var(--novelist-accent);
  }
  .template-mode {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    opacity: 0.75;
    width: 14px;
    flex-shrink: 0;
    color: var(--novelist-text-secondary);
  }
  .template-name {
    font-size: 12px;
    color: var(--novelist-text);
  }
  .template-desc {
    font-size: 10px;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
  .tmpl-ctx-menu {
    position: fixed;
    z-index: 100;
    min-width: 180px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.18);
    padding: 4px 0;
  }
  .tmpl-ctx-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 5px 12px;
    font-size: 12px;
    color: var(--novelist-text);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .tmpl-ctx-item:hover:not([disabled]) {
    background: color-mix(in srgb, var(--novelist-accent) 12%, transparent);
  }
  .tmpl-ctx-item[disabled] {
    opacity: 0.45;
    cursor: default;
  }
  .tmpl-ctx-danger {
    color: #d43;
  }
  .tmpl-ctx-sep {
    height: 1px;
    background: var(--novelist-border-subtle, var(--novelist-border));
    margin: 4px 0;
  }
</style>
