<script lang="ts">
  import { tick } from 'svelte';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import {
    applyBackspace,
    applyInput,
    buildRenderPieces,
    normalizeStudyFile,
    type LiteraryMode,
    type LiteraryStudyFile,
  } from './engine';

  let file = $state<LiteraryStudyFile | null>(null);
  let filePath = $state('');
  let documentId = $state('');
  let revision = $state(0);
  let mode = $state<LiteraryMode>('copy');
  let error = $state('');
  let capture = $state<HTMLTextAreaElement | null>(null);
  let caret = $state<HTMLSpanElement | null>(null);
  const saveTimers = new Map<string, number>();
  let pastePending = false;
  let saveState = $state<'idle' | 'dirty' | 'saved' | 'error'>('idle');

  let pieces = $derived(file ? buildRenderPieces(file) : []);
  let progress = $derived(file && file.source.length > 0
    ? Math.min(100, (file.sourceCursor / file.source.length) * 100)
    : 0);

  function focusCapture() {
    capture?.focus({ preventScroll: true });
  }

  async function revealCaret() {
    await tick();
    caret?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
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
      window.parent.postMessage({
        type: 'file-save',
        documentId: targetDocumentId,
        revision: targetRevision,
        content,
      }, '*');
      saveTimers.delete(targetDocumentId);
    } else {
      const timer = window.setTimeout(() => {
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

  function mutate(next: LiteraryStudyFile) {
    file = next;
    revision += 1;
    publishState();
  }

  function handleInput(event: Event) {
    if (!file) return;
    const element = event.currentTarget as HTMLTextAreaElement;
    const text = element.value;
    element.value = '';
    if (!text) return;
    mutate(applyInput(file, text, mode, pastePending));
    pastePending = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!file || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
      event.preventDefault();
      setMode(mode === 'copy' ? 'comment' : 'copy');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      publishState(true);
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      mutate(applyBackspace(file, mode));
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
    if (data?.type === 'file-save-result') {
      if (data.documentId !== documentId || data.revision !== revision) return;
      if (!data.ok) {
        saveState = 'error';
      } else if (data.saved) {
        saveState = 'saved';
      }
      return;
    }
    if (data?.type !== 'file-open' || typeof data.content !== 'string') return;
    try {
      file = normalizeStudyFile(JSON.parse(data.content));
      filePath = data.filePath ?? '';
      documentId = data.documentId ?? data.filePath ?? '';
      revision = Number.isInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
      mode = 'copy';
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

<svelte:window onmessage={handleMessage} />

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
        <div class="mode-switch" aria-label="输入模式">
          <button
            class:active={mode === 'copy'}
            title="抄写模式"
            aria-pressed={mode === 'copy'}
            onclick={() => setMode('copy')}
          >
            <Keyboard size={14} />
            <span>抄写</span>
          </button>
          <button
            class:active={mode === 'comment'}
            title="评注模式（Cmd/Ctrl + Shift + Enter）"
            aria-pressed={mode === 'comment'}
            onclick={() => setMode('comment')}
          >
            <MessageSquareText size={14} />
            <span>评注</span>
          </button>
        </div>

        <div class="chapter-nav">
          <button
            class="icon-button"
            title="上一章"
            aria-label="上一章"
            disabled={!file.chapter.previousPath}
            onclick={() => openRelative(file?.chapter.previousPath ?? null)}
          ><ChevronLeft size={17} /></button>
          <span>{file.chapter.index} / {file.chapter.total}</span>
          <button
            class="icon-button"
            title="下一章"
            aria-label="下一章"
            disabled={!file.chapter.nextPath}
            onclick={() => openRelative(file?.chapter.nextPath ?? null)}
          ><ChevronRight size={17} /></button>
        </div>
      </div>
    </header>

    <div class="progress-track" aria-hidden="true">
      <div style:width={`${progress}%`}></div>
    </div>

    <!-- The hidden textarea owns IME and paste input; the document below is
         immutable source plus inline decorations, so offsets never drift. -->
    <textarea
      class="input-capture"
      bind:this={capture}
      aria-label={mode === 'comment' ? '输入评注' : '输入原文'}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      oninput={handleInput}
      onkeydown={handleKeydown}
      onpaste={() => { pastePending = true; }}
    ></textarea>

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main onclick={focusCapture}>
      <article class:comment-mode={mode === 'comment'}>
        {#each pieces as piece}
          {#if piece.type === 'source'}
            <span class:copied={piece.copied} class:pending={!piece.copied}>{piece.text}</span>
          {:else if piece.type === 'insertion'}
            <span
              class:comment={piece.insertion.kind === 'comment'}
              class:mistake={piece.insertion.kind === 'mistake'}
            >{piece.insertion.text}</span>
          {:else}
            <span bind:this={caret} class="typing-caret" class:comment-caret={mode === 'comment'}></span>
          {/if}
        {/each}
      </article>
    </main>

    <footer>
      <span>{Math.round(progress)}%</span>
      {#if saveState === 'saved'}
        <span class="save-state"><Check size={13} />已保存</span>
      {:else if saveState === 'error'}
        <span class="save-error">保存失败</span>
      {:else}
        <span>{filePath.split(/[\\/]/).pop()}</span>
      {/if}
    </footer>
  {:else}
    <div class="error-state">{error || '正在打开文学评注章节...'}</div>
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
  .toolbar, .chapter-nav, .mode-switch {
    display: flex;
    align-items: center;
  }
  .toolbar {
    flex: 0 0 auto;
    gap: 13px;
  }
  .mode-switch {
    height: 30px;
    padding: 2px;
    background: var(--novelist-bg-secondary, #f5f5f5);
    border: 1px solid var(--novelist-border, #e2e2e2);
    border-radius: 6px;
  }
  .mode-switch button {
    height: 24px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 9px;
    color: var(--novelist-text-secondary, #666);
    background: transparent;
    border: 0;
    border-radius: 4px;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .mode-switch button.active {
    color: var(--novelist-accent, #2f6fce);
    background: var(--novelist-bg, #fff);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.07);
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
    left: -10000px;
    top: 0;
    width: 1px;
    height: 1px;
    opacity: 0;
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
    color: var(--novelist-accent, #2f6fce);
    background: color-mix(in srgb, var(--novelist-accent, #2f6fce) 10%, transparent);
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
    padding: 0 2px;
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
    background: var(--novelist-accent, #2f6fce);
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
    .mode-switch button span { display: none; }
    .mode-switch button { width: 28px; justify-content: center; padding: 0; }
    .toolbar { gap: 6px; }
    article {
      width: calc(100% - 30px);
      padding-top: 32px;
      font-size: 16px;
    }
  }
</style>
