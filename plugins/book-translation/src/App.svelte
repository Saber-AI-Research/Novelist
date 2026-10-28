<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { connectToHost, type HostMessage } from '../../host-channel';
  import {
    parseBookTranslationFile,
    serializeBookTranslationFile,
    updateSegmentReference,
    updateSegmentTranslation,
    type BookTranslationFile,
    type TranslationReferenceProvider,
  } from './model';

  type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

  let file = $state<BookTranslationFile | null>(null);
  let rawContent = $state('');
  let filePath = $state('');
  let documentId = $state('');
  let revision = $state(0);
  let locale = $state<'en' | 'zh-CN'>('zh-CN');
  let error = $state('');
  let saveState = $state<SaveState>('idle');
  let saveError = $state('');
  // At most one debounced save exists: a new `file-open` flushes it with the
  // token it was scheduled for, so the host decides whether it still applies.
  let pendingSave: { timer: number; documentId: string; revision: number; content: string } | null = null;
  let pendingReferences = $state<Record<string, boolean>>({});
  let pendingReferenceRequests = $state<Record<string, string>>({});
  let referenceErrors = $state<Record<string, string>>({});
  // While an IME composes in a translation box its pre-edit text is not
  // published, and a sibling `file-sync` waits until the composition ends.
  let composing = false;
  let deferredSync: Record<string, unknown> | null = null;

  const messages = {
    en: {
      myTranslation: 'My translation',
      originalReferences: 'Original / References',
      original: 'Original',
      google: 'Google',
      llm: 'AI Talk',
      request: 'Request',
      refresh: 'Refresh',
      previous: 'Previous chapter',
      next: 'Next chapter',
      saved: 'Saved',
      saving: 'Saving',
      unsaved: 'Unsaved',
      saveFailed: 'Save failed',
      opening: 'Opening translation chapter...',
      retry: 'Try again',
      referenceFailed: 'Reference request failed',
      segment: 'Translation',
      languageAuto: 'Auto detect',
    },
    'zh-CN': {
      myTranslation: '我的译文',
      originalReferences: '原文 / 参考译文',
      original: '原文',
      google: 'Google',
      llm: '当前 AI Talk 模型',
      request: '获取参考',
      refresh: '刷新',
      previous: '上一章',
      next: '下一章',
      saved: '已保存',
      saving: '保存中',
      unsaved: '未保存',
      saveFailed: '保存失败',
      opening: '正在打开翻译章节...',
      retry: '重试',
      referenceFailed: '参考译文请求失败',
      segment: '译文',
      languageAuto: '自动识别',
    },
  } as const;

  function text(key: keyof typeof messages.en): string {
    return messages[locale][key];
  }

  function setLocale(value: unknown) {
    locale = value === 'en' ? 'en' : 'zh-CN';
    document.documentElement.lang = locale;
  }

  function applyTheme(theme: Record<string, string>) {
    for (const [name, value] of Object.entries(theme)) {
      if (value) document.documentElement.style.setProperty(name, value);
    }
  }

  // Connected during the synchronous mount in main.ts, before the iframe's load
  // event delivers the host's MessagePort. Posts before then are queued.
  const host = connectToHost(handleMessage);

  // The host waits for this handshake before sending the initial document.
  // `file-sync` tells it sibling-pane edits can be applied in place.
  onMount(() => host.post({ type: 'plugin-ready', capabilities: ['file-sync'] }));

  function cancelPendingSave() {
    if (pendingSave) window.clearTimeout(pendingSave.timer);
    pendingSave = null;
  }

  function postSave(content: string, targetDocumentId: string, targetRevision: number) {
    saveState = 'saving';
    host.post({
      type: 'file-save',
      documentId: targetDocumentId,
      revision: targetRevision,
      content,
    });
  }

  function flushPendingSave() {
    const pending = pendingSave;
    if (!pending) return;
    cancelPendingSave();
    postSave(pending.content, pending.documentId, pending.revision);
  }

  function publishState(saveImmediately = false) {
    if (!file || !documentId) return;
    const content = serializeBookTranslationFile(file);
    const targetDocumentId = documentId;
    const targetRevision = revision;
    host.post({
      type: 'file-state',
      documentId: targetDocumentId,
      revision: targetRevision,
      content,
    });
    saveState = 'dirty';
    saveError = '';
    cancelPendingSave();
    if (saveImmediately) {
      postSave(content, targetDocumentId, targetRevision);
      return;
    }
    const timer = window.setTimeout(() => {
      pendingSave = null;
      // The closure captures the exact state advertised to the host. A later
      // edit has its own timer and save result token.
      postSave(content, targetDocumentId, targetRevision);
    }, 700);
    pendingSave = { timer, documentId: targetDocumentId, revision: targetRevision, content };
  }

  /** Every local edit is a new revision, so stale save results never claim it. */
  function commitLocalChange(next: BookTranslationFile) {
    file = next;
    revision += 1;
    publishState();
  }

  function editTranslation(segmentId: string, translation: string) {
    if (!file) return;
    const segment = file.segments.find((candidate) => candidate.id === segmentId);
    if (!segment || segment.translation === translation) return;
    commitLocalChange(updateSegmentTranslation(file, segmentId, translation));
  }

  /** Apply a sibling edit that was held back while the IME composed. */
  function finishComposition() {
    composing = false;
    const sync = deferredSync;
    deferredSync = null;
    if (sync) applyFileSync(sync);
  }

  function handleTranslationInput(
    event: Event & { currentTarget: HTMLTextAreaElement },
    segmentId: string,
  ) {
    if (event instanceof InputEvent && event.isComposing) return;
    // WebKit may deliver the commit as a plain input after compositionend.
    if (composing) finishComposition();
    editTranslation(segmentId, event.currentTarget.value);
  }

  function handleCompositionEnd(
    event: CompositionEvent & { currentTarget: HTMLTextAreaElement },
    segmentId: string,
  ) {
    // A sibling edit that arrived mid-composition lands first; the committed
    // text is then published on top of it under the new token.
    finishComposition();
    editTranslation(segmentId, event.currentTarget.value);
  }

  function referenceKey(segmentId: string, provider: TranslationReferenceProvider): string {
    return `${segmentId}:${provider}`;
  }

  function nextRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function requestReference(segmentId: string, provider: TranslationReferenceProvider) {
    if (!file || !documentId) return;
    const segment = file.segments.find((candidate) => candidate.id === segmentId);
    if (!segment) return;
    const key = referenceKey(segmentId, provider);
    if (pendingReferences[key]) return;
    const requestId = nextRequestId();
    pendingReferences = { ...pendingReferences, [key]: true };
    pendingReferenceRequests = { ...pendingReferenceRequests, [key]: requestId };
    const nextErrors = { ...referenceErrors };
    delete nextErrors[key];
    referenceErrors = nextErrors;
    host.post({
      type: 'translation-reference-request',
      requestId,
      documentId,
      segmentId,
      provider,
      source: segment.source,
      sourceLanguage: file.book.sourceLanguage,
      targetLanguage: file.book.targetLanguage,
    });
  }

  function openRelative(relativePath: string | null) {
    if (!relativePath) return;
    const normalized = relativePath.replace(/\\/g, '/');
    if (
      !normalized
      || normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || normalized.split('/').some((part) => part === '..')
    ) return;
    // Only local edits not yet saved are written before leaving; an untouched
    // chapter must not be rewritten (or marked dirty) by navigation.
    if (saveState === 'dirty' || saveState === 'error') publishState(true);
    host.post({ type: 'open-project-file', documentId, relativePath: normalized });
  }

  function parseContent(content: string) {
    try {
      file = parseBookTranslationFile(content);
      error = '';
      saveError = '';
      saveState = 'idle';
    } catch (cause) {
      file = null;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function retryParse() {
    if (rawContent) parseContent(rawContent);
  }

  function handleSaveResult(data: Record<string, unknown>) {
    if (data.documentId !== documentId || data.revision !== revision) return;
    if (data.ok !== true) {
      saveState = 'error';
      saveError = typeof data.error === 'string' ? data.error : text('saveFailed');
    } else if (data.saved === true) {
      saveState = 'saved';
      saveError = '';
    } else {
      saveState = 'dirty';
    }
  }

  function handleReferenceResult(data: Record<string, unknown>) {
    if (
      data.documentId !== documentId
      || typeof data.requestId !== 'string'
      || typeof data.segmentId !== 'string'
      || (data.provider !== 'google' && data.provider !== 'llm')
    ) return;
    const provider = data.provider as TranslationReferenceProvider;
    const key = referenceKey(data.segmentId, provider);
    if (!pendingReferences[key] || pendingReferenceRequests[key] !== data.requestId) return;
    const nextPending = { ...pendingReferences };
    const nextRequests = { ...pendingReferenceRequests };
    delete nextPending[key];
    delete nextRequests[key];
    pendingReferences = nextPending;
    pendingReferenceRequests = nextRequests;
    if (data.ok !== true || typeof data.reference !== 'string' || !data.reference) {
      referenceErrors = {
        ...referenceErrors,
        [key]: typeof data.error === 'string' ? data.error : text('referenceFailed'),
      };
      return;
    }
    if (!file) return;
    const nextErrors = { ...referenceErrors };
    delete nextErrors[key];
    referenceErrors = nextErrors;
    commitLocalChange(updateSegmentReference(file, data.segmentId, provider, data.reference));
  }

  function adoptDocumentToken(message: Record<string, unknown>) {
    filePath = typeof message.filePath === 'string' ? message.filePath : '';
    documentId = typeof message.documentId === 'string' ? message.documentId : '';
    revision = Number.isInteger(message.revision) && Number(message.revision) >= 0
      ? Number(message.revision)
      : 0;
    saveState = 'idle';
    saveError = '';
    setLocale(message.locale);
  }

  function openDocument(message: Record<string, unknown>, content: string) {
    flushPendingSave();
    // A new document invalidates all local requests and their errors. Results
    // arriving for this old token are ignored below.
    pendingReferences = {};
    pendingReferenceRequests = {};
    referenceErrors = {};
    composing = false;
    deferredSync = null;
    file = null;
    rawContent = content;
    adoptDocumentToken(message);
    parseContent(rawContent);
  }

  /**
   * A sibling pane changed this same chapter: swap the content in place and
   * keep scroll, focus and in-flight reference requests (the host delivers
   * their results under the new token).
   */
  function applyFileSync(message: Record<string, unknown>) {
    const content = typeof message.content === 'string' ? message.content : '';
    let synced: BookTranslationFile;
    try {
      synced = parseBookTranslationFile(content);
    } catch {
      openDocument(message, content);
      return;
    }
    flushPendingSave();
    file = synced;
    rawContent = content;
    error = '';
    adoptDocumentToken(message);
  }

  function handleMessage(message: HostMessage) {
    if (message.type === 'theme-update' && message.theme && typeof message.theme === 'object') {
      applyTheme(message.theme as Record<string, string>);
      return;
    }
    if (message.type === 'locale-update') {
      setLocale(message.locale);
      return;
    }
    if (message.type === 'file-save-result') {
      handleSaveResult(message);
      return;
    }
    if (message.type === 'translation-reference-result') {
      handleReferenceResult(message);
      return;
    }
    if (typeof message.content !== 'string') return;
    if (message.type === 'file-sync') {
      if (composing) deferredSync = message;
      else applyFileSync(message);
    } else if (message.type === 'file-open') {
      openDocument(message, message.content);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      publishState(true);
    }
  }

  onDestroy(() => {
    cancelPendingSave();
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-shell">
  {#if file}
    <header>
      <div class="chapter-heading">
        <div class="book-mark" aria-hidden="true">译</div>
        <div class="heading-copy">
          <h1>{file.chapter.title}</h1>
          <p>
            {file.book.title}
            {#if file.book.author} · {file.book.author}{/if}
            <span class="language-pair">
              {file.book.sourceLanguage ?? text('languageAuto')} → {file.book.targetLanguage}
            </span>
          </p>
        </div>
      </div>
      <nav class="chapter-nav" aria-label="Chapter navigation">
        <button
          type="button"
          class="nav-button"
          title={text('previous')}
          aria-label={text('previous')}
          disabled={!file.chapter.previousPath}
          onclick={() => openRelative(file?.chapter.previousPath ?? null)}
        >←</button>
        <span>{file.chapter.index} / {file.chapter.total}</span>
        <button
          type="button"
          class="nav-button"
          title={text('next')}
          aria-label={text('next')}
          disabled={!file.chapter.nextPath}
          onclick={() => openRelative(file?.chapter.nextPath ?? null)}
        >→</button>
      </nav>
    </header>

    <main id="book-translation-workspace" data-testid="book-translation-workspace" class="workspace" aria-label={text('originalReferences')}>
      <div class="column-headings" aria-hidden="true">
        <div>{text('myTranslation')}</div>
        <div>{text('originalReferences')}</div>
      </div>
      {#each file.segments as segment, index (segment.id)}
        <!-- Source comes first in the DOM: narrow layouts stack it above the
             translation box (so the original stays visible while the soft
             keyboard is up); wide layouts place it in the right column. -->
        <section class="segment-row">
          <div class="source-cell">
            <div class="source-label" aria-hidden="true">{text('original')}</div>
            <div class="source-text" data-testid={`book-translation-source-${segment.id}`}>{segment.source}</div>
            <div class="references" aria-label={text('originalReferences')}>
              {#each (['google', 'llm'] as TranslationReferenceProvider[]) as provider}
                {@const key = referenceKey(segment.id, provider)}
                {@const reference = provider === 'google' ? segment.googleReference : segment.llmReference}
                <div class="reference-row">
                  <span class="reference-label">{provider === 'google' ? text('google') : text('llm')}</span>
                  {#if reference}
                    <span
                      class="reference-text"
                      data-testid={provider === 'google'
                        ? `book-translation-google-reference-${segment.id}`
                        : `book-translation-llm-reference-${segment.id}`}
                    >{reference}</span>
                    <button
                      type="button"
                      class="reference-button refresh"
                      data-testid={provider === 'google'
                        ? `book-translation-google-${segment.id}`
                        : `book-translation-llm-${segment.id}`}
                      disabled={pendingReferences[key]}
                      aria-label={`${provider === 'google' ? text('google') : text('llm')} ${text('refresh')}`}
                      onclick={() => requestReference(segment.id, provider)}
                    >{pendingReferences[key] ? '…' : text('refresh')}</button>
                  {:else}
                    <button
                      type="button"
                      class="reference-button"
                      data-testid={provider === 'google'
                        ? `book-translation-google-${segment.id}`
                        : `book-translation-llm-${segment.id}`}
                      disabled={pendingReferences[key]}
                      aria-label={`${provider === 'google' ? text('google') : text('llm')} ${text('request')}`}
                      onclick={() => requestReference(segment.id, provider)}
                    >{pendingReferences[key] ? '…' : text('request')}</button>
                  {/if}
                </div>
                {#if referenceErrors[key]}
                  <div class="reference-error" role="alert">{referenceErrors[key]}</div>
                {/if}
              {/each}
            </div>
          </div>
          <div class="translation-cell">
            <label for={`translation-${segment.id}`}>
              <span>{text('segment')} {index + 1}</span>
              <span class="segment-id">{segment.id}</span>
            </label>
            <textarea
              id={`translation-${segment.id}`}
              data-testid={`book-translation-translation-${segment.id}`}
              rows="4"
              value={segment.translation}
              aria-label={`${text('segment')} ${index + 1}`}
              oninput={(event) => handleTranslationInput(event, segment.id)}
              oncompositionstart={() => { composing = true; }}
              oncompositionend={(event) => handleCompositionEnd(event, segment.id)}
            ></textarea>
          </div>
        </section>
      {/each}
    </main>

    <footer>
      <span class="path-label" title={filePath}>{filePath.split(/[\\/]/).pop()}</span>
      {#if saveState === 'saved'}
        <span class="save-state saved">{text('saved')}</span>
      {:else if saveState === 'saving'}
        <span class="save-state">{text('saving')}</span>
      {:else if saveState === 'dirty'}
        <span class="save-state">{text('unsaved')}</span>
      {:else if saveState === 'error'}
        <span class="save-state error" role="alert">{saveError || text('saveFailed')}</span>
      {:else}
        <span class="save-state">{saveError}</span>
      {/if}
    </footer>
  {:else}
    <div class="error-state" role={error ? 'alert' : 'status'}>
      <p>{error || text('opening')}</p>
      {#if error && rawContent}
        <button type="button" onclick={retryParse}>{text('retry')}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(html), :global(body), :global(#app) {
    width: 100%;
    height: 100%;
    margin: 0;
  }
  :global(body) {
    overflow: hidden;
    color: var(--novelist-text, #242424);
    background: var(--novelist-bg, #fff);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button, textarea {
    font: inherit;
  }
  .app-shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  header {
    min-height: 62px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 18px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--novelist-border, #e6e6e6);
  }
  .chapter-heading {
    /* A 180px basis keeps chapter navigation on the title row (long titles
       truncate); only very narrow frames wrap it below. */
    flex: 1 1 180px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .book-mark {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--novelist-accent, #2f6fce);
    background: var(--novelist-bg-secondary, #f4f6fa);
    border: 1px solid var(--novelist-border, #e0e4eb);
    border-radius: 6px;
    font-size: .82rem;
    font-weight: 700;
  }
  .heading-copy {
    min-width: 0;
  }
  h1, p {
    margin: 0;
  }
  h1 {
    overflow: hidden;
    font-size: .92rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  p {
    margin-top: 3px;
    overflow: hidden;
    color: var(--novelist-text-secondary, #6f6f6f);
    font-size: .68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .language-pair {
    margin-left: 8px;
    color: var(--novelist-text-tertiary, #8a8a8a);
  }
  .chapter-nav {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }
  .chapter-nav > span {
    min-width: 48px;
    color: var(--novelist-text-secondary, #6f6f6f);
    font-size: .68rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .nav-button {
    width: 29px;
    height: 29px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: var(--novelist-text-secondary, #666);
    background: transparent;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
    font-size: 1.05rem;
  }
  .nav-button:hover:not(:disabled) {
    color: var(--novelist-text, #222);
    background: var(--novelist-bg-secondary, #f3f3f3);
  }
  .nav-button:disabled {
    opacity: .3;
    cursor: default;
  }
  .workspace {
    min-height: 0;
    flex: 1;
    overflow: auto;
    padding: 0 18px 40px;
  }
  .column-headings {
    position: sticky;
    top: 0;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 18px;
    padding: 12px 0 8px;
    color: var(--novelist-text-secondary, #777);
    background: var(--novelist-bg, #fff);
    border-bottom: 1px solid var(--novelist-border, #e6e6e6);
    font-size: .72rem;
    font-weight: 650;
  }
  .segment-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 18px;
    padding: 17px 0 20px;
    border-bottom: 1px solid var(--novelist-border, #ececec);
  }
  .translation-cell, .source-cell {
    min-width: 0;
  }
  /* Wide layouts: translation left, original right (DOM order is source
     first so narrow layouts can stack it on top). */
  .translation-cell {
    grid-column: 1;
    grid-row: 1;
  }
  .source-cell {
    grid-column: 2;
    grid-row: 1;
  }
  .source-label {
    display: none;
    margin-bottom: 7px;
    color: var(--novelist-text-secondary, #777);
    font-size: .67rem;
  }
  .translation-cell label {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 7px;
    color: var(--novelist-text-secondary, #777);
    font-size: .67rem;
  }
  .segment-id {
    overflow: hidden;
    color: var(--novelist-text-tertiary, #aaa);
    font-size: .6rem;
    text-overflow: ellipsis;
  }
  textarea {
    width: 100%;
    min-height: 78px;
    padding: 10px 11px;
    color: var(--novelist-text, #242424);
    background: var(--novelist-bg, #fff);
    border: 1px solid var(--novelist-border, #d9d9d9);
    border-radius: 5px;
    font-family: var(--novelist-editor-font, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: var(--novelist-editor-font-size, .94rem);
    line-height: 1.65;
    resize: vertical;
  }
  textarea:focus {
    outline: 2px solid color-mix(in srgb, var(--novelist-accent, #2f6fce) 38%, transparent);
    outline-offset: 1px;
    border-color: var(--novelist-accent, #2f6fce);
  }
  .source-text {
    min-height: 78px;
    padding: 10px 11px;
    color: var(--novelist-text, #333);
    background: var(--novelist-bg-secondary, #fafafa);
    border: 1px solid var(--novelist-border, #e5e5e5);
    border-radius: 5px;
    font-family: var(--novelist-editor-font, Georgia, serif);
    font-size: var(--novelist-editor-font-size, .94rem);
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .references {
    margin-top: 9px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .reference-row {
    min-width: 0;
    display: flex;
    align-items: flex-start;
    gap: 7px;
    color: var(--novelist-text-secondary, #666);
    font-size: .72rem;
    line-height: 1.45;
  }
  .reference-label {
    width: 82px;
    flex: 0 0 auto;
    color: var(--novelist-text-tertiary, #888);
    font-weight: 600;
  }
  .reference-text {
    min-width: 0;
    flex: 1;
    color: var(--novelist-text, #444);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reference-button {
    flex: 0 0 auto;
    padding: 2px 7px;
    color: var(--novelist-accent, #2f6fce);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--novelist-accent, #2f6fce) 35%, var(--novelist-border, #ddd));
    border-radius: 4px;
    cursor: pointer;
    font-size: .65rem;
  }
  .reference-button:hover:not(:disabled) {
    background: var(--novelist-bg-secondary, #f3f6fb);
  }
  .reference-button:disabled {
    opacity: .5;
    cursor: default;
  }
  .reference-error {
    margin-left: 89px;
    color: var(--novelist-error, #c53d43);
    font-size: .66rem;
  }
  footer {
    min-height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px;
    color: var(--novelist-text-tertiary, #777);
    background: var(--novelist-bg-secondary, #f7f7f7);
    border-top: 1px solid var(--novelist-border, #e6e6e6);
    font-size: .65rem;
  }
  .path-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .save-state.saved {
    color: var(--novelist-success, #3b8056);
  }
  .save-state.error {
    color: var(--novelist-error, #c53d43);
  }
  .error-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    color: var(--novelist-text-secondary, #777);
    font-size: .82rem;
  }
  .error-state button {
    padding: 6px 12px;
    color: var(--novelist-text, #333);
    background: var(--novelist-bg-secondary, #f3f3f3);
    border: 1px solid var(--novelist-border, #ddd);
    border-radius: 5px;
    cursor: pointer;
  }
  @media (hover: none), (pointer: coarse) {
    .nav-button {
      width: 44px;
      height: 44px;
    }
    .workspace {
      overscroll-behavior: contain;
    }
    textarea {
      /* iOS zooms the page when focusing a field under 16px. */
      font-size: max(16px, var(--novelist-editor-font-size, .94rem));
    }
    .reference-row {
      align-items: center;
    }
    .reference-button {
      min-width: 44px;
      min-height: 44px;
      padding: 0 12px;
      font-size: .75rem;
      touch-action: manipulation;
    }
    .error-state button {
      min-height: 44px;
      padding: 0 16px;
    }
    footer {
      min-height: 32px;
    }
  }
  /* Narrow frames (phones, iPad Slide Over/split): stack each segment with the
     original above its translation box; both stay on screen per segment. */
  @media (max-width: 719px) {
    header { padding: 8px 10px; }
    .chapter-nav { margin-left: auto; }
    .workspace { padding-left: 10px; padding-right: 10px; }
    .column-headings { display: none; }
    .segment-row {
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
      padding: 14px 0 18px;
    }
    .translation-cell, .source-cell {
      grid-column: auto;
      grid-row: auto;
    }
    .source-label { display: block; }
    .language-pair { display: none; }
    .reference-label { width: 62px; }
    .reference-error { margin-left: 69px; }
  }
</style>
