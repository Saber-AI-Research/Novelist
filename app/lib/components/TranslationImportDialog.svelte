<script lang="ts">
  import { onMount } from 'svelte';
  import X from '@lucide/svelte/icons/x';
  import FileUp from '@lucide/svelte/icons/file-up';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import { open as openDialog } from '@tauri-apps/plugin-dialog';
  import { homeDir } from '@tauri-apps/api/path';
  import {
    commands,
    type CreateBookTranslationProjectRequest,
    type LiteraryChapterDraft,
    type LiterarySourceInspection,
  } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';
  import {
    TRANSLATION_LANGUAGE_OPTIONS,
    isKnownTranslationLanguageCode,
    isValidTranslationLanguageCode,
  } from '$lib/utils/translation-languages';
  import { sanitizeFilenameStem } from '$lib/utils/filename';
  import { isImeComposing } from '$lib/utils/ime';

  interface Props {
    onClose: () => void;
    onProjectCreated?: (projectPath: string, firstChapterPath: string) => void | Promise<void>;
  }

  let { onClose, onProjectCreated }: Props = $props();

  let inspection = $state<LiterarySourceInspection | null>(null);
  let chapters = $state<LiteraryChapterDraft[]>([]);
  let sourcePath = $state('');
  let title = $state('');
  let author = $state('');
  let projectName = $state('');
  let parentDir = $state('');
  let sourceLanguage = $state('');
  let sourceLanguageOther = $state('');
  let targetLanguage = $state('zh-CN');
  let targetLanguageOther = $state('');
  let inspecting = $state(false);
  let creating = $state(false);
  let error = $state('');

  const OTHER_LANGUAGE = '__other__';

  let resolvedSourceLanguage = $derived(
    sourceLanguage === OTHER_LANGUAGE ? sourceLanguageOther.trim() : sourceLanguage.trim(),
  );
  let resolvedTargetLanguage = $derived(
    targetLanguage === OTHER_LANGUAGE ? targetLanguageOther.trim() : targetLanguage.trim(),
  );
  // Mirrors the backend's project-name rule: one path component, no separators.
  let projectNameValid = $derived(
    projectName.trim().length > 0
      && !/[\\/\0]/.test(projectName)
      && projectName.trim() !== '.'
      && projectName.trim() !== '..',
  );
  let canSubmit = $derived(
    !!inspection
      && !inspecting
      && !creating
      && !!sourcePath
      && title.trim().length > 0
      && chapters.length > 0
      && chapters.every((chapter) => chapter.title.trim().length > 0 && chapter.text.trim().length > 0)
      && projectNameValid
      && parentDir.trim().length > 0
      && isValidTranslationLanguageCode(resolvedSourceLanguage, true)
      && isValidTranslationLanguageCode(resolvedTargetLanguage),
  );

  onMount(async () => {
    try {
      const home = await homeDir();
      parentDir = `${home.replace(/[\\/]$/, '')}/Documents`;
    } catch {
      parentDir = '';
    }
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
    const requestedPath = sourcePath;
    inspecting = true;
    error = '';
    // The previous book's chapters must never be importable under the new path.
    inspection = null;
    chapters = [];
    let result: Awaited<ReturnType<typeof commands.inspectLiterarySource>>;
    try {
      result = await commands.inspectLiterarySource(requestedPath);
    } catch (cause) {
      if (sourcePath === requestedPath) {
        error = cause instanceof Error ? cause.message : String(cause);
        inspecting = false;
      }
      return;
    }
    if (sourcePath !== requestedPath) return;
    inspecting = false;
    if (result.status !== 'ok') {
      error = result.error;
      return;
    }

    inspection = result.data;
    chapters = result.data.chapters.map((chapter) => ({
      id: chapter.id,
      volume: chapter.volume,
      title: chapter.title,
      text: chapter.text,
    }));
    title = result.data.title;
    author = result.data.author ?? '';
    // Book titles such as "Fate/Zero" are not valid folder names as-is.
    projectName = sanitizeFilenameStem(result.data.title);
    sourceLanguage = '';
    sourceLanguageOther = '';
    if (result.data.language && isValidTranslationLanguageCode(result.data.language)) {
      if (isKnownTranslationLanguageCode(result.data.language)) {
        sourceLanguage = result.data.language;
      } else {
        sourceLanguage = OTHER_LANGUAGE;
        sourceLanguageOther = result.data.language;
      }
    }
  }

  async function chooseDestination() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: parentDir || undefined,
    });
    if (typeof selected === 'string') parentDir = selected;
  }

  async function submitImport() {
    if (!canSubmit || !inspection) return;
    creating = true;
    error = '';
    const request: CreateBookTranslationProjectRequest = {
      projectName: projectName.trim(),
      parentDir: parentDir.trim(),
      sourcePath: inspection.sourcePath,
      title: title.trim(),
      author: author.trim() || null,
      sourceLanguage: resolvedSourceLanguage || null,
      targetLanguage: resolvedTargetLanguage,
      chapters: chapters.map((chapter, index) => ({
        id: chapter.id || `chapter-${String(index + 1).padStart(4, '0')}`,
        volume: chapter.volume?.trim() || null,
        title: chapter.title.trim(),
        text: chapter.text.trim(),
      })),
    };

    let result: Awaited<ReturnType<typeof commands.createBookTranslationProject>>;
    try {
      result = await commands.createBookTranslationProject(request);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      creating = false;
      return;
    }
    if (result.status === 'ok') {
      try {
        await onProjectCreated?.(result.data.projectPath, result.data.firstChapterPath);
        onClose();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
    } else {
      error = result.error;
    }
    creating = false;
  }

  /** Closing mid-import would still switch projects once the import lands. */
  function requestClose() {
    if (!creating) onClose();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (isImeComposing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSubmit) {
      event.preventDefault();
      void submitImport();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={requestClose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog" data-testid="translation-import-dialog" onclick={(event) => event.stopPropagation()}>
    <header>
      <h2>{t('translationImport.title')}</h2>
      <button class="icon-button" title={t('newProject.cancel')} aria-label={t('newProject.cancel')} onclick={requestClose} disabled={creating}>
        <X size={16} />
      </button>
    </header>

    <div class="source-bar">
      <button class="command-button" data-testid="translation-import-source" onclick={chooseSource} disabled={inspecting || creating}>
        <FileUp size={14} />
        {inspecting ? t('translationImport.inspecting') : t('translationImport.chooseSource')}
      </button>
      <div class="source-path" title={sourcePath}>{sourcePath || t('translationImport.noSource')}</div>
    </div>

    {#if inspection}
      <main data-testid="translation-import-preview">
        <div class="metadata">
          <label>
            <span>{t('translationImport.bookTitle')}</span>
            <input bind:value={title} data-testid="translation-import-title" />
          </label>
          <label>
            <span>{t('translationImport.author')}</span>
            <input bind:value={author} data-testid="translation-import-author" />
          </label>
          <div class="chapter-count">{t('translationImport.chapterCount', { count: chapters.length })}</div>
        </div>

        <div class="import-options">
          <label>
            <span>{t('translationImport.sourceLanguage')}</span>
            <select bind:value={sourceLanguage} data-testid="translation-import-source-language">
              <option value="">{t('translationImport.autoDetect')}</option>
              {#each TRANSLATION_LANGUAGE_OPTIONS as option}
                <option value={option.code}>{option.label}</option>
              {/each}
              <option value={OTHER_LANGUAGE}>{t('translationImport.other')}</option>
            </select>
          </label>
          {#if sourceLanguage === OTHER_LANGUAGE}
            <input
              class="language-other"
              bind:value={sourceLanguageOther}
              placeholder={t('translationImport.languageCodePlaceholder')}
              aria-label={t('translationImport.sourceLanguage')}
              data-testid="translation-import-source-language-other"
            />
          {/if}
          <label>
            <span>{t('translationImport.targetLanguage')}</span>
            <select bind:value={targetLanguage} data-testid="translation-import-target-language">
              {#each TRANSLATION_LANGUAGE_OPTIONS as option}
                <option value={option.code}>{option.label}</option>
              {/each}
              <option value={OTHER_LANGUAGE}>{t('translationImport.other')}</option>
            </select>
          </label>
          {#if targetLanguage === OTHER_LANGUAGE}
            <input
              class="language-other"
              bind:value={targetLanguageOther}
              placeholder={t('translationImport.languageCodePlaceholder')}
              aria-label={t('translationImport.targetLanguage')}
              data-testid="translation-import-target-language-other"
            />
          {/if}
        </div>

        <div class="project-options">
          <label>
            <span>{t('translationImport.projectName')}</span>
            <input bind:value={projectName} data-testid="translation-import-project-name" />
          </label>
          <label>
            <span>{t('translationImport.destination')}</span>
            <div class="destination-field">
              <input bind:value={parentDir} data-testid="translation-import-parent-dir" />
              <button type="button" onclick={chooseDestination} title={t('newProject.browse')}>
                <FolderOpen size={14} />
              </button>
            </div>
          </label>
        </div>

        {#if chapters[0]}
          <section class="preview">
            <h3>{t('translationImport.preview')}</h3>
            <div class="preview-title">{chapters[0].title}</div>
            <p>{chapters[0].text.slice(0, 800)}{chapters[0].text.length > 800 ? '…' : ''}</p>
          </section>
        {/if}
      </main>
    {:else}
      <div class="empty-state">{t('translationImport.empty')}</div>
    {/if}

    {#if error}
      <div class="error" role="alert" data-testid="translation-import-error">{error}</div>
    {/if}

    <footer>
      <button class="cancel-button" onclick={requestClose} disabled={creating}>{t('newProject.cancel')}</button>
      <button
        class="submit-button"
        data-testid="translation-import-submit"
        onclick={() => void submitImport()}
        disabled={creating || !canSubmit}
      >
        {creating ? t('translationImport.creating') : t('translationImport.create')}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(0, 0, 0, 0.4);
  }
  .dialog {
    width: min(760px, 100%);
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--novelist-border);
    border-radius: 10px;
    background: var(--novelist-bg);
    color: var(--novelist-text);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
  }
  header,
  footer,
  .source-bar,
  .metadata,
  .import-options,
  .project-options {
    display: flex;
    align-items: center;
  }
  header {
    justify-content: space-between;
    padding: 14px 18px 10px;
    border-bottom: 1px solid var(--novelist-border);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .icon-button,
  .destination-field button {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
  }
  .icon-button {
    width: 24px;
    height: 24px;
  }
  .source-bar {
    gap: 10px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--novelist-border);
  }
  .command-button,
  .cancel-button,
  .submit-button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
    padding: 5px 12px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .command-button,
  .cancel-button {
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
  }
  .submit-button {
    border-color: var(--novelist-accent);
    background: var(--novelist-accent);
    color: #fff;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .source-path {
    min-width: 0;
    overflow: hidden;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  main {
    min-height: 0;
    overflow-y: auto;
    padding: 14px 18px;
  }
  .metadata,
  .import-options,
  .project-options {
    gap: 10px;
    align-items: end;
  }
  .metadata {
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  label {
    display: flex;
    flex: 1;
    min-width: 160px;
    flex-direction: column;
    gap: 4px;
    font-size: 0.75rem;
    color: var(--novelist-text-secondary);
  }
  input,
  select {
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    font: inherit;
    font-size: 0.8rem;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--novelist-accent);
  }
  .chapter-count {
    padding-bottom: 7px;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    white-space: nowrap;
  }
  .import-options,
  .project-options {
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .language-other {
    align-self: end;
    width: 115px;
  }
  .destination-field {
    display: flex;
    gap: 5px;
  }
  .destination-field input {
    width: 100%;
  }
  .destination-field button {
    width: 30px;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
  }
  .preview {
    margin-top: 14px;
    padding: 10px 12px;
    border: 1px solid var(--novelist-border);
    border-radius: 6px;
    background: var(--novelist-bg-secondary);
  }
  h3 {
    margin: 0 0 5px;
    font-size: 0.78rem;
  }
  .preview-title {
    margin-bottom: 5px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .preview p {
    max-height: 150px;
    margin: 0;
    overflow: hidden;
    color: var(--novelist-text-secondary);
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .empty-state {
    min-height: 220px;
    display: grid;
    place-items: center;
    padding: 24px;
    color: var(--novelist-text-secondary);
    font-size: 0.85rem;
  }
  .error {
    margin: 0 18px 10px;
    color: #e5484d;
    font-size: 0.78rem;
  }
  footer {
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px 16px;
    border-top: 1px solid var(--novelist-border);
  }
</style>
