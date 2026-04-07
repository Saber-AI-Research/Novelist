<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { keymap } from '@codemirror/view';
  import type { Extension } from '@codemirror/state';
  import { createEditorExtensions, createEditorState } from '$lib/editor/setup';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { projectStore } from '$lib/stores/project.svelte';
  import { commands } from '$lib/ipc/commands';
  import { countWords } from '$lib/utils/wordcount';

  const FILE_SIZE_WYSIWYG_LIMIT = 1024 * 1024; // 1MB

  let wordCount = $state(0);
  let cursorLine = $state(1);
  let cursorCol = $state(1);

  export { wordCount, cursorLine, cursorCol };

  let editorContainer: HTMLDivElement;
  let view: EditorView | null = null;
  let currentTabId: string | null = null;
  let currentTabVersion: number = -1;

  function updateCursorInfo(v: EditorView) {
    const pos = v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    cursorLine = line.number;
    cursorCol = pos - line.from + 1;
  }

  function buildExtensions(): Extension[] {
    const tab = tabsStore.activeTab;
    const fileEntry = projectStore.files.find(f => f.path === tab?.filePath);
    const useWysiwyg = !fileEntry || fileEntry.size < FILE_SIZE_WYSIWYG_LIMIT;

    if (!useWysiwyg) {
      console.log(`[Editor] File size ${fileEntry?.size} bytes exceeds ${FILE_SIZE_WYSIWYG_LIMIT} bytes limit; disabling WYSIWYG mode.`);
    }

    const base = createEditorExtensions({ wysiwyg: useWysiwyg });
    return [
      ...base,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          wordCount = countWords(text);
          const t = tabsStore.activeTab;
          if (t) {
            tabsStore.updateContent(t.id, text);
          }
        }
        if (update.selectionSet || update.docChanged) {
          updateCursorInfo(update.view);
        }
      }),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            saveCurrentFile();
            return true;
          },
        },
      ]),
    ];
  }

  async function saveCurrentFile() {
    const tab = tabsStore.activeTab;
    if (!tab || !tab.isDirty) return;

    await commands.registerWriteIgnore(tab.filePath);
    const result = await commands.writeFile(tab.filePath, tab.content);
    if (result.status === 'ok') {
      tabsStore.markSaved(tab.id);
    } else {
      console.error('Failed to save file:', result.error);
    }
  }

  function loadTab() {
    const tab = tabsStore.activeTab;
    if (!tab) {
      if (view) {
        view.destroy();
        view = null;
        currentTabId = null;
        currentTabVersion = -1;
      }
      return;
    }

    // Rebuild view if tab changed OR version changed (e.g. content reloaded externally)
    if (tab.id === currentTabId && tab.version === currentTabVersion && view) return;

    currentTabId = tab.id;
    currentTabVersion = tab.version;

    if (view) {
      view.destroy();
      view = null;
    }

    const extensions = buildExtensions();
    const state = createEditorState(tab.content, extensions);
    view = new EditorView({ state, parent: editorContainer });
    wordCount = countWords(tab.content);
    updateCursorInfo(view);
  }

  $effect(() => {
    // Track activeTab and its version reactively
    const _tab = tabsStore.activeTab;
    const _version = _tab?.version;
    if (editorContainer) {
      loadTab();
    }
  });

  onMount(() => {
    loadTab();

    const autoSaveInterval = setInterval(async () => {
      for (const tab of tabsStore.tabs) {
        if (tab.isDirty) {
          await commands.registerWriteIgnore(tab.filePath);
          const result = await commands.writeFile(tab.filePath, tab.content);
          if (result.status === 'ok') {
            tabsStore.markSaved(tab.id);
          }
        }
      }
    }, 5 * 60 * 1000); // 5 minutes

    return () => {
      clearInterval(autoSaveInterval);
      if (view) {
        view.destroy();
        view = null;
      }
    };
  });
</script>

<div class="h-full w-full overflow-hidden" bind:this={editorContainer}></div>
