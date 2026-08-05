<script lang="ts">
  import { tick } from 'svelte';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import {
    applyDeleteBackward,
    applyDelimitedInput,
    applyInput,
    buildRenderPieces,
    normalizeStudyFile,
    type DeleteUnit,
    type LiteraryMode,
    type LiteraryStudyFile,
  } from './engine';

  interface EditorSnapshot {
    file: LiteraryStudyFile;
    mode: LiteraryMode;
  }

  let file = $state<LiteraryStudyFile | null>(null);
  let filePath = $state('');
  let documentId = $state('');
  let revision = $state(0);
  let mode = $state<LiteraryMode>('copy');
  let error = $state('');
  let capture = $state<HTMLTextAreaElement | null>(null);
  let caret = $state<HTMLSpanElement | null>(null);
  let compositionText = $state('');
  let captureLeft = $state(0);
  let captureTop = $state(0);
  let captureHeight = $state(24);
  let locale = $state<'en' | 'zh-CN'>('zh-CN');
  const saveTimers = new Map<string, number>();
  const undoStack: EditorSnapshot[] = [];
  const redoStack: EditorSnapshot[] = [];
  let pastePending = false;
  let composing = $state(false);
  let suppressedCompositionValue: string | null = null;
  let suppressionTimer: number | null = null;
  let saveState = $state<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');

  const messages = {
    en: {
      commentShortcut: 'Comment mode (Cmd/Ctrl + Shift + Enter)',
      commentHint: 'Type 【 to add a comment',
      commentActive: 'Writing comment',
      commentEndHint: 'Type 】 to finish',
      autoTypeShortcut: 'F6 types the next source character',
      autoTypeHint: 'F6 next character',
      previousChapter: 'Previous chapter',
      nextChapter: 'Next chapter',
      inputComment: 'Type commentary',
      inputSource: 'Type source text',
      copied: 'copied',
      mistakes: 'mistakes',
      comments: 'comments',
      unsaved: 'Unsaved',
      saving: 'Saving',
      saved: 'Saved',
      saveFailed: 'Save failed',
      opening: 'Opening literary commentary chapter...',
    },
    'zh-CN': {
      commentShortcut: '评注模式（Cmd/Ctrl + Shift + Enter）',
      commentHint: '输入【开始评注',
      commentActive: '正在评注',
      commentEndHint: '输入】结束',
      autoTypeShortcut: 'F6 自动录入范文下一字',
      autoTypeHint: 'F6 跟打下一字',
      previousChapter: '上一章',
      nextChapter: '下一章',
      inputComment: '输入评注',
      inputSource: '输入原文',
      copied: '已抄',
      mistakes: '错字',
      comments: '评注',
      unsaved: '未保存',
      saving: '保存中',
      saved: '已保存',
      saveFailed: '保存失败',
      opening: '正在打开文学评注章节...',
    },
  } as const;

  let pieces = $derived(file ? buildRenderPieces(file) : []);
  let copiedCharacters = $derived(file
    ? Array.from(file.source.slice(0, file.sourceCursor)).length
    : 0);
  let totalCharacters = $derived(file ? Array.from(file.source).length : 0);
  let commentCharacters = $derived(file
    ? file.insertions
        .filter((insertion) => insertion.kind === 'comment')
        .reduce((total, insertion) => total + Array.from(insertion.text).length, 0)
    : 0);
  let progress = $derived(file && totalCharacters > 0
    ? Math.min(100, (copiedCharacters / totalCharacters) * 100)
    : 0);

  function text(key: keyof typeof messages.en): string {
    return messages[locale][key];
  }

  function setLocale(value: unknown) {
    locale = value === 'en' ? 'en' : 'zh-CN';
    document.documentElement.lang = locale;
  }

  function syncCapturePosition() {
    if (!capture || !caret) return;
    const rect = caret.getBoundingClientRect();
    captureLeft = Math.max(0, Math.min(window.innerWidth - 2, rect.left));
    captureTop = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top));
    captureHeight = Math.max(20, rect.height);
  }

  function focusCapture() {
    syncCapturePosition();
    capture?.focus({ preventScroll: true });
  }

  async function revealCaret() {
    await tick();
    caret?.scrollIntoView({ block: 'center', inline: 'nearest' });
    syncCapturePosition();
  }

  function serialize(): string {
    return file ? `${JSON.stringify(file, null, 2)}\n` : '';
  }

  function publishState(saveImmediately = false) {
    if (!file || !documentId) return;
    const content = serialize();
    const targetDocumentId = documentId;
    const targetRevision = revision;
    window.parent.postMessage({
      type: 'file-state',
      documentId: targetDocumentId,
      revision: targetRevision,
      content,
    }, '*');
    saveState = 'dirty';
    const pendingTimer = saveTimers.get(targetDocumentId);
    if (pendingTimer !== undefined) window.clearTimeout(pendingTimer);
    if (saveImmediately) {
      saveState = 'saving';
      window.parent.postMessage({
        type: 'file-save',
        documentId: targetDocumentId,
        revision: targetRevision,
        content,
      }, '*');
      saveTimers.delete(targetDocumentId);
    } else {
      const timer = window.setTimeout(() => {
        saveState = 'saving';
        window.parent.postMessage({
          type: 'file-save',
          documentId: targetDocumentId,
          revision: targetRevision,
          content,
        }, '*');
        saveTimers.delete(targetDocumentId);
      }, 700);
      saveTimers.set(targetDocumentId, timer);
    }
    void revealCaret();
  }

  function setMode(next: LiteraryMode) {
    mode = next;
    focusCapture();
  }

  function cloneFile(value: LiteraryStudyFile): LiteraryStudyFile {
    return JSON.parse(JSON.stringify(value)) as LiteraryStudyFile;
  }

  function snapshot(): EditorSnapshot | null {
    return file ? { file: cloneFile(file), mode } : null;
  }

  function filesEqual(left: LiteraryStudyFile, right: LiteraryStudyFile): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function resetComposition() {
    composing = false;
    compositionText = '';
    suppressedCompositionValue = null;
    if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
    suppressionTimer = null;
    if (capture) capture.value = '';
  }

  function mutate(next: LiteraryStudyFile, nextMode = mode, recordHistory = true) {
    if (!file) return;
    const changed = !filesEqual(file, next);
    if (!changed) {
      mode = nextMode;
      focusCapture();
      return;
    }
    if (recordHistory) {
      const current = snapshot();
      if (current) undoStack.push(current);
      if (undoStack.length > 100) undoStack.shift();
      redoStack.length = 0;
    }
    file = next;
    mode = nextMode;
    revision += 1;
    publishState();
  }

  function restoreHistory(from: EditorSnapshot[], to: EditorSnapshot[]) {
    if (!file) return;
    const target = from.pop();
    if (!target) return;
    const current = snapshot();
    if (current) to.push(current);
    resetComposition();
    file = cloneFile(target.file);
    mode = target.mode;
    revision += 1;
    publishState();
  }

  function commitText(input: string, pasted = false) {
    if (!file) return;
    if (!input) return;
    const result = applyDelimitedInput(file, input, mode, pasted);
    mutate(result.file, result.mode);
  }

  function commitCapture(element: HTMLTextAreaElement) {
    const input = element.value;
    element.value = '';
    const pasted = pastePending;
    pastePending = false;
    commitText(input, pasted);
  }

  function handleInput(event: InputEvent) {
    const element = event.currentTarget as HTMLTextAreaElement;
    if (event.isComposing || composing) {
      compositionText = event.data ?? element.value;
      syncCapturePosition();
      return;
    }
    if (suppressedCompositionValue !== null) {
      const value = element.value || event.data || '';
      const duplicate = value === suppressedCompositionValue
        || event.data === suppressedCompositionValue
        || event.inputType === 'insertFromComposition';
      suppressedCompositionValue = null;
      if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
      suppressionTimer = null;
      if (duplicate) {
        element.value = '';
        return;
      }
    }
    commitCapture(element);
  }

  function handleCompositionStart(event: CompositionEvent) {
    composing = true;
    compositionText = event.data ?? '';
    suppressedCompositionValue = null;
    syncCapturePosition();
  }

  function handleCompositionUpdate(event: CompositionEvent) {
    compositionText = event.data ?? '';
    syncCapturePosition();
  }

  function handleCompositionEnd(event: CompositionEvent) {
    const element = event.currentTarget as HTMLTextAreaElement;
    const committed = event.data ?? '';
    composing = false;
    compositionText = '';
    element.value = '';
    if (!committed) {
      void revealCaret();
      return;
    }

    // WebKit may emit a final non-composing input either immediately before or
    // after compositionend. The composition event is the authoritative commit;
    // suppress only a matching duplicate input from the same event turn.
    suppressedCompositionValue = committed;
    if (suppressionTimer !== null) window.clearTimeout(suppressionTimer);
    suppressionTimer = window.setTimeout(() => {
      suppressedCompositionValue = null;
      suppressionTimer = null;
    }, 0);
    commitText(committed);
  }

  function deleteBackward(unit: DeleteUnit) {
    if (!file) return;
    mutate(applyDeleteBackward(file, mode, unit));
  }

  function typeNextSourceCharacter() {
    if (!file || file.sourceCursor >= file.source.length) return;
    const character = Array.from(file.source.slice(file.sourceCursor))[0];
    if (!character) return;
    mutate(applyInput(file, character, 'copy'), 'copy');
  }

  function handleBeforeInput(event: InputEvent) {
    if (!file || composing || event.isComposing) return;
    const units: Partial<Record<string, DeleteUnit>> = {
      deleteContentBackward: 'character',
      deleteWordBackward: 'word',
      deleteSoftLineBackward: 'line',
      deleteHardLineBackward: 'line',
    };
    const unit = units[event.inputType];
    if (unit) {
      event.preventDefault();
      deleteBackward(unit);
      return;
    }
    if (event.inputType === 'historyUndo') {
      event.preventDefault();
      restoreHistory(undoStack, redoStack);
    } else if (event.inputType === 'historyRedo') {
      event.preventDefault();
      restoreHistory(redoStack, undoStack);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!file || composing || event.isComposing || event.keyCode === 229) return;
    const primary = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'F6') {
      event.preventDefault();
      typeNextSourceCharacter();
      return;
    }
    if (primary && event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      setMode(mode === 'copy' ? 'comment' : 'copy');
      return;
    }
    if (primary && key === 's') {
      event.preventDefault();
      publishState(true);
      return;
    }
    if (primary && key === 'z') {
      event.preventDefault();
      restoreHistory(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack);
      return;
    }
    if (event.ctrlKey && !event.metaKey && key === 'y') {
      event.preventDefault();
      restoreHistory(redoStack, undoStack);
      return;
    }
    const backwardDelete = event.key === 'Backspace'
      || event.code === 'Backspace'
      || (event.metaKey && event.key === 'Delete');
    if (backwardDelete) {
      event.preventDefault();
      deleteBackward(event.metaKey ? 'line' : (event.altKey || event.ctrlKey ? 'word' : 'character'));
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && ['h', 'w', 'u'].includes(key)) {
      event.preventDefault();
      deleteBackward(key === 'h' ? 'character' : (key === 'w' ? 'word' : 'line'));
      return;
    }
    if (event.key === 'Escape' && mode === 'comment') {
      event.preventDefault();
      setMode('copy');
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      mutate(applyInput(file, '\n', mode));
    }
  }

  function openRelative(relativePath: string | null) {
    if (!relativePath) return;
    publishState(true);
    window.parent.postMessage({ type: 'open-project-file', relativePath }, '*');
  }

  function applyTheme(theme: Record<string, string>) {
    for (const [name, value] of Object.entries(theme)) {
      if (value) document.documentElement.style.setProperty(name, value);
    }
  }

  function handleMessage(event: MessageEvent) {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (data?.type === 'theme-update' && data.theme) {
      applyTheme(data.theme);
      return;
    }
    if (data?.type === 'locale-update') {
      setLocale(data.locale);
      return;
    }
    if (data?.type === 'file-save-result') {
      if (data.documentId !== documentId || data.revision !== revision) return;
      if (!data.ok) {
        saveState = 'error';
      } else if (data.saved) {
        saveState = 'saved';
      } else {
        saveState = 'dirty';
      }
      return;
    }
    if (data?.type !== 'file-open' || typeof data.content !== 'string') return;
    try {
      file = normalizeStudyFile(JSON.parse(data.content));
      filePath = data.filePath ?? '';
      documentId = data.documentId ?? data.filePath ?? '';
      revision = Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
      setLocale(data.locale);
      mode = 'copy';
      resetComposition();
      undoStack.length = 0;
      redoStack.length = 0;
      error = '';
      saveState = 'idle';
      void tick().then(() => {
        focusCapture();
        return revealCaret();
      });
    } catch (cause) {
      file = null;
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<svelte:window onmessage={handleMessage} onresize={syncCapturePosition} />

<div class="app-shell">
  {#if file}
    <header>
      <div class="chapter-heading">
        <BookOpen class="chapter-icon" size={17} strokeWidth={1.7} />
        <div>
          <h1>{file.chapter.title}</h1>
          <p>
            {file.book.title}
            {#if file.chapter.volume}<span> / {file.chapter.volume}</span>{/if}
          </p>
        </div>
      </div>

      <div class="toolbar">
        <div
          class="comment-status"
          class:active={mode === 'comment'}
          title={`${text('commentShortcut')} · ${text('autoTypeShortcut')}`}
          aria-live="polite"
        >
          <MessageSquareText size={14} />
          {#if mode === 'comment'}
            <strong>{text('commentActive')}</strong>
            <span>{text('commentEndHint')}</span>
          {:else}
            <span>{text('commentHint')}</span>
          {/if}
        </div>

        <div class="chapter-nav">
          <button
            class="icon-button"
            title={text('previousChapter')}
            aria-label={text('previousChapter')}
            disabled={!file.chapter.previousPath}
            onclick={() => openRelative(file?.chapter.previousPath ?? null)}
          ><ChevronLeft size={17} /></button>
          <span>{file.chapter.index} / {file.chapter.total}</span>
          <button
            class="icon-button"
            title={text('nextChapter')}
            aria-label={text('nextChapter')}
            disabled={!file.chapter.nextPath}
            onclick={() => openRelative(file?.chapter.nextPath ?? null)}
          ><ChevronRight size={17} /></button>
        </div>
      </div>
    </header>

    <div class="progress-track" aria-hidden="true">
      <div style:width={`${progress}%`}></div>
    </div>

    <!-- The transparent textarea owns native keyboard and IME events. It stays
         on top of the rendered caret so the system candidate window opens at
         the writing position instead of at the corner of the app. -->
    <textarea
      class="input-capture"
      bind:this={capture}
      style:left={`${captureLeft}px`}
      style:top={`${captureTop}px`}
      style:height={`${captureHeight}px`}
      aria-label={mode === 'comment' ? text('inputComment') : text('inputSource')}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      onbeforeinput={handleBeforeInput}
      oninput={handleInput}
      oncompositionstart={handleCompositionStart}
      oncompositionupdate={handleCompositionUpdate}
      oncompositionend={handleCompositionEnd}
      onkeydown={handleKeydown}
      onpaste={() => { pastePending = true; }}
    ></textarea>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main onclick={focusCapture} onscroll={syncCapturePosition}>
      <article class:comment-mode={mode === 'comment'}>
        <!-- Keep the inline pieces adjacent. Literal formatting whitespace
             here becomes a visible gap at the insertion point under
             `white-space: pre-wrap`, including around IME pre-edit text. -->
        {#each pieces as piece}{#if piece.type === 'source'}<span class:copied={piece.copied} class:pending={!piece.copied}>{piece.text}</span>{:else if piece.type === 'insertion'}<span class:comment={piece.insertion.kind === 'comment'} class:mistake={piece.insertion.kind === 'mistake'}>{piece.insertion.text}</span>{:else}<span bind:this={caret} class="typing-caret" class:comment-caret={mode === 'comment'} class:composing></span>{#if compositionText}<span class="composition-preedit" class:comment-preedit={mode === 'comment'}>{compositionText}</span>{/if}{/if}{/each}
      </article>
    </main>

    <footer>
      <span class="progress-status" title={text('autoTypeShortcut')}>
        {Math.round(progress)}% · {text('autoTypeHint')}
      </span>
      <span class="chapter-stats">
        {copiedCharacters} {text('copied')} ·
        {file.stats.mistakes} {text('mistakes')} ·
        {commentCharacters} {text('comments')}
      </span>
      {#if saveState === 'saved'}
        <span class="save-state"><Check size={13} />{text('saved')}</span>
      {:else if saveState === 'saving'}
        <span class="save-state">{text('saving')}</span>
      {:else if saveState === 'dirty'}
        <span class="save-state">{text('unsaved')}</span>
      {:else if saveState === 'error'}
        <span class="save-error">{text('saveFailed')}</span>
      {:else}
        <span>{filePath.split(/[\\/]/).pop()}</span>
      {/if}
    </footer>
  {:else}
    <div class="error-state">{error || text('opening')}</div>
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
    background: var(--novelist-bg, #ffffff);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button {
    font: inherit;
  }
  .app-shell {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  header {
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--novelist-border, #e6e6e6);
  }
  .chapter-heading {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  :global(.chapter-icon) {
    flex: 0 0 auto;
    color: var(--novelist-accent, #2f6fce);
  }
  h1, p {
    margin: 0;
  }
  h1 {
    overflow: hidden;
    font-size: 0.92rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  p {
    margin-top: 2px;
    overflow: hidden;
    color: var(--novelist-text-secondary, #6f6f6f);
    font-size: 0.68rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .toolbar, .chapter-nav, .comment-status {
    display: flex;
    align-items: center;
  }
  .toolbar {
    flex: 0 0 auto;
    gap: 13px;
  }
  .comment-status {
    height: 30px;
    gap: 6px;
    padding: 0 9px;
    color: var(--novelist-text-secondary, #666);
    background: var(--novelist-bg-secondary, #f5f5f5);
    border: 1px solid var(--novelist-border, #e2e2e2);
    border-radius: 6px;
    font-size: 0.72rem;
  }
  .comment-status.active {
    color: #2d6f9f;
    background: color-mix(in srgb, #d8efff 62%, var(--novelist-bg, #fff));
    border-color: color-mix(in srgb, #87bee3 52%, var(--novelist-border, #e2e2e2));
  }
  .comment-status strong {
    font-weight: 650;
  }
  .chapter-nav {
    gap: 4px;
  }
  .chapter-nav > span {
    min-width: 48px;
    color: var(--novelist-text-secondary, #6f6f6f);
    font-size: 0.68rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .icon-button {
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: var(--novelist-text-secondary, #666);
    background: transparent;
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .icon-button:hover:not(:disabled) {
    color: var(--novelist-text, #222);
    background: var(--novelist-bg-secondary, #f3f3f3);
  }
  .icon-button:disabled {
    opacity: 0.32;
    cursor: default;
  }
  .progress-track {
    height: 2px;
    flex: 0 0 auto;
    background: var(--novelist-bg-secondary, #f3f3f3);
  }
  .progress-track > div {
    height: 100%;
    background: var(--novelist-accent, #2f6fce);
    transition: width 120ms ease-out;
  }
  .input-capture {
    position: fixed;
    z-index: 0;
    width: 2px;
    min-height: 20px;
    margin: 0;
    padding: 0;
    overflow: hidden;
    color: transparent;
    caret-color: transparent;
    background: transparent;
    border: 0;
    border-radius: 0;
    opacity: 0;
    pointer-events: none;
    resize: none;
    font: inherit;
    line-height: 1;
  }
  main {
    min-height: 0;
    flex: 1;
    overflow: auto;
    cursor: text;
  }
  article {
    width: min(820px, calc(100% - 48px));
    min-height: 100%;
    margin: 0 auto;
    padding: 54px 0 100px;
    font-family: "LXGW WenKai", "Noto Serif SC", "Songti SC", Georgia, serif;
    font-size: 18px;
    line-height: 2.05;
    white-space: pre-wrap;
    word-break: break-word;
    letter-spacing: 0;
  }
  .copied {
    color: var(--novelist-text, #252525);
  }
  .pending {
    color: var(--novelist-text-tertiary, #b2b2b2);
  }
  .comment {
    color: color-mix(in srgb, #2773a5 88%, var(--novelist-text, #252525));
    background: color-mix(in srgb, #cceaff 58%, var(--novelist-bg, #fff));
    border-bottom: 1px solid color-mix(in srgb, #83bee5 55%, transparent);
    border-radius: 3px;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    padding: 1px 3px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .mistake {
    color: var(--novelist-error, #c53d43);
    text-decoration: underline wavy currentColor;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }
  .typing-caret {
    width: 1px;
    height: 1.25em;
    display: inline-block;
    margin: 0 -0.5px -0.22em;
    background: var(--novelist-text, #222);
    animation: blink 1s step-end infinite;
  }
  .typing-caret.comment-caret {
    width: 2px;
    background: #3c88b9;
  }
  .typing-caret.composing {
    animation: none;
  }
  .composition-preedit {
    color: var(--novelist-text, #252525);
    background: color-mix(in srgb, #cceaff 30%, transparent);
    text-decoration: underline solid #6faed6;
    text-decoration-thickness: 1px;
    text-underline-offset: 4px;
  }
  .composition-preedit.comment-preedit {
    color: #2d6f9f;
    background: color-mix(in srgb, #cceaff 58%, var(--novelist-bg, #fff));
  }
  footer {
    min-height: 27px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 14px;
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary, #777));
    background: var(--novelist-bg-secondary, #f7f7f7);
    border-top: 1px solid var(--novelist-border, #e6e6e6);
    font-size: 0.65rem;
  }
  .save-state {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .progress-status {
    white-space: nowrap;
  }
  .chapter-stats {
    min-width: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .save-error {
    color: var(--novelist-error, #c53d43);
  }
  .error-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--novelist-text-secondary, #777);
    font-size: 0.82rem;
  }
  @keyframes blink {
    0%, 48% { opacity: 1; }
    49%, 100% { opacity: 0; }
  }
  @media (max-width: 680px) {
    header { padding: 8px 10px; }
    .chapter-heading p { display: none; }
    .comment-status > span:last-child { display: none; }
    .toolbar { gap: 6px; }
    article {
      width: calc(100% - 30px);
      padding-top: 32px;
      font-size: 16px;
    }
    .chapter-stats { display: none; }
  }
</style>
