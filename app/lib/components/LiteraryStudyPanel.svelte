<script lang="ts">
  import { onMount } from 'svelte';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import FileUp from '@lucide/svelte/icons/file-up';
  import Play from '@lucide/svelte/icons/play';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import { commands, type LiteraryStudyOverview } from '$lib/ipc/commands';
  import { i18n, t } from '$lib/i18n';
  import { projectStore } from '$lib/stores/project.svelte';

  let {
    onOpenChapter,
    onReplaceBook,
  }: {
    onOpenChapter: (relativePath: string) => void;
    onReplaceBook: () => void;
  } = $props();

  let overview = $state<LiteraryStudyOverview | null>(null);
  let loading = $state(false);
  let error = $state('');
  let search = $state('');
  let requestVersion = 0;

  const filteredChapters = $derived.by(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query || !overview) return overview?.chapters ?? [];
    return overview.chapters.filter((chapter) =>
      `${chapter.volume ?? ''} ${chapter.title}`.toLocaleLowerCase().includes(query),
    );
  });
  const progress = $derived(
    overview && overview.totalCharacters > 0
      ? Math.min(100, (overview.copiedCharacters / overview.totalCharacters) * 100)
      : 0,
  );

  $effect(() => {
    const dir = projectStore.dirPath;
    projectStore.generation;
    if (!dir) {
      overview = null;
      return;
    }
    void loadOverview(dir);
  });

  onMount(() => {
    let timer: number | null = null;
    const handleSaved = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (projectStore.dirPath) void loadOverview(projectStore.dirPath);
      }, 250);
    };
    window.addEventListener('novelist:literary-study-saved', handleSaved);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener('novelist:literary-study-saved', handleSaved);
    };
  });

  async function loadOverview(projectDir: string) {
    const version = ++requestVersion;
    loading = true;
    error = '';
    const result = await commands.readLiteraryStudyOverview(projectDir);
    if (version !== requestVersion || projectStore.dirPath !== projectDir) return;
    if (result.status === 'ok') {
      overview = result.data;
    } else {
      overview = null;
      error = result.error;
    }
    loading = false;
  }

  function formatNumber(value: number): string {
    return new Intl.NumberFormat(i18n.locale).format(value);
  }
</script>

