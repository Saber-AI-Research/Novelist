<script lang="ts">
  import { onMount } from 'svelte';
  import { save } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  let pandocAvailable = $state(false);
  let pandocVersion = $state('');
  let format = $state('html');
  let status = $state<'idle' | 'exporting' | 'success' | 'error'>('idle');
  let message = $state('');

  const formats = [
    { value: 'html', label: 'HTML' },
    { value: 'pdf', label: 'PDF' },
    { value: 'docx', label: 'DOCX (Word)' },
    { value: 'epub', label: 'EPUB' },
  ];

  onMount(async () => {
    const result = await commands.checkPandoc();
    if (result.status === 'ok') {
      pandocAvailable = result.data.available;
      pandocVersion = result.data.version || '';
    }
  });

  async function doExport() {
    // Get file list from project
    const files = projectStore.files
      .filter(f => !f.is_dir && (f.name.endsWith('.md') || f.name.endsWith('.markdown')))
      .map(f => f.path);

    if (files.length === 0) {
      message = 'No markdown files to export';
      status = 'error';
      return;
    }

    // Ask for output path
    const ext = format === 'html' ? 'html' : format;
    const outputPath = await save({
      defaultPath: `export.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!outputPath) return;

    status = 'exporting';
    message = '';
    const result = await commands.exportProject(files, outputPath, format, []);
    if (result.status === 'ok') {
      status = 'success';
      message = result.data;
    } else {
      status = 'error';
      message = result.error;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Overlay -->
<div
  class="fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  role="dialog"
  aria-modal="true"
  aria-labelledby="export-dialog-title"
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="rounded-lg shadow-xl p-6 w-full mx-4"
    style="
      max-width: 420px;
      background: var(--novelist-bg);
      color: var(--novelist-text);
      border: 1px solid var(--novelist-border);
    "
    onclick={(e) => e.stopPropagation()}
  >
    <h2 id="export-dialog-title" class="text-base font-semibold mb-4">
      Export Project
    </h2>

    <!-- Pandoc status -->
    <div
      class="rounded px-3 py-2 mb-5 text-sm"
      style="
        background: var(--novelist-bg-secondary);
        border: 1px solid var(--novelist-border);
      "
    >
      {#if pandocAvailable}
        <span style="color: #4ade80;">&#x2713; Pandoc available</span>
        {#if pandocVersion}
          <span style="color: var(--novelist-text-secondary);"> &mdash; {pandocVersion}</span>
        {/if}
      {:else}
        <span style="color: #f87171;">&#x2717; Pandoc not found</span>
        <p class="mt-1" style="color: var(--novelist-text-secondary);">
          Install pandoc from <strong>pandoc.org/installing</strong> to enable export.
        </p>
      {/if}
    </div>

    <!-- Format selector -->
    <div class="mb-5">
      <p class="block text-sm mb-2" style="color: var(--novelist-text-secondary);">
        Export format
      </p>
      <div class="flex gap-2 flex-wrap">
        {#each formats as f}
          <button
            class="px-3 py-1 rounded text-sm cursor-pointer"
            style="
              border: 1px solid {format === f.value ? 'var(--novelist-accent)' : 'var(--novelist-border)'};
              background: {format === f.value ? 'color-mix(in srgb, var(--novelist-accent) 20%, transparent)' : 'transparent'};
              color: {format === f.value ? 'var(--novelist-accent)' : 'var(--novelist-text)'};
            "
            onclick={() => { format = f.value; status = 'idle'; message = ''; }}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- Status message -->
    {#if status === 'exporting'}
      <p class="text-sm mb-4" style="color: var(--novelist-text-secondary);">
        Exporting&hellip;
      </p>
    {:else if status === 'success'}
      <p class="text-sm mb-4" style="color: #4ade80;">
        {message}
      </p>
    {:else if status === 'error'}
      <p class="text-sm mb-4" style="color: #f87171;">
        {message}
      </p>
    {/if}

    <!-- Actions -->
    <div class="flex gap-3 justify-end">
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="
          background: var(--novelist-bg-secondary);
          color: var(--novelist-text);
          border: 1px solid var(--novelist-border);
        "
        onclick={onClose}
      >
        Close
      </button>
      <button
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="
          background: var(--novelist-accent);
          color: #fff;
          opacity: {!pandocAvailable || status === 'exporting' ? '0.5' : '1'};
          cursor: {!pandocAvailable || status === 'exporting' ? 'not-allowed' : 'pointer'};
        "
        disabled={!pandocAvailable || status === 'exporting'}
        onclick={doExport}
      >
        {status === 'exporting' ? 'Exporting...' : 'Export'}
      </button>
    </div>
  </div>
</div>
