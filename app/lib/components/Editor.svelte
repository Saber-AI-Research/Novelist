<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import type { Extension, ChangeSet } from '@codemirror/state';
  import { createEditorExtensions, createEditorState, highlightMatchCompartment, reconfigureEditorState } from '$lib/editor/setup';
  import { highlightSelectionMatches } from '@codemirror/search';
  import { tabsStore, registerEditorView, unregisterEditorView, saveEditorState, getSavedEditorState, getEditorView } from '$lib/stores/tabs.svelte';
  import { Transaction } from '@codemirror/state';
  import { remoteChangeAnnotation } from '$lib/editor/annotations';
  import { projectStore } from '$lib/stores/project.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { commands } from '$lib/ipc/commands';
  import { save as saveDialog, ask, message } from '@tauri-apps/plugin-dialog';
  import { isScratchFile } from '$lib/utils/scratch';
  import { invoke } from '@tauri-apps/api/core';
  import { t } from '$lib/i18n';
  import { countWords } from '$lib/utils/wordcount';
  import { extractHeadings, type HeadingItem } from '$lib/editor/outline';
import {
  setWysiwygImageDocumentDir,
  setWysiwygProjectDir,
  setWysiwygRenderImages,
} from '$lib/editor/wysiwyg';
  import { setSlashCommandI18n } from '$lib/editor/slash-commands';
  import { isImeComposing } from '$lib/editor/ime-guard';
  import { pathBasename, pathDirname, pathJoin, pathStartsWithChild } from '$lib/utils/path';
  import { registerRenameFlushProvider } from '$lib/services/rename-coordinator';
  import { writeDraftNoteStrict } from '$lib/services/draft-notes';

  interface Props {
    paneId?: string;
    wordCount?: number;
    cursorLine?: number;
    cursorCol?: number;
    headings?: HeadingItem[];
  }

  // --- Three-tier thresholds ---
  const FILE_SIZE_LARGE = 1024 * 1024;          // 1MB — disable WYSIWYG
  const FILE_SIZE_READONLY = 3.5 * 1024 * 1024; // 3.5MB — read-only mode
  const LARGE_DOC_LINES = 5000;

  let {
    paneId,
    wordCount = $bindable(0),
    cursorLine = $bindable(1),
    cursorCol = $bindable(1),
    headings = $bindable<HeadingItem[]>([]),
  }: Props = $props();

  let effectivePaneId = $derived(paneId ?? tabsStore.activePaneId);
  let editorContainer: HTMLDivElement;
  let view: EditorView | null = null;
  let currentTabId: string | null = null;
  let currentTabVersion: number = -1;
  let currentZenMode: boolean = false;
  let isReadOnly = $state(false);
  let readOnlyFileSize = $state(0);
  let statsTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingLoadAfterComposition = false;
  // Re-entrancy guard for saveCurrentFile. Prevents two racing writers from
  // both using the `{path}.novelist-tmp` atomic-write name (the first rename
  // would consume the temp and the second would fail with ENOENT).
  let isSaving = false;

  // Recovery banner state (replaces modal dialog for better UX)
  let recoveryAvailable = $state(false);
  let recoveryContent = $state<string | null>(null);
  let recoveryFilePath = $state<string | null>(null);
  let recoveryFileName = $state('');

  // Session tracking for writing stats. We only count *gross additions* across
  // a session: each time the debounced word-count sample increases vs. the
  // previous sample, the positive diff is added to `sessionWordsAdded`.
  // Deletions are ignored, so typing 100 then deleting 50 records 100 (typing
  // effort), not 50 (net), and never produces a negative day total.
  let sessionStartTime: number | null = null;
  let sessionWordsAdded = 0;
  let sessionLastSampled = 0;
  let lastKnownWordCount = 0;

  /** Fold a fresh wordCount sample into the active session, if one is open. */
  function sampleSessionWords(currentCount: number) {
    if (sessionStartTime === null) return;
    const incremental = currentCount - sessionLastSampled;
    if (incremental > 0) sessionWordsAdded += incremental;
    sessionLastSampled = currentCount;
  }

  // Crash recovery: use a `.~recovery` suffix to separate from sidebar draft notes
  const RECOVERY_SUFFIX = '.~recovery';
  let pendingRecoveryWrite: Promise<void> | null = null;

  /** Write a crash-recovery draft for the current file content. */
  async function writeRecoveryDraft(filePath: string, content: string) {
    if (!projectStore.dirPath) return;
    pendingRecoveryWrite = writeDraftNoteStrict(projectStore.dirPath, filePath + RECOVERY_SUFFIX, content)
      .then(() => {})
      .finally(() => { pendingRecoveryWrite = null; });
    await pendingRecoveryWrite;
  }

  async function flushRecoveryForRename(oldPath: string) {
    const tab = getActiveTab();
    if (!tab || !view || !projectStore.dirPath) return;
    if (tab.filePath !== oldPath && !pathStartsWithChild(tab.filePath, oldPath)) return;
    if (tab.isDirty) await writeRecoveryDraft(tab.filePath, view.state.doc.toString());
    if (pendingRecoveryWrite) await pendingRecoveryWrite;
  }

  /** Delete the crash-recovery draft after a successful save. */
  async function clearRecoveryDraft(filePath: string) {
    if (!projectStore.dirPath) return;
    await commands.deleteDraftNote(projectStore.dirPath, filePath + RECOVERY_SUFFIX).catch(() => {});
  }

  /** Check for a crash-recovery draft and show a non-intrusive banner if found. */
  async function checkRecoveryDraft(filePath: string): Promise<void> {
    if (!projectStore.dirPath) return;
    const hasResult = await commands.hasDraftNote(projectStore.dirPath, filePath + RECOVERY_SUFFIX);
    if (hasResult.status !== 'ok' || !hasResult.data) return;

    const readResult = await commands.readDraftNote(projectStore.dirPath, filePath + RECOVERY_SUFFIX);
    if (readResult.status !== 'ok' || !readResult.data) return;

    const draftContent = readResult.data;
    // Only offer recovery if content differs from what's on disk
    const tab = getActiveTab();
    if (!tab || draftContent === tab.content) {
      // Draft matches disk — clean it up silently
      await clearRecoveryDraft(filePath);
      return;
    }

    // Show recovery banner instead of modal dialog
    recoveryAvailable = true;
    recoveryContent = draftContent;
    recoveryFilePath = filePath;
    recoveryFileName = pathBasename(filePath) || filePath;
  }

  /** User chose to recover the draft from the banner. */
  function acceptRecovery() {
    if (recoveryContent && view && currentTabId) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: recoveryContent },
      });
      tabsStore.markDirty(currentTabId);
      wordCount = countWords(recoveryContent);
      lastKnownWordCount = wordCount;
      headings = extractHeadings(view.state);
    }
    if (recoveryFilePath) clearRecoveryDraft(recoveryFilePath);
    dismissRecoveryBanner();
  }

  /** User chose to discard the recovery draft. */
  function discardRecovery() {
    if (recoveryFilePath) clearRecoveryDraft(recoveryFilePath);
    dismissRecoveryBanner();
  }

  function dismissRecoveryBanner() {
    recoveryAvailable = false;
    recoveryContent = null;
    recoveryFilePath = null;
    recoveryFileName = '';
  }

  function scrollToPosition(from: number) {
    if (!view) return;
    view.dispatch({
      selection: { anchor: Math.min(from, view.state.doc.length) },
      scrollIntoView: true,
    });
    view.focus();
  }

  function jumpToAbsoluteLine(absLine: number) {
    if (!view) return;
    if (absLine >= 1 && absLine <= view.state.doc.lines) {
      const line = view.state.doc.line(absLine);
      view.dispatch({
        selection: { anchor: line.from },
        scrollIntoView: true,
      });
      view.focus();
    }
  }

  export { scrollToPosition, jumpToAbsoluteLine, saveCurrentFile };

  function updateCursorInfo(v: EditorView) {
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    cursorLine = line.number;
    cursorCol = pos - line.from + 1;
  }

  function getActiveTab() {
    return tabsStore.getPaneActiveTab(effectivePaneId);
  }

  /**
   * Schedule stats update with a trailing-edge debounce.
   * Uses requestIdleCallback when available so stats computation
   * never blocks typing or scroll. Falls back to setTimeout.
   *
   * MiaoYan-style performance tiers:
   * - < 2K lines: full stats (word count + headings) after 500ms idle
   * - 2K-5K lines: full stats after 1s idle
   * - > 5K lines: estimate word count, skip headings
   */
  let statsScheduled = false;
  function scheduleStatsUpdate(state: import('@codemirror/state').EditorState) {
    if (statsScheduled) return; // Don't reset — let the pending callback fire
    statsScheduled = true;

    const isLarge = state.doc.lines > LARGE_DOC_LINES;
    const isMedium = state.doc.lines > 2000;
    const delay = isLarge ? 2000 : isMedium ? 1000 : 500;

    const run = () => {
      statsScheduled = false;
      // Re-read the current view state (may have changed since scheduling)
      if (!view) return;
      const currentState = view.state;
      if (currentState.doc.lines > LARGE_DOC_LINES) {
        wordCount = Math.round(currentState.doc.length / 4);
      } else {
        wordCount = countWords(currentState.doc.toString());
        headings = extractHeadings(currentState);
      }
      lastKnownWordCount = wordCount;
      sampleSessionWords(wordCount);
    };

    if (statsTimer) clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      statsTimer = null;
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(run, { timeout: 200 });
      } else {
        run();
      }
    }, delay);
  }

  function flushWritingStats() {
    if (sessionStartTime === null) return;
    // Take one final sample so additions made since the last debounced update
    // (e.g. typing then immediately Cmd+S within 500ms) aren't lost.
    if (view) {
      const st = view.state;
      const currentCount = st.doc.lines > LARGE_DOC_LINES
        ? Math.round(st.doc.length / 4)
        : countWords(st.doc.toString());
      lastKnownWordCount = currentCount;
      sampleSessionWords(currentCount);
    }
    const minutes = Math.max(1, Math.round((Date.now() - sessionStartTime) / 60000));
    const wordsAdded = sessionWordsAdded;
    // Reset session state before the async send so a re-entrant call doesn't
    // double-record.
    sessionStartTime = null;
    sessionWordsAdded = 0;
    // In single-file mode there's no project dir, so key stats by the file's
    // own path (the backend buckets stats by a hash of this value and treats a
    // file path as a single-chapter root).
    const statsRoot = projectStore.dirPath ?? getActiveTab()?.filePath ?? null;
    if (!statsRoot) return;
    if (wordsAdded === 0 && minutes < 2) return;
    invoke('record_writing_stats', {
      projectDir: statsRoot,
      wordDelta: wordsAdded,
      minutes,
    }).catch(e => console.warn('[Stats] Failed to record:', e));
  }

  function buildExtensions(fileSize: number, lineCount: number): Extension[] {
    const readOnly = fileSize >= FILE_SIZE_READONLY;
    const largeFile = fileSize >= FILE_SIZE_LARGE;
    const tallDoc = lineCount > LARGE_DOC_LINES;

    return createEditorExtensions({
      wysiwyg: !largeFile && !readOnly && !tallDoc,
      zen: uiStore.zenMode && !largeFile && !readOnly,
      largeFile: largeFile && !readOnly,
      tallDoc: tallDoc && !largeFile && !readOnly,
      readOnly,
      indentStyle: uiStore.editorSettings.indentStyle,
      highlightMatches: uiStore.editorSettings.highlightMatches,
    });
  }

  function buildUpdateListener(): Extension {
    return EditorView.updateListener.of((update) => {
      if (pendingLoadAfterComposition && !isImeComposing(update.view)) {
        pendingLoadAfterComposition = false;
        queueMicrotask(loadTab);
      }
      if (update.docChanged) {
        const t = getActiveTab();
        if (t) {
          tabsStore.markDirty(t.id);

          // Cross-pane sync: propagate changes to other views of the same file
          const isRemote = update.transactions.some(tr => tr.annotation(remoteChangeAnnotation));
          if (!isRemote) {
            const otherTabs = tabsStore.findAllByPath(t.filePath);
            for (const other of otherTabs) {
              if (other.id === t.id) continue;
              const otherView = getEditorView(other.id);
              if (otherView) {
                otherView.dispatch({
                  changes: update.changes,
                  annotations: [
                    remoteChangeAnnotation.of(true),
                    Transaction.addToHistory.of(false),
                  ],
                });
                tabsStore.markDirty(other.id);
              }
            }
          }
        }
        scheduleStatsUpdate(update.state);
        // Start session tracking on first keystroke. Pre-edit word count is
        // the baseline for the additions accumulator.
        if (sessionStartTime === null) {
          sessionStartTime = Date.now();
          sessionLastSampled = lastKnownWordCount;
          sessionWordsAdded = 0;
        }
      }
      if (update.selectionSet || update.docChanged || update.geometryChanged) {
        updateCursorInfo(update.view);
      }
    });
  }

  async function saveCurrentFile() {
    if (isSaving) return;
    const tab = getActiveTab();
    if (!tab || !view) return;

    const content = view.state.doc.toString();

    // Cmd+S on a clean tab: nothing to write, but the user may have just
    // typed an H1 then triggered autosave (or come back to a placeholder
    // file from disk). Still run the H1-driven rename check so the
    // filename gets a chance to catch up. See spec
    // 2026-05-07-v0.2.4-rename-and-macros.md.
    if (!tab.isDirty) {
      if (!isScratchFile(tab.filePath)) {
        await tabsStore.tryRenameAfterSave(tab.filePath, content);
      }
      return;
    }

    isSaving = true;
    try {
      // Scratch files (pattern-based) → prompt Save As with rename. They
      // live in a hidden cache dir, so writing back to that path is never
      // what the user wants on Cmd+S.
      if (isScratchFile(tab.filePath)) {
        await saveAsRename(tab, content);
        return;
      }

      await commands.registerWriteIgnore(tab.filePath);
      const result = await commands.writeFile(tab.filePath, content);
      if (result.status === 'ok') {
        tabsStore.updateContent(tab.id, content);
        const finalPath = await tabsStore.tryRenameAfterSave(tab.filePath, content);
        tabsStore.markSavedByPath(finalPath);
        clearRecoveryDraft(tab.filePath);
        flushWritingStats();
      } else {
        console.error('[Save] Failed:', result.error);
        const errStr = String(result.error ?? '');
        // "Parent directory does not exist" is the explicit pre-check error
        // raised by write_file_inner when the folder really is gone. Bare
        // "No such file or directory" / "os error 2" is ambiguous — e.g. a
        // concurrent-writer race on the `.novelist-tmp` rename produces it
        // too — so we only trust the explicit message for the Save As
        // recovery prompt. Everything else becomes a non-blocking error
        // toast so the user can retry without being pushed into a file
        // picker they never asked for.
        const parentMissing = errStr.includes('Parent directory does not exist');
        if (parentMissing) {
          const wantSaveAs = await ask(
            t('dialog.saveParentMissing', { path: tab.filePath }),
            {
              title: t('dialog.saveFailed'),
              kind: 'warning',
              okLabel: t('dialog.saveAs'),
              cancelLabel: t('dialog.cancel'),
            }
          );
          if (wantSaveAs) await saveAsRename(tab, content);
        } else {
          await message(errStr || t('dialog.saveFailedGeneric'), {
            title: t('dialog.saveFailed'),
            kind: 'error',
          });
        }
      }
    } finally {
      isSaving = false;
    }
  }

  /** Save As / Rename: prompt user for a new file name and location. */
  async function saveAsRename(tab: { id: string; filePath: string; fileName: string }, content: string) {
    // Default to project dir if available, otherwise the file's own dir
    const defaultDir = projectStore.dirPath || pathDirname(tab.filePath);
    const savePath = await saveDialog({
      defaultPath: pathJoin(defaultDir, 'untitled.md'),
      filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv'] }],
    });
    if (!savePath) return;

    await commands.registerWriteIgnore(savePath);
    const result = await commands.writeFile(savePath, content);
    if (result.status === 'ok') {
      // Delete old scratch file if it was in the project dir
      if (isScratchFile(tab.filePath)) {
        commands.deleteItem(tab.filePath).catch(() => {});
      }
      await tabsStore.retargetTabPath(tab.id, savePath);
      tabsStore.updateContent(tab.id, content);
      tabsStore.markSavedByPath(savePath);
      // Refresh sidebar if in project mode
      if (projectStore.dirPath) {
        const filesResult = await commands.listDirectory(projectStore.dirPath, null);
        if (filesResult.status === 'ok') projectStore.updateFiles(filesResult.data);
      }
      flushWritingStats();
    }
  }

  /** Rename current file (Cmd+Shift+R) — always shows Save As dialog. */
  export async function renameCurrentFile() {
    const tab = getActiveTab();
    if (!tab || !view) return;
    const content = view.state.doc.toString();
    await saveAsRename(tab, content);
  }

  /** Split a large read-only file into chapters based on H1 headings */
  async function splitIntoChunks() {
    if (!view || !projectStore.dirPath) return;
    const doc = view.state.doc;
    const chunks: { name: string; content: string }[] = [];
    let currentChunk = '';
    let chunkIndex = 0;
    let chunkName = 'part-001';

    for (let i = 1; i <= doc.lines; i++) {
      const lineText = doc.line(i).text;
      if (lineText.startsWith('# ') && currentChunk.length > 0) {
        chunks.push({ name: chunkName, content: currentChunk });
        chunkIndex++;
        chunkName = `part-${String(chunkIndex + 1).padStart(3, '0')}`;
        currentChunk = lineText + '\n';
      } else {
        currentChunk += lineText + '\n';
      }
    }
    if (currentChunk.length > 0) {
      chunks.push({ name: chunkName, content: currentChunk });
    }

    if (chunks.length <= 1) {
      // No H1 headings found — split by line count
      const LINES_PER_CHUNK = 5000;
      chunks.length = 0;
      let idx = 0;
      for (let start = 1; start <= doc.lines; start += LINES_PER_CHUNK) {
        const end = Math.min(start + LINES_PER_CHUNK - 1, doc.lines);
        let content = '';
        for (let i = start; i <= end; i++) {
          content += doc.line(i).text + '\n';
        }
        idx++;
        chunks.push({ name: `part-${String(idx).padStart(3, '0')}`, content });
      }
    }

    // Create chunks directory and write files
    const tab = getActiveTab();
    const baseName = tab?.fileName?.replace(/\.md$/, '') ?? 'split';
    const mkdirResult = await commands.createDirectory(projectStore.dirPath, `${baseName}-chunks`);
    if (mkdirResult.status !== 'ok') {
      console.error('Failed to create chunks directory:', mkdirResult.error);
      return;
    }
    const chunksDir = mkdirResult.data;

    for (const chunk of chunks) {
      await commands.createFile(chunksDir, `${chunk.name}.md`);
      await commands.writeFile(pathJoin(chunksDir, `${chunk.name}.md`), chunk.content);
    }

    // Refresh file tree
    const filesResult = await commands.listDirectory(projectStore.dirPath, null);
    if (filesResult.status === 'ok') {
      projectStore.updateFiles(filesResult.data);
    }

    alert(t('editor.splitResult', { count: chunks.length, name: baseName }));
  }



  // --- Tab lifecycle ---

  function cleanupCurrentView(discardState = false) {
    flushWritingStats();
    if (view && currentTabId) {
      if (!discardState) saveEditorState(currentTabId, view.state);
      if (!discardState && !isReadOnly) {
        // syncFromView now compares content before marking dirty,
        // so scroll-only sessions won't trigger false dirty flags.
        tabsStore.syncFromView(currentTabId);
      }
      unregisterEditorView(currentTabId);
    }
    if (view) {
      view.destroy();
      view = null;
    }
    isReadOnly = false;
    if (typeof window !== 'undefined') {
      delete (window as any).__novelist_view;
      delete (window as any).__novelist_save;
    }
  }

  function loadTab() {
    const tab = getActiveTab();
    if (!tab) {
      cleanupCurrentView();
      currentTabId = null;
      currentTabVersion = -1;
      return;
    }

    if (tab.id === currentTabId && tab.version === currentTabVersion && currentZenMode === uiStore.zenMode && view) return;

    if (view && isImeComposing(view)) {
      pendingLoadAfterComposition = true;
      return;
    }

    setWysiwygProjectDir(projectStore.dirPath ?? '');
    // Image rendering: off for novel template projects, on otherwise (respects user setting)
    const isNovelTemplate = projectStore.config?.project?.type === 'novel';
    setWysiwygRenderImages(isNovelTemplate ? false : uiStore.editorSettings.renderImages);

    const discardStaleView = tab.id === currentTabId && tab.version !== currentTabVersion;
    cleanupCurrentView(discardStaleView);
    currentTabId = tab.id;
    currentTabVersion = tab.version;
    currentZenMode = uiStore.zenMode;

    const fileEntry = projectStore.files.find(f => f.path === tab.filePath);
    const fileSize = fileEntry?.size ?? tab.content.length;
    let lineCount = 0;
    for (let i = 0; i < tab.content.length; i++) {
      if (tab.content[i] === '\n') lineCount++;
    }
    lineCount += 1;

    isReadOnly = fileSize >= FILE_SIZE_READONLY;
    readOnlyFileSize = fileSize;

    const extensions = [
      ...buildExtensions(fileSize, lineCount),
      buildUpdateListener(),
      // Cmd+S and Cmd+W are intentionally NOT bound here — both are owned by
      // the window-level handler in App.svelte. Binding them a second time in
      // a CM6 keymap dispatches the command twice per keypress: two racing
      // saveCurrentFile calls share the same `{path}.novelist-tmp` name, so
      // the first rename consumes the temp and the second fails with ENOENT
      // ("rename … No such file or directory"), which the error path then
      // wrongly reports as "parent directory missing" and pops Save As.
      // Two close-tab dispatches stack two "save before close?" dialogs.
    ];

    const savedState = getSavedEditorState(tab.id);
    if (savedState) {
      // Restore saved state (preserves undo history) with current extensions
      view = new EditorView({
        state: reconfigureEditorState(savedState, extensions),
        parent: editorContainer,
      });
    } else {
      const state = createEditorState(tab.content, extensions);
      view = new EditorView({ state, parent: editorContainer });
    }
    setWysiwygImageDocumentDir(view, pathDirname(tab.filePath));
    registerEditorView(tab.id, view);
    // Auto-focus the editor so the user can type immediately
    requestAnimationFrame(() => view?.focus());

    (window as any).__novelist_view = view;
    (window as any).__novelist_save = saveCurrentFile;

    if (view.state.doc.lines > LARGE_DOC_LINES) {
      wordCount = Math.round(view.state.doc.length / 4);
      headings = [];  // Skip full-tree parse for large files
    } else {
      wordCount = countWords(tab.content);
      headings = extractHeadings(view.state);
    }
    lastKnownWordCount = wordCount;
    updateCursorInfo(view);

    // Check for crash recovery draft (async, shows banner if found)
    dismissRecoveryBanner(); // Clear any previous banner
    if (!savedState && !isReadOnly && projectStore.dirPath) {
      checkRecoveryDraft(tab.filePath);
    }
  }

  $effect(() => {
    const _tab = tabsStore.getPaneActiveTab(effectivePaneId);
    const _version = _tab?.version;
    const _zen = uiStore.zenMode;
    if (editorContainer) {
      loadTab();
    }
  });

  // Dynamically toggle highlight matches without reloading the tab
  $effect(() => {
    const enabled = uiStore.editorSettings.highlightMatches;
    if (view) {
      if (isImeComposing(view)) return;
      view.dispatch({
        effects: highlightMatchCompartment.reconfigure(
          enabled ? highlightSelectionMatches() : []
        ),
      });
    }
  });

  onMount(() => {
    const unregisterRenameFlush = registerRenameFlushProvider(flushRecoveryForRename);
    // Initialize slash command i18n labels
    const slashLabels = new Map([
      ['heading1', { label: t('slash.heading1'), description: t('slash.heading1.desc') }],
      ['heading2', { label: t('slash.heading2'), description: t('slash.heading2.desc') }],
      ['heading3', { label: t('slash.heading3'), description: t('slash.heading3.desc') }],
      ['bulletList', { label: t('slash.bulletList'), description: t('slash.bulletList.desc') }],
      ['numberedList', { label: t('slash.numberedList'), description: t('slash.numberedList.desc') }],
      ['taskList', { label: t('slash.taskList'), description: t('slash.taskList.desc') }],
      ['codeBlock', { label: t('slash.codeBlock'), description: t('slash.codeBlock.desc') }],
      ['quote', { label: t('slash.quote'), description: t('slash.quote.desc') }],
      ['divider', { label: t('slash.divider'), description: t('slash.divider.desc') }],
      ['image', { label: t('slash.image'), description: t('slash.image.desc') }],
      ['table', { label: t('slash.table'), description: t('slash.table.desc') }],
      ['math', { label: t('slash.math'), description: t('slash.math.desc') }],
      ['callout', { label: t('slash.callout'), description: t('slash.callout.desc') }],
    ]);
    setSlashCommandI18n(slashLabels);

    loadTab();

    let autoSaveIntervalId: ReturnType<typeof setInterval> | null = null;

    function updateAutoSaveInterval() {
      if (autoSaveIntervalId) { clearInterval(autoSaveIntervalId); autoSaveIntervalId = null; }
      const autoSaveMinutes = uiStore.editorSettings.autoSaveMinutes;
      if (autoSaveMinutes <= 0) return;
      autoSaveIntervalId = setInterval(async () => {
        const paneTabs = tabsStore.getPaneTabs(effectivePaneId);
        for (const tab of paneTabs) {
          if (!tab.isDirty) continue;
          tabsStore.syncFromView(tab.id);
          const freshTab = tabsStore.findByPath(tab.filePath);
          if (freshTab?.isDirty) {
            await commands.registerWriteIgnore(freshTab.filePath);
            const result = await commands.writeFile(freshTab.filePath, freshTab.content);
            if (result.status === 'ok') {
              await tabsStore.tryRenameAfterSave(freshTab.filePath, freshTab.content);
              tabsStore.markSaved(freshTab.id);
            }
          }
        }
      }, autoSaveMinutes * 60 * 1000);
    }

    updateAutoSaveInterval();

    $effect(() => {
      const _minutes = uiStore.editorSettings.autoSaveMinutes;
      updateAutoSaveInterval();
    });

    // Crash-recovery draft: saves content to a recovery draft periodically
    // when the document is dirty, so edits survive crashes/force-quits.
    const recoveryDraftIntervalId = setInterval(() => {
      const tab = getActiveTab();
      if (!tab || !tab.isDirty || !view || !projectStore.dirPath) return;
      const content = view.state.doc.toString();
      writeRecoveryDraft(tab.filePath, content).catch(
        e => console.warn('[Recovery] Failed to write draft:', e),
      );
    }, 90_000);

    return () => {
      unregisterRenameFlush();
      clearInterval(recoveryDraftIntervalId);
      if (autoSaveIntervalId) clearInterval(autoSaveIntervalId);
      if (statsTimer) clearTimeout(statsTimer);
      cleanupCurrentView();
    };
  });
