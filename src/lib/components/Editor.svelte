<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView, keymap } from '@codemirror/view';
  import type { Extension, ChangeSet } from '@codemirror/state';
  import { createEditorExtensions, createEditorState, highlightMatchCompartment } from '$lib/editor/setup';
  import { highlightSelectionMatches } from '@codemirror/search';
  import { tabsStore, registerEditorView, unregisterEditorView, saveEditorState, getSavedEditorState, getEditorView } from '$lib/stores/tabs.svelte';
  import { Transaction } from '@codemirror/state';
  import { remoteChangeAnnotation } from '$lib/editor/annotations';
  import { projectStore } from '$lib/stores/project.svelte';
  import { uiStore } from '$lib/stores/ui.svelte';
  import { commands } from '$lib/ipc/commands';
  import { invoke } from '@tauri-apps/api/core';
  import { countWords } from '$lib/utils/wordcount';
  import { extractHeadings, type HeadingItem } from '$lib/editor/outline';
  import { setWysiwygProjectDir } from '$lib/editor/wysiwyg';

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

  // Session tracking for writing stats
  let sessionStartWordCount: number | null = null;
  let sessionStartTime: number | null = null;
  let lastKnownWordCount = 0;

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

  export { scrollToPosition, jumpToAbsoluteLine };

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
    if (sessionStartWordCount === null || sessionStartTime === null) return;
    if (!projectStore.dirPath) return;
    const delta = lastKnownWordCount - sessionStartWordCount;
    const minutes = Math.max(1, Math.round((Date.now() - sessionStartTime) / 60000));
    if (delta === 0 && minutes < 2) {
      // Don't record trivial sessions
      sessionStartWordCount = null;
      sessionStartTime = null;
      return;
    }
    invoke('record_writing_stats', {
      projectDir: projectStore.dirPath,
      wordDelta: delta,
      minutes,
    }).catch(e => console.warn('[Stats] Failed to record:', e));
    sessionStartWordCount = null;
    sessionStartTime = null;
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
        // Start session tracking on first keystroke
        if (sessionStartWordCount === null) {
          sessionStartWordCount = lastKnownWordCount;
          sessionStartTime = Date.now();
        }
      }
      if (update.selectionSet || update.docChanged || update.geometryChanged) {
        updateCursorInfo(update.view);
      }
    });
  }

  async function saveCurrentFile() {
    const tab = getActiveTab();
    if (!tab || !tab.isDirty || !view) return;

    const content = view.state.doc.toString();
    await commands.registerWriteIgnore(tab.filePath);
    const result = await commands.writeFile(tab.filePath, content);
    if (result.status === 'ok') {
      tabsStore.updateContent(tab.id, content);
      tabsStore.markSavedByPath(tab.filePath);
      flushWritingStats();
    } else {
      console.error('[Save] Failed:', result.error);
    }
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
    const chunksDir = `${projectStore.dirPath}/${baseName}-chunks`;

    const mkdirResult = await commands.createDirectory(projectStore.dirPath, `${baseName}-chunks`);
    if (mkdirResult.status !== 'ok') {
      console.error('Failed to create chunks directory:', mkdirResult.error);
      return;
    }

    for (const chunk of chunks) {
      await commands.createFile(chunksDir, `${chunk.name}.md`);
      await commands.writeFile(`${chunksDir}/${chunk.name}.md`, chunk.content);
    }

    // Refresh file tree
    const filesResult = await commands.listDirectory(projectStore.dirPath);
    if (filesResult.status === 'ok') {
      projectStore.updateFiles(filesResult.data);
    }

    alert(`Split into ${chunks.length} files in ${baseName}-chunks/`);
  }



  // --- Tab lifecycle ---

  function cleanupCurrentView() {
    flushWritingStats();
    if (view && currentTabId) {
      saveEditorState(currentTabId, view.state);
      if (!isReadOnly) {
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

    // Set project dir for image resolution in WYSIWYG
    if (projectStore.dirPath) setWysiwygProjectDir(projectStore.dirPath);

    cleanupCurrentView();
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
      ...(!isReadOnly ? [keymap.of([{ key: 'Mod-s', run: () => { saveCurrentFile(); return true; } }])] : []),
    ];

    const savedState = getSavedEditorState(tab.id);
    if (savedState) {
      // Restore saved state (preserves undo history) with current extensions
      view = new EditorView({ state: savedState, parent: editorContainer });
    } else {
      const state = createEditorState(tab.content, extensions);
      view = new EditorView({ state, parent: editorContainer });
    }
    registerEditorView(tab.id, view);

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
      view.dispatch({
        effects: highlightMatchCompartment.reconfigure(
          enabled ? highlightSelectionMatches() : []
        ),
      });
    }
  });

  onMount(() => {
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
          if (freshTab?.isDirty && freshTab.content) {
            await commands.registerWriteIgnore(freshTab.filePath);
            const result = await commands.writeFile(freshTab.filePath, freshTab.content);
            if (result.status === 'ok') tabsStore.markSaved(freshTab.id);
          }
        }
      }, autoSaveMinutes * 60 * 1000);
    }

    updateAutoSaveInterval();

    $effect(() => {
      const _minutes = uiStore.editorSettings.autoSaveMinutes;
      updateAutoSaveInterval();
    });

    return () => {
      if (autoSaveIntervalId) clearInterval(autoSaveIntervalId);
      if (statsTimer) clearTimeout(statsTimer);
      cleanupCurrentView();
    };
  });
</script>

<div class="flex flex-col h-full w-full">
  {#if isReadOnly}
    <div class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs" style="background: color-mix(in srgb, var(--novelist-accent) 15%, var(--novelist-bg)); color: var(--novelist-accent); border-bottom: 1px solid var(--novelist-border);">
      <span>Read-only — file is {(readOnlyFileSize / 1024 / 1024).toFixed(1)}MB. Use "Split into Chunks" to edit in smaller files.</span>
      <button
        class="px-2 py-0.5 rounded text-xs cursor-pointer"
        style="background: var(--novelist-accent); color: #fff;"
        onclick={splitIntoChunks}
      >Split into Chunks</button>
    </div>
  {/if}
  <div class="flex-1 min-h-0 w-full" bind:this={editorContainer}></div>
</div>
