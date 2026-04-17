<script lang="ts">
  import { onMount } from 'svelte';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let query = $state('');
  let results = $state<{ file_path: string; file_name: string; line_number: number; line_text: string; match_start: number; match_end: number }[]>([]);
  let searching = $state(false);
  let inputEl: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  async function doSearch(q: string) {
    if (!q.trim() || !projectStore.dirPath) {
      results = [];
      return;
    }
    searching = true;
    const res = await commands.searchInProject(projectStore.dirPath, q.trim());
    if (res.status === 'ok') {
      results = res.data;
    } else {
      results = [];
    }
    searching = false;
  }

  $effect(() => {
    const q = query;
    clearTimeout(debounceTimer);
    if (!q.trim()) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(() => doSearch(q), 300);
  });

  // Group results by file
  let groupedResults = $derived.by(() => {
    const groups: { filePath: string; fileName: string; matches: typeof results }[] = [];
    const map = new Map<string, typeof results>();
    for (const r of results) {
      let arr = map.get(r.file_path);
      if (!arr) {
        arr = [];
        map.set(r.file_path, arr);
      }
      arr.push(r);
    }
    for (const [filePath, matches] of map) {
      groups.push({ filePath, fileName: matches[0].file_name, matches });
    }
    return groups;
  });

  async function openResult(filePath: string, lineNumber: number) {
    // Check if already open
    const existing = tabsStore.findByPath(filePath);
    if (existing) {
      tabsStore.activateTab(existing.id);
    } else {
      const res = await commands.readFile(filePath);
      if (res.status === 'ok') {
        tabsStore.openTab(filePath, res.data);
        await commands.registerOpenFile(filePath);
      }
    }
    // We need a small delay to let the editor mount before jumping
    setTimeout(() => {
      // Dispatch a custom event that the Editor can pick up
      window.dispatchEvent(new CustomEvent('novelist-goto-line', { detail: { line: lineNumber } }));
    }, 100);
    onClose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function highlightMatch(text: string, start: number, end: number): string {
    const escaped = escapeHtml(text);
    let charOffset = 0;
    let escapedStart = 0;
    let escapedEnd = 0;
    for (let i = 0; i < text.length && (escapedStart === 0 || escapedEnd === 0); i++) {
      const char = text[i];
      const escapedChar = escapeHtml(char);
      if (i === start) escapedStart = charOffset;
      if (i === end) escapedEnd = charOffset;
      charOffset += escapedChar.length;
    }
    if (escapedEnd === 0) escapedEnd = charOffset;
    return `${escaped.substring(0, escapedStart)}<mark class="search-highlight">${escaped.substring(escapedStart, escapedEnd)}</mark>${escaped.substring(escapedEnd)}`;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  onMount(() => {
    inputEl?.focus();
    return () => clearTimeout(debounceTimer);
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="project-search-backdrop" role="presentation" onclick={onClose} onkeydown={handleKeydown}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="project-search-panel" onclick={(e) => e.stopPropagation()}>
    <div class="search-header">
      <span class="search-title">{t('search.title')}</span>
      <button class="search-close" onclick={onClose} title={t('search.close')}>&times;</button>
    </div>
    <div class="search-input-wrap">
      <input
        bind:this={inputEl}
        bind:value={query}
        onkeydown={handleKeydown}
        placeholder={t('search.placeholder')}
        class="search-input"
      />
    </div>
    <div class="search-results">
      {#if searching}
        <div class="search-status">{t('search.searching')}</div>
      {:else if query.trim() && results.length === 0}
        <div class="search-status">{t('search.noResults')}</div>
      {:else if results.length >= 200}
        <div class="search-status search-limit-notice">{t('search.showingFirst200')}</div>
      {/if}
      {#each groupedResults as group}
        <div class="result-group">
          <div class="result-file-name">{group.fileName}</div>
          {#each group.matches as match}
            <button
              class="result-item"
              onclick={() => openResult(match.file_path, match.line_number)}
            >
              <span class="result-line-number">{match.line_number}</span>
              <span class="result-line-text">{@html highlightMatch(match.line_text, match.match_start, match.match_end)}</span>
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .project-search-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    justify-content: center;
    padding-top: 60px;
    background: rgba(0, 0, 0, 0.3);
  }

  .project-search-panel {
    width: 560px;
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
    overflow: hidden;
  }

  .search-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: var(--novelist-text-secondary);
    border-bottom: 1px solid var(--novelist-border);
    flex-shrink: 0;
    user-select: none;
  }

  .search-close {
    background: none;
    border: none;
    color: var(--novelist-text-secondary);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .search-close:hover {
    color: var(--novelist-text);
  }

  .search-input-wrap {
    padding: 8px 12px;
    border-bottom: 1px solid var(--novelist-border);
    flex-shrink: 0;
  }

  .search-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 0.9rem;
    background: var(--novelist-bg-secondary, var(--novelist-bg));
    color: var(--novelist-text);
    border: 1px solid var(--novelist-border);
    border-radius: 4px;
    outline: none;
    font-family: inherit;
  }

  .search-input:focus {
    border-color: var(--novelist-accent, #4a9eff);
  }

  .search-results {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }

  .search-status {
    padding: 12px 16px;
    font-size: 0.8rem;
    color: var(--novelist-text-secondary);
    font-style: italic;
  }

  .search-limit-notice {
    font-style: normal;
    font-size: 0.72rem;
    padding: 4px 16px;
    opacity: 0.7;
  }

  .result-group {
    margin-bottom: 4px;
  }

  .result-file-name {
    padding: 6px 12px 2px;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--novelist-accent, #4a9eff);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }

  .result-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 3px 12px 3px 20px;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--novelist-text);
    transition: background 80ms ease;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .result-item:hover {
    background: var(--novelist-hover-bg, rgba(128, 128, 128, 0.12));
  }

  .result-line-number {
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--novelist-text-secondary);
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .result-line-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  :global(.search-highlight) {
    background: color-mix(in srgb, var(--novelist-accent, #4a9eff) 30%, transparent);
    color: inherit;
    border-radius: 2px;
    padding: 0 1px;
  }
</style>