</script>

<div class="flex flex-col h-full w-full">
  {#if recoveryAvailable}
    <div data-testid="recovery-banner" class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs" style="background: color-mix(in srgb, var(--novelist-warning, #e8a838) 15%, var(--novelist-bg)); color: var(--novelist-warning, #e8a838); border-bottom: 1px solid var(--novelist-border);">
      <span>{t('recovery.bannerMessage', { fileName: recoveryFileName })}</span>
      <button
        data-testid="recovery-accept"
        class="px-2 py-0.5 rounded text-xs cursor-pointer"
        style="background: var(--novelist-warning, #e8a838); color: #fff;"
        onclick={acceptRecovery}
      >{t('recovery.recover')}</button>
      <button
        data-testid="recovery-discard"
        class="px-2 py-0.5 rounded text-xs cursor-pointer"
        style="background: transparent; color: var(--novelist-text-secondary); border: 1px solid var(--novelist-border);"
        onclick={discardRecovery}
      >{t('recovery.discard')}</button>
    </div>
  {/if}
  {#if isReadOnly}
    <div data-testid="readonly-banner" class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs" style="background: color-mix(in srgb, var(--novelist-accent) 15%, var(--novelist-bg)); color: var(--novelist-accent); border-bottom: 1px solid var(--novelist-border);">
      <span>{t('editor.readOnly', { size: (readOnlyFileSize / 1024 / 1024).toFixed(1) })}</span>
      <button
        class="px-2 py-0.5 rounded text-xs cursor-pointer"
        style="background: var(--novelist-accent); color: #fff;"
        onclick={splitIntoChunks}
      >{t('editor.splitChunks')}</button>
    </div>
  {/if}
  <div class="flex-1 min-h-0 w-full" data-testid="editor-container" bind:this={editorContainer}></div>
</div>
