<script lang="ts">
  import { onMount } from 'svelte';
  import { commands, type FileEntry } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  // In-project note browser for "Link a note" on mobile. The system pickers
  // there return sandbox copies or content:// URIs outside the project, which
  // a file card can never read; this lists the project itself instead.

  interface Props {
    /** Absolute project root; browsing never leaves it. */
    rootDir: string;
    /** Called with the absolute path of a note that was just read successfully. */
    onPick: (path: string) => void;
    onCancel: () => void;
  }
  let { rootDir, onPick, onCancel }: Props = $props();

  /** Same note types as the desktop dialog filter. */
  const NOTE_EXTENSIONS = ['md', 'markdown', 'txt'];

  let dir = $state('');
  let entries = $state<FileEntry[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  /** Guards against a slow listing landing after the user moved on. */
  let listToken = 0;

  const root = $derived(rootDir.replace(/\/+$/, ''));
  const segments = $derived(dir.length > root.length ? dir.slice(root.length + 1).split('/').filter(Boolean) : []);
  const rootName = $derived(root.slice(root.lastIndexOf('/') + 1) || root);

  function isNote(entry: FileEntry): boolean {
    const dot = entry.name.lastIndexOf('.');
    return dot > 0 && NOTE_EXTENSIONS.includes(entry.name.slice(dot + 1).toLowerCase());
  }

  async function open(path: string) {
    const token = ++listToken;
    dir = path;
    loading = true;
    error = null;
    const result = await commands.listDirectory(path, false)
      .catch((cause: unknown) => ({ status: 'error' as const, error: String(cause) }));
    if (token !== listToken) return;
    loading = false;
    if (result.status !== 'ok') {
      entries = [];
      error = t('canvas.picker.listFailed', { error: result.error });
      return;
    }
    entries = result.data
      .filter((entry) => entry.is_dir || isNote(entry))
      .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  }

  function openSegment(count: number) {
    void open(count === 0 ? root : `${root}/${segments.slice(0, count).join('/')}`);
  }

  /** Only a note that can actually be read becomes a card. */
  async function pick(entry: FileEntry) {
    busy = true;
    error = null;
    const result = await commands.readFile(entry.path)
      .catch((cause: unknown) => ({ status: 'error' as const, error: String(cause) }));
    busy = false;
    if (result.status === 'ok') onPick(entry.path);
    else error = t('canvas.picker.unreadable', { error: result.error });
  }

  function onKeydown(e: KeyboardEvent) {
    // Keep Backspace/Delete away from SvelteFlow's delete-selection handler.
    e.stopPropagation();
    if (e.key === 'Escape') onCancel();
  }

  onMount(() => {
    panelEl?.focus();
    void open(root);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onCancel} onkeydown={onKeydown} data-testid="canvas-note-picker">
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-label={t('canvas.addFileNode')}
    tabindex="-1"
    bind:this={panelEl}
    onclick={(e) => e.stopPropagation()}
  >
    <header>
      <button
        type="button"
        class="up"
        disabled={segments.length === 0 || busy}
        title={t('canvas.picker.up')}
        aria-label={t('canvas.picker.up')}
        onclick={() => openSegment(segments.length - 1)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3 5 8l5 5"/></svg>
      </button>
      <nav class="crumbs" aria-label={t('canvas.addFileNode')}>
        <button type="button" class="crumb" disabled={busy} onclick={() => openSegment(0)}>{rootName}</button>
        {#each segments as segment, i}
          <span class="crumb-sep" aria-hidden="true">/</span>
          <button type="button" class="crumb" disabled={busy} onclick={() => openSegment(i + 1)}>{segment}</button>
        {/each}
      </nav>
      <button type="button" class="cancel" onclick={onCancel}>{t('dialog.cancel')}</button>
    </header>

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <ul class="entries" aria-busy={loading || busy}>
      {#if loading}
        <li class="hint">{t('canvas.loading')}</li>
      {:else if entries.length === 0 && !error}
        <li class="hint">{t('canvas.picker.empty')}</li>
      {:else}
        {#each entries as entry (entry.path)}
          <li>
            <button
              type="button"
              class="entry"
              class:dir={entry.is_dir}
              disabled={busy}
              data-testid="canvas-note-picker-entry"
              onclick={() => (entry.is_dir ? open(entry.path) : pick(entry))}
            >
              {#if entry.is_dir}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/></svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>
              {/if}
              <span class="name">{entry.name}</span>
              {#if entry.is_dir}
                <svg class="chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 3 5 5-5 5"/></svg>
              {/if}
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: color-mix(in srgb, var(--novelist-bg) 60%, transparent);
  }
  .panel {
    width: min(440px, 100%);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 10px;
    box-shadow: 0 8px 28px color-mix(in srgb, var(--novelist-text) 18%, transparent);
    overflow: hidden;
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }
  .crumbs {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    overflow-x: auto;
    scrollbar-width: none;
    white-space: nowrap;
  }
  .crumb-sep { color: var(--novelist-text-secondary); padding: 0 2px; }
  button {
    min-height: 44px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--novelist-text);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    touch-action: manipulation;
  }
  button:disabled { opacity: 0.45; cursor: default; }
  .up {
    min-width: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--novelist-text-secondary);
  }
  .crumb { padding: 0 6px; flex-shrink: 0; }
  .cancel { padding: 0 12px; color: var(--novelist-accent); }
  .error {
    margin: 0;
    padding: 8px 12px;
    color: var(--novelist-error, #c53d43);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .entries {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 4px;
    list-style: none;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .entry {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    text-align: left;
  }
  .entry svg { flex-shrink: 0; opacity: 0.65; }
  .entry.dir .name { font-weight: 500; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint {
    padding: 16px 12px;
    color: var(--novelist-text-secondary);
    font-size: 0.82rem;
    text-align: center;
  }
  @media (hover: hover) {
    button:not(:disabled):hover { background: color-mix(in srgb, var(--novelist-text) 7%, transparent); }
  }
</style>