<div class="panel" data-testid="literary-study-panel">
  <header>
    <div class="heading">
      <BookOpen size={17} strokeWidth={1.7} />
      <div>
        <h2>{overview?.title ?? t('literaryPanel.title')}</h2>
        {#if overview?.author}<p>{overview.author}</p>{/if}
      </div>
    </div>
    <button
      class="icon-button"
      data-testid="literary-refresh"
      title={t('literaryPanel.refresh')}
      aria-label={t('literaryPanel.refresh')}
      disabled={loading || !projectStore.dirPath}
      onclick={() => projectStore.dirPath && loadOverview(projectStore.dirPath)}
    >
      <RefreshCw size={15} class={loading ? 'spinning' : ''} />
    </button>
  </header>

  {#if overview}
    <section class="progress-section">
      <div class="progress-label">
        <strong>{Math.round(progress)}%</strong>
        <span>{t('literaryPanel.completedChapters', {
          completed: overview.completedChapters,
          total: overview.chapterCount,
        })}</span>
      </div>
      <div class="progress-track" aria-label={t('literaryPanel.progress')}>
        <div style:width={`${progress}%`}></div>
      </div>
      <div class="stats">
        <div><strong>{formatNumber(overview.copiedCharacters)}</strong><span>{t('literaryPanel.copied')}</span></div>
        <div><strong>{formatNumber(overview.mistakes)}</strong><span>{t('literaryPanel.mistakes')}</span></div>
        <div><strong>{formatNumber(overview.pasted)}</strong><span>{t('literaryPanel.pasted')}</span></div>
      </div>
    </section>

    <section class="commands">
      <button
        class="primary-command"
        data-testid="literary-resume"
        disabled={!overview.resumeChapterPath && overview.chapters.length === 0}
        onclick={() => onOpenChapter(overview?.resumeChapterPath ?? overview?.chapters[0]?.relativePath ?? '')}
      >
        {#if overview.completedChapters === overview.chapterCount}
          <CircleCheck size={15} />
          <span>{t('literaryPanel.review')}</span>
        {:else}
          <Play size={15} />
          <span>{t('literaryPanel.resume')}</span>
        {/if}
      </button>
      <button class="secondary-command" data-testid="literary-replace-book" onclick={onReplaceBook}>
        <FileUp size={15} />
        <span>{t('literaryPanel.replaceBook')}</span>
      </button>
    </section>

    <section class="chapters">
      <div class="chapter-toolbar">
        <label>
          <Search size={14} />
          <input
            bind:value={search}
            placeholder={t('literaryPanel.search')}
            aria-label={t('literaryPanel.search')}
          />
        </label>
        <span>{filteredChapters.length}</span>
      </div>
      <div class="chapter-list">
        {#each filteredChapters as chapter (chapter.relativePath)}
          <button
            class:completed={chapter.completed}
            title={chapter.volume ? `${chapter.volume} / ${chapter.title}` : chapter.title}
            onclick={() => onOpenChapter(chapter.relativePath)}
          >
            <span class="chapter-index">{String(chapter.index).padStart(3, '0')}</span>
            <span class="chapter-copy">
              <strong>{chapter.title}</strong>
              <small>
                {#if chapter.volume}{chapter.volume} · {/if}
                {chapter.sourceCharacters > 0
                  ? `${Math.round((chapter.copiedCharacters / chapter.sourceCharacters) * 100)}%`
                  : '0%'}
              </small>
            </span>
            {#if chapter.completed}<CircleCheck size={14} />{/if}
          </button>
        {/each}
      </div>
    </section>
  {:else if error}
    <div class="state" role="alert">
      <p>{error}</p>
      <button class="secondary-command" onclick={onReplaceBook}>
        <FileUp size={15} />
        <span>{t('literaryPanel.importBook')}</span>
      </button>
    </div>
  {:else}
    <div class="state">{t('literaryPanel.loading')}</div>
  {/if}
</div>

<style>
  .panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--novelist-text);
    background: var(--novelist-bg);
  }
  header {
    min-height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 11px;
    border-bottom: 1px solid var(--novelist-border);
  }
  .heading {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--novelist-accent);
  }
  .heading > div {
    min-width: 0;
  }
  h2, p {
    margin: 0;
  }
  h2 {
    overflow: hidden;
    color: var(--novelist-text);
    font-size: 0.82rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  p {
    margin-top: 2px;
    overflow: hidden;
    color: var(--novelist-text-secondary);
    font-size: 0.66rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button {
    font: inherit;
  }
  .icon-button {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0;
    color: var(--novelist-text-secondary);
    background: transparent;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
  }
  .icon-button:hover:not(:disabled) {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
  }
  .icon-button:disabled {
    opacity: 0.4;
  }
  :global(.spinning) {
    animation: spin 0.8s linear infinite;
  }
  section {
    border-bottom: 1px solid var(--novelist-border);
  }
  .progress-section {
    padding: 12px 11px;
  }
  .progress-label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .progress-label strong {
    font-size: 1rem;
    font-variant-numeric: tabular-nums;
  }
  .progress-label span {
    color: var(--novelist-text-secondary);
    font-size: 0.66rem;
  }
  .progress-track {
    height: 4px;
    margin-top: 8px;
    overflow: hidden;
    background: var(--novelist-bg-secondary);
    border-radius: 2px;
  }
  .progress-track div {
    height: 100%;
    background: var(--novelist-accent);
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: 11px;
  }
  .stats div {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stats strong {
    overflow: hidden;
    font-size: 0.76rem;
    font-weight: 600;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  .stats span {
    color: var(--novelist-text-secondary);
    font-size: 0.62rem;
  }
  .commands {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
    padding: 9px 11px;
  }
  .primary-command, .secondary-command {
    min-width: 0;
    min-height: 31px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 9px;
    border-radius: 5px;
    font-size: 0.69rem;
    font-weight: 550;
    cursor: pointer;
  }
  .primary-command {
    color: white;
    background: var(--novelist-accent);
    border: 1px solid var(--novelist-accent);
  }
  .secondary-command {
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
  }
  .primary-command:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .chapters {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    border-bottom: 0;
  }
  .chapter-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 9px;
    border-bottom: 1px solid var(--novelist-border);
  }
  .chapter-toolbar label {
    min-width: 0;
    height: 28px;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    color: var(--novelist-text-secondary);
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
  }
  .chapter-toolbar input {
    min-width: 0;
    width: 100%;
    padding: 0;
    color: var(--novelist-text);
    background: transparent;
    border: 0;
    outline: 0;
    font-size: 0.69rem;
  }
  .chapter-toolbar > span {
    min-width: 24px;
    color: var(--novelist-text-secondary);
    font-size: 0.63rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .chapter-list {
    min-height: 0;
    overflow-y: auto;
    padding: 4px;
  }
  .chapter-list button {
    width: 100%;
    min-height: 39px;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 16px;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    color: var(--novelist-text);
    background: transparent;
    border: 0;
    border-radius: 4px;
    text-align: left;
    cursor: pointer;
  }
  .chapter-list button:hover {
    background: var(--novelist-sidebar-hover);
  }
  .chapter-list button.completed {
    color: var(--novelist-text-secondary);
  }
  .chapter-list button > :global(svg) {
    color: var(--novelist-accent);
  }
  .chapter-index {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.61rem;
    font-variant-numeric: tabular-nums;
  }
  .chapter-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .chapter-copy strong, .chapter-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chapter-copy strong {
    font-size: 0.7rem;
    font-weight: 500;
  }
  .chapter-copy small {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.59rem;
  }
  .state {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 20px;
    color: var(--novelist-text-secondary);
    font-size: 0.72rem;
    text-align: center;
  }
  .state p {
    white-space: normal;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
