<script lang="ts">
  import { tick } from 'svelte';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import MessageSquareText from '@lucide/svelte/icons/message-square-text';
  import {
    applyDeleteBackwardAtCaret,
    applyDelimitedInputAtCaret,
    applyInput,
    buildRenderPieces,
    clampCaret,
    moveCaret,
    normalizeStudyFile,
    renderedLength,
    resolveCaret,
    type CaretMove,
    type DeleteUnit,
    type LiteraryMode,
    type LiteraryStudyFile,
  } from './engine';

  interface EditorSnapshot {
    file: LiteraryStudyFile;
    mode: LiteraryMode;
    caretIndex: number;
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
  // The insertion point, as a rendered offset (see engine.ts CaretAnchor).
  // Editing is no longer pinned to the transcription frontier — the reader can
  // rewind into copied text to annotate it.
  let caretIndex = $state(0);
  // Column the caret should try to keep while stepping vertically, so a run of
  // Up/Down presses doesn't drift left through short lines.
  let preferredColumnX: number | null = null;
  let preeditLeft = $state(0);
  let preeditTop = $state(0);
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
      autoTypeShortcut: 'Tab types the next source character · Shift+Tab finishes the sentence',
      autoTypeHint: 'Tab next character',
      rewound: 'Editing earlier text — Esc returns to the end',
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
      autoTypeShortcut: 'Tab 自动录入下一字 · Shift+Tab 补完整句',
      autoTypeHint: 'Tab 跟打下一字',
      rewound: '正在回改前文 · Esc 回到末尾',
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

  let pieces = $derived(file ? buildRenderPieces(file, caretIndex) : []);
  let atFrontier = $derived(file ? resolveCaret(file, caretIndex).atFrontier : true);
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
    // The pre-edit overlay hangs below the caret rather than sitting inline:
    // pinyin letters are transient and vary in width, and an inline run would
    // reflow every following character on each keystroke.
    preeditLeft = Math.max(8, Math.min(window.innerWidth - 8, rect.left));
    preeditTop = Math.min(window.innerHeight - 8, rect.bottom + 4);
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

  function setCaret(next: number, keepColumn = false) {
    if (!file) return;
    const clamped = clampCaret(file, next);
    if (clamped !== caretIndex) caretIndex = clamped;
    if (!keepColumn) preferredColumnX = null;
    void revealCaret();
  }

  function step(move: CaretMove) {
    if (!file) return;
    setCaret(moveCaret(file, caretIndex, move));
  }

  /**
   * Map a viewport point to a caret index.
   *
   * Every copied render piece carries its own start offset in
   * `data-caret-start`, so a hit inside one resolves to `start + offset`. The
   * pending grey source has no start (it is not part of the document yet), so
   * clicking it parks the caret at the frontier instead.
   */
  function caretIndexFromPoint(x: number, y: number): number | null {
    if (!file) return null;
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === 'function') {
      const position = doc.caretPositionFromPoint(x, y);
      if (!position) return null;
      node = position.offsetNode;
      offset = position.offset;
    } else if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y);
      if (!range) return null;
      node = range.startContainer;
      offset = range.startOffset;
    }
    if (!node) return null;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
    const host = element?.closest?.('[data-caret-start]') as HTMLElement | null;
    if (!host) {
      // Landed on the untranscribed tail (or outside the article entirely).
      return element?.closest?.('article') ? renderedLength(file) : null;
    }
    const start = Number(host.dataset.caretStart);
    if (!Number.isFinite(start)) return null;
    return clampCaret(file, start + offset);
  }

  function handleArticleClick(event: MouseEvent) {
    const next = caretIndexFromPoint(event.clientX, event.clientY);
    if (next !== null) setCaret(next);
    focusCapture();
  }

  /**
   * Vertical movement needs real geometry: the transcript wraps, so a logical
   * line can span many visual rows. Probe one row above/below the caret and
   * keep the original column so repeated presses travel straight down.
   */
  function stepVertically(direction: -1 | 1) {
    if (!file || !caret) return;
    const rect = caret.getBoundingClientRect();
    const row = Math.max(16, rect.height);
    const x = preferredColumnX ?? rect.left;
    for (let multiplier = 1; multiplier <= 3; multiplier += 1) {
      const y = direction < 0
        ? rect.top - row * (multiplier - 0.5)
        : rect.bottom + row * (multiplier - 0.5);
      const next = caretIndexFromPoint(x, y);
      if (next !== null && next !== caretIndex) {
        preferredColumnX = x;
        setCaret(next, true);
        return;
      }
    }
    // Nothing above/below — fall back to the document edge, like a text editor.
    setCaret(direction < 0 ? 0 : renderedLength(file));
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
    return file ? { file: cloneFile(file), mode, caretIndex } : null;
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

  function mutate(
    next: LiteraryStudyFile,
    nextMode = mode,
    nextCaret = renderedLength(next),
    recordHistory = true,
  ) {
    if (!file) return;
    const changed = !filesEqual(file, next);
    if (!changed) {
      mode = nextMode;
      setCaret(nextCaret);
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
    caretIndex = clampCaret(next, nextCaret);
    preferredColumnX = null;
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
    caretIndex = clampCaret(file, target.caretIndex);
    preferredColumnX = null;
    revision += 1;
    publishState();
  }

  function commitText(input: string, pasted = false) {
    if (!file) return;
    if (!input) return;
    const result = applyDelimitedInputAtCaret(file, caretIndex, input, mode, pasted);
    mutate(result.file, result.mode, result.caretIndex);
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
    const result = applyDeleteBackwardAtCaret(file, caretIndex, mode, unit);
    mutate(result.file, mode, result.caretIndex);
  }

  /**
   * Auto-type from the source. Only ever appends at the frontier — a rewound
   * caret is parked in already-copied text, so the transcript must return there
   * first (the caret jumps back to the frontier).
   */
  function autoType(run: string) {
    if (!file || !run) return;
    const next = applyInput(file, run, 'copy');
    mutate(next, 'copy', renderedLength(next));
  }

  function typeNextSourceCharacter() {
    if (!file || file.sourceCursor >= file.source.length) return;
    autoType(Array.from(file.source.slice(file.sourceCursor))[0] ?? '');
  }

  /**
   * Fill in the rest of the current sentence in one press — the escape hatch
   * for a character the reader cannot produce, without holding the key down.
   * Stops after the first terminator, or at the line break, whichever is first.
   */
  const SENTENCE_TERMINATORS = /[。！？；…!?;\n]/;

  function typeNextSourceSentence() {
    if (!file || file.sourceCursor >= file.source.length) return;
    const pending = file.source.slice(file.sourceCursor);
    let run = '';
    for (const character of pending) {
      run += character;
      if (SENTENCE_TERMINATORS.test(character)) {
        // Absorb trailing closing punctuation so quotes don't strand.
        const rest = pending.slice(run.length);
        const trailing = /^[」』”’）】\]]+/.exec(rest);
        if (trailing) run += trailing[0];
        break;
      }
    }
    autoType(run);
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
    // Tab is the follow-along key: one press types the next source character,
    // Shift+Tab fills the rest of the sentence. F6 stays as an alias — it was
    // the original binding, but on a Mac keyboard it needs Fn to reach.
    if (event.key === 'Tab' || event.key === 'F6') {
      event.preventDefault();
      if (event.shiftKey && event.key === 'Tab') typeNextSourceSentence();
      else typeNextSourceCharacter();
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
    // Caret navigation across the transcribed region. Without this the caret is
    // welded to the frontier and a reader cannot go back to annotate.
    if (!event.altKey && !event.ctrlKey) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(event.metaKey ? 'lineStart' : 'left');
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.metaKey ? 'lineEnd' : 'right');
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (event.metaKey) step('documentStart');
        else stepVertically(-1);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (event.metaKey) step('documentEnd');
        else stepVertically(1);
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        step(event.key === 'Home' ? 'lineStart' : 'lineEnd');
        return;
      }
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && ['a', 'e'].includes(key)) {
      event.preventDefault();
      step(key === 'a' ? 'lineStart' : 'lineEnd');
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
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape is the way back: leave commentary first, then return the caret
      // to the frontier so typing resumes the transcription.
      if (mode === 'comment') setMode('copy');
      else if (!atFrontier) setCaret(renderedLength(file));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      commitText('\n');
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
      caretIndex = renderedLength(file);
      preferredColumnX = null;
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

    <!-- The pre-edit overlay is deliberately outside the article flow: an
         inline run of pinyin letters reflows every character after the caret
         on each keystroke, which makes the whole page appear to shiver. -->
    {#if compositionText}
      <div
        class="composition-overlay"
        class:comment-preedit={mode === 'comment'}
        style:left={`${preeditLeft}px`}
        style:top={`${preeditTop}px`}
        aria-hidden="true"
      >{compositionText}</div>
    {/if}

    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <main onclick={handleArticleClick} onscroll={syncCapturePosition}>
      <article class:comment-mode={mode === 'comment'}>
        <!-- Keep the inline pieces adjacent. Literal formatting whitespace
             here becomes a visible gap at the insertion point under
             `white-space: pre-wrap`. `data-caret-start` carries each piece's
             rendered offset so a click maps back to a caret index. -->
        {#each pieces as piece}{#if piece.type === 'source'}<span class:copied={piece.copied} class:pending={!piece.copied} data-caret-start={piece.start ?? undefined}>{piece.text}</span>{:else if piece.type === 'insertion'}<span class:comment={piece.insertion.kind === 'comment'} class:mistake={piece.insertion.kind === 'mistake'} data-caret-start={piece.start}>{piece.text}</span>{:else}<span bind:this={caret} class="typing-caret" class:comment-caret={mode === 'comment'} class:composing class:rewound={!atFrontier}></span>{/if}{/each}
      </article>
    </main>

    <footer>
      <span class="progress-status" title={text('autoTypeShortcut')}>
        {#if atFrontier}
          {Math.round(progress)}% · {text('autoTypeHint')}
        {:else}
          {text('rewound')}
        {/if}
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
  /* Typography follows Settings → Editor. The host forwards its
     `--novelist-editor-*` vars with every theme update, so the width slider
     moves this column exactly like it moves the main editor; the literals are
     only the standalone fallback when no host is attached. */
  article {
    width: min(var(--novelist-editor-max-width, 820px), calc(100% - 48px));
    min-height: 100%;
    margin: 0 auto;
    padding: 54px 0 100px;
    font-family: var(
      --novelist-editor-font,
      "LXGW WenKai", "Noto Serif SC", "Songti SC", Georgia, serif
    );
    font-size: var(--novelist-editor-font-size, 18px);
    line-height: var(--novelist-editor-line-height, 2.05);
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
  /* Away from the frontier the caret is wider and amber: typing here annotates
     the transcript instead of continuing it. */
  .typing-caret.rewound {
    width: 2px;
    background: #c9821f;
  }
  /* Floating, not inline: the overlay is taken out of the text flow so the
     transcript behind it never moves while an IME candidate is being typed. */
  .composition-overlay {
    position: fixed;
    z-index: 5;
    max-width: min(60ch, calc(100vw - 32px));
    padding: 2px 7px;
    color: var(--novelist-text, #252525);
    background: var(--novelist-bg, #fff);
    border: 1px solid color-mix(in srgb, #6faed6 60%, var(--novelist-border, #e2e2e2));
    border-radius: 5px;
    box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 0.82rem;
    line-height: 1.5;
    letter-spacing: 0.02em;
    white-space: pre-wrap;
    pointer-events: none;
  }
  .composition-overlay.comment-preedit {
    color: #2d6f9f;
    border-color: color-mix(in srgb, #83bee5 70%, transparent);
    background: color-mix(in srgb, #eaf6ff 70%, var(--novelist-bg, #fff));
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
    }
    .chapter-stats { display: none; }
  }
</style>
