<script lang="ts">
  import { onMount } from 'svelte';
  import { save } from '@tauri-apps/plugin-dialog';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { themeToCSS } from '$lib/themes';

  interface Props { onClose: () => void; }
  let { onClose }: Props = $props();

  let pandocAvailable = $state(false);
  let pandocVersion = $state('');
  let format = $state('html');
  let includeTheme = $state(true);
  let status = $state<'idle' | 'exporting' | 'success' | 'error'>('idle');
  let message = $state('');
  let exportFileCount = $state(0);

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
    exportFileCount = files.length;

    // Build extra args — for HTML, inject theme CSS via pandoc --css
    const extraArgs: string[] = [];
    if (format === 'html' && includeTheme) {
      // Write a temporary CSS file with the current theme
      const themeCSS = themeToCSS(uiStore.currentTheme);
      const fullCSS = `${themeCSS}
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; background: var(--novelist-bg); color: var(--novelist-text); line-height: 1.7; }
h1, h2, h3, h4, h5, h6 { color: var(--novelist-heading-color); }
a { color: var(--novelist-link-color); }
code { background: var(--novelist-code-bg); padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
pre { background: var(--novelist-code-bg); padding: 16px; border-radius: 6px; overflow-x: auto; }
blockquote { border-left: 3px solid var(--novelist-blockquote-border); padding-left: 16px; color: var(--novelist-text-secondary); font-style: italic; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; }
th, td { border: 1px solid var(--novelist-border); padding: 8px 12px; text-align: left; }
th { background: var(--novelist-bg-secondary); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--novelist-border); margin: 24px 0; }
img { max-width: 100%; border-radius: 6px; }`;
      const cssPath = '/tmp/novelist-export-theme.css';
      await commands.writeFile(cssPath, fullCSS);
      extraArgs.push('--css', cssPath);
    }

    const result = await commands.exportProject(files, outputPath, format, extraArgs);
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

    <!-- Theme option (HTML/EPUB) -->
    {#if format === 'html' || format === 'epub'}
      <label class="flex items-center gap-2 mb-4 text-sm cursor-pointer" style="color: var(--novelist-text-secondary);">
        <input type="checkbox" bind:checked={includeTheme} class="cursor-pointer" />
        Include current theme styling ({uiStore.currentTheme.name})
      </label>
    {/if}

    <!-- Status message -->
    {#if status === 'exporting'}
      <div class="mb-4">
        <p class="text-sm mb-2" style="color: var(--novelist-text-secondary);">
          Exporting {exportFileCount} {exportFileCount === 1 ? 'file' : 'files'}&hellip;
        </p>
        <div class="export-progress-track">
          <div class="export-progress-bar"></div>
        </div>
      </div>
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

<style>
  .export-progress-track {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--novelist-bg-secondary);
    overflow: hidden;
  }

  .export-progress-bar {
    width: 40%;
    height: 100%;
    border-radius: 2px;
    background: var(--novelist-accent);
    animation: export-indeterminate 1.4s ease-in-out infinite;
  }

  @keyframes export-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    50% {
      transform: translateX(150%);
    }
    100% {
      transform: translateX(-100%);
    }
  }
</style>
