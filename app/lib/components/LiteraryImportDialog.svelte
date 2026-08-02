<script lang="ts">
  import { onMount } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import FileUp from '@lucide/svelte/icons/file-up';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Scissors from '@lucide/svelte/icons/scissors';
  import Merge from '@lucide/svelte/icons/merge';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { homeDir } from '@tauri-apps/api/path';
  import { commands } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  type SourceChapterDraft = {
    id: string;
    volume: string | null;
    title: string;
    text: string;
  };

  type ChapterDraft = Omit<SourceChapterDraft, 'volume'> & { volume: string };

  type Inspection = {
    title: string;
    author: string | null;
    language: string | null;
    sourcePath: string;
    chapters: SourceChapterDraft[];
  };

  interface Props {
    onClose: () => void;
    onProjectCreated: (projectPath: string, firstChapterPath: string) => void;
  }

  let { onClose, onProjectCreated }: Props = $props();

  let inspection = $state<Inspection | null>(null);
  let chapters = $state<ChapterDraft[]>([]);
  let selectedIndex = $state(0);
  let sourcePath = $state('');
  let title = $state('');
  let author = $state('');
  let language = $state('');
  let projectName = $state('');
  let parentDir = $state('');
  let inspecting = $state(false);
  let creating = $state(false);
  let error = $state('');
  let preview = $state<HTMLTextAreaElement | null>(null);

  let selectedChapter = $derived(chapters[selectedIndex] ?? null);
  let canCreate = $derived(
    inspection !== null
      && chapters.length > 0
      && chapters.every((chapter) => chapter.title.trim() && chapter.text.trim())
      && projectName.trim().length > 0
      && parentDir.trim().length > 0,
  );

  onMount(async () => {
    const home = await homeDir();
    parentDir = `${home.replace(/[\\/]$/, '')}/Documents`;
  });

  async function chooseSource() {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'EPUB / TXT', extensions: ['epub', 'txt'] }],
    });
    if (typeof selected !== 'string') return;
    sourcePath = selected;
    await inspectSource();
  }

  async function inspectSource() {
    if (!sourcePath) return;
    inspecting = true;
    error = '';
    const result = await commands.inspectLiterarySource(sourcePath);
    if (result.status === 'ok') {
      inspection = result.data;
      chapters = result.data.chapters.map((chapter) => ({
        ...chapter,
        volume: chapter.volume ?? '',
      }));
      selectedIndex = 0;
      title = result.data.title;
      author = result.data.author ?? '';
      language = result.data.language ?? '';
      projectName = result.data.title;
    } else {
      inspection = null;
      chapters = [];
      error = result.error;
    }
    inspecting = false;
  }

  async function chooseDestination() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: parentDir || undefined,
    });
    if (typeof selected === 'string') parentDir = selected;
  }

  function updateSelectedText(value: string) {
    if (!selectedChapter) return;
    chapters[selectedIndex].text = value;
  }

  function splitChapter() {
    const chapter = selectedChapter;
    const position = preview?.selectionStart ?? -1;
    if (!chapter || position <= 0 || position >= chapter.text.length) return;
    const before = chapter.text.slice(0, position).trimEnd();
    const after = chapter.text.slice(position).trimStart();
    if (!before || !after) return;
    chapter.text = before;
    chapters.splice(selectedIndex + 1, 0, {
      id: `${chapter.id}-split-${Date.now()}`,
      volume: chapter.volume,
      title: `${chapter.title}（下）`,
      text: after,
    });
    selectedIndex += 1;
  }

  function mergeWithNext() {
    if (!selectedChapter || selectedIndex >= chapters.length - 1) return;
    const next = chapters[selectedIndex + 1];
    selectedChapter.text = `${selectedChapter.text.trimEnd()}\n\n${next.text.trimStart()}`;
    chapters.splice(selectedIndex + 1, 1);
  }

  function removeChapter() {
    if (chapters.length <= 1) return;
    chapters.splice(selectedIndex, 1);
    selectedIndex = Math.min(selectedIndex, chapters.length - 1);
  }

  async function createProject() {
    if (!inspection || !canCreate) return;
    creating = true;
    error = '';
    const result = await commands.createLiteraryStudyProject({
      projectName: projectName.trim(),
      parentDir: parentDir.trim(),
      sourcePath: inspection.sourcePath,
      title: title.trim(),
      author: author.trim() || null,
      language: language.trim() || null,
      chapters: chapters.map((chapter, index) => ({
        ...chapter,
        id: chapter.id || `chapter-${String(index + 1).padStart(4, '0')}`,
        volume: chapter.volume.trim() || null,
        title: chapter.title.trim(),
        text: chapter.text.trim(),
      })),
    });
    if (result.status === 'ok') {
      onProjectCreated(result.data.projectPath, result.data.firstChapterPath);
      onClose();
    } else {
      error = result.error;
    }
    creating = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCreate) {
      event.preventDefault();
      void createProject();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" onclick={(event) => event.stopPropagation()}>
    <header>
      <h2>{t('literaryImport.title')}</h2>
      <button class="icon-button" title={t('newProject.cancel')} aria-label={t('newProject.cancel')} onclick={onClose}>
        <X size={16} />
      </button>
    </header>

    <div class="source-bar">
      <button class="command-button" onclick={chooseSource} disabled={inspecting}>
        <FileUp size={15} />
        <span>{inspecting ? t('literaryImport.inspecting') : t('literaryImport.chooseSource')}</span>
      </button>
      <div class="source-path" title={sourcePath}>{sourcePath || t('literaryImport.noSource')}</div>
    </div>

    {#if inspection}
      <div class="metadata">
        <label>
          <span>{t('literaryImport.bookTitle')}</span>
          <input bind:value={title} />
        </label>
        <label>
          <span>{t('literaryImport.author')}</span>
          <input bind:value={author} />
        </label>
        <label>
          <span>{t('literaryImport.projectName')}</span>
          <input bind:value={projectName} />
        </label>
        <label class="destination">
          <span>{t('newProject.location')}</span>
          <div>
            <input bind:value={parentDir} />
            <button class="icon-button bordered" title={t('newProject.browse')} aria-label={t('newProject.browse')} onclick={chooseDestination}>
              <FolderOpen size={15} />
            </button>
          </div>
        </label>
      </div>

      <main>
        <aside>
          <div class="chapter-count">{t('literaryImport.chapterCount', { count: chapters.length })}</div>
          <div class="chapter-list">
            {#each chapters as chapter, index (chapter.id)}
              <button
                class:active={index === selectedIndex}
                onclick={() => selectedIndex = index}
                title={chapter.title}
              >
                <span>{String(index + 1).padStart(3, '0')}</span>
                <strong>{chapter.title}</strong>
              </button>
            {/each}
          </div>
        </aside>

        <section class="chapter-editor">
          {#if selectedChapter}
            <div class="chapter-fields">
              <input class="title-input" bind:value={selectedChapter.title} aria-label={t('literaryImport.chapterTitle')} />
              <input class="volume-input" bind:value={selectedChapter.volume} placeholder={t('literaryImport.volume')} aria-label={t('literaryImport.volume')} />
              <button class="icon-button bordered" title={t('literaryImport.split')} aria-label={t('literaryImport.split')} onclick={splitChapter}>
                <Scissors size={15} />
              </button>
              <button class="icon-button bordered" title={t('literaryImport.mergeNext')} aria-label={t('literaryImport.mergeNext')} disabled={selectedIndex >= chapters.length - 1} onclick={mergeWithNext}>
                <Merge size={15} />
              </button>
              <button class="icon-button bordered danger" title={t('literaryImport.remove')} aria-label={t('literaryImport.remove')} disabled={chapters.length <= 1} onclick={removeChapter}>
                <Trash2 size={15} />
              </button>
            </div>
            <textarea
              bind:this={preview}
              value={selectedChapter.text}
              oninput={(event) => updateSelectedText(event.currentTarget.value)}
              spellcheck="false"
              aria-label={t('literaryImport.preview')}
            ></textarea>
          {/if}
        </section>
      </main>
    {:else}
      <div class="empty-state">
        <FileUp size={28} strokeWidth={1.4} />
        <span>{t('literaryImport.empty')}</span>
      </div>
    {/if}

    <footer>
      <div class="error" role="alert">{error}</div>
      <div class="actions">
        <button class="secondary-button" onclick={onClose}>{t('newProject.cancel')}</button>
        <button class="primary-button" disabled={!canCreate || creating} onclick={createProject}>
          {creating ? t('newProject.creating') : t('newProject.create')}
        </button>
      </div>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.42);
  }
  .dialog {
    width: min(1080px, 96vw);
    height: min(760px, 92vh);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--novelist-text);
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.24);
  }
  header, .source-bar, footer {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--novelist-border);
  }
  header {
    justify-content: space-between;
  }
  header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 650;
  }
  .icon-button {
    width: 30px;
    height: 30px;
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
  .icon-button.bordered {
    border: 1px solid var(--novelist-border);
  }
  .icon-button.danger {
    color: var(--novelist-error, #c24146);
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .source-bar {
    gap: 12px;
    background: var(--novelist-bg-secondary);
  }
  .command-button, .primary-button, .secondary-button {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 0 13px;
    border-radius: 5px;
    font-size: 0.82rem;
    font-weight: 550;
    cursor: pointer;
  }
  .command-button, .secondary-button {
    color: var(--novelist-text);
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
  }
  .primary-button {
    color: white;
    background: var(--novelist-accent);
    border: 1px solid var(--novelist-accent);
  }
  .source-path {
    min-width: 0;
    overflow: hidden;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metadata {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(120px, 0.7fr) minmax(160px, 1fr) minmax(260px, 1.5fr);
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--novelist-border);
  }
  .metadata label {
    min-width: 0;
  }
  .metadata label > span {
    display: block;
    margin-bottom: 5px;
    color: var(--novelist-text-secondary);
    font-size: 0.7rem;
  }
  .metadata input, .chapter-fields input {
    width: 100%;
    min-width: 0;
    height: 32px;
    box-sizing: border-box;
    padding: 0 9px;
    color: var(--novelist-text);
    background: var(--novelist-bg-secondary);
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    outline: none;
  }
  .metadata input:focus, .chapter-fields input:focus, textarea:focus {
    border-color: var(--novelist-accent);
  }
  .destination > div {
    display: flex;
    gap: 6px;
  }
  main {
    min-height: 0;
    flex: 1;
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
  }
  aside {
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--novelist-border);
    background: var(--novelist-bg-secondary);
  }
  .chapter-count {
    padding: 10px 12px 7px;
    color: var(--novelist-text-secondary);
    font-size: 0.72rem;
  }
  .chapter-list {
    min-height: 0;
    overflow-y: auto;
    padding: 0 6px 8px;
  }
  .chapter-list button {
    width: 100%;
    height: 34px;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    align-items: center;
    padding: 0 7px;
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
  .chapter-list button.active {
    color: var(--novelist-accent);
    background: var(--novelist-sidebar-active);
  }
  .chapter-list span {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.66rem;
    font-variant-numeric: tabular-nums;
  }
  .chapter-list strong {
    overflow: hidden;
    font-size: 0.78rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chapter-editor {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 12px;
  }
  .chapter-fields {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(120px, 0.45fr) 30px 30px 30px;
    gap: 7px;
    margin-bottom: 9px;
  }
  textarea {
    min-width: 0;
    min-height: 0;
    flex: 1;
    resize: none;
    box-sizing: border-box;
    padding: 18px 22px;
    color: var(--novelist-text);
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    outline: none;
    font-family: var(--novelist-editor-font, "Noto Serif SC", serif);
    font-size: 15px;
    line-height: 1.9;
  }
  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.82rem;
  }
  footer {
    justify-content: space-between;
    gap: 16px;
    border-top: 1px solid var(--novelist-border);
    border-bottom: 0;
  }
  .error {
    min-width: 0;
    color: var(--novelist-error, #c24146);
    font-size: 0.76rem;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  @media (max-width: 800px) {
    .backdrop { padding: 8px; }
    .dialog { width: 100%; height: 100%; }
    .metadata { grid-template-columns: 1fr 1fr; }
    main { grid-template-columns: 190px minmax(0, 1fr); }
  }
</style>
