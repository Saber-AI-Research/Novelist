<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorView, keymap, lineNumbers, drawSelection, placeholder } from '@codemirror/view';
  import { EditorState } from '@codemirror/state';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
  import { commands } from '$lib/ipc/commands';
  import { projectStore } from '$lib/stores/project.svelte';
  import { t } from '$lib/i18n';
  import { registerRenameFlushProvider } from '$lib/services/rename-coordinator';
  import { handleDraftSaveFireAndForget, writeDraftNoteStrict } from '$lib/services/draft-notes';
  import { pathStartsWithChild } from '$lib/utils/path';

  interface Props {
    filePath: string;
  }

  let { filePath }: Props = $props();
  let container: HTMLDivElement;
  let view: EditorView | null = null;
  let currentFilePath = '';
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave: Promise<void> | null = null;
  let queuedSave = false;
  let isDirty = $state(false);

  const draftTheme = EditorView.theme({
    '&': {
      height: '100%',
      fontSize: '13px',
      backgroundColor: 'var(--novelist-editor-bg)',
      color: 'var(--novelist-text)',
    },
    '.cm-content': {
      fontFamily: 'var(--novelist-editor-font)',
      lineHeight: '1.6',
      padding: '12px',
      caretColor: 'var(--novelist-accent)',
    },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--novelist-text-tertiary, var(--novelist-text-secondary))',
      border: 'none',
      fontSize: '11px',
    },
    '.cm-placeholder': {
      color: 'var(--novelist-text-tertiary, var(--novelist-text-secondary))',
      fontStyle: 'italic',
    },
  });

  function createDraftExtensions() {
    return [
      lineNumbers(),
      history(),
      drawSelection(),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.lineWrapping,
      draftTheme,
      placeholder(t('draft.placeholder')),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          isDirty = true;
          scheduleSave();
        }
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        {
          key: 'Mod-s',
          run: () => {
            handleDraftSaveFireAndForget(saveDraft(), handleDraftSaveFailure);
            return true;
          },
        },
      ]),
    ];
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      handleDraftSaveFireAndForget(saveDraft(), handleDraftSaveFailure);
    }, 2000);
  }

  function handleDraftSaveFailure(message: string) {
    isDirty = true;
    console.warn(message);
  }

  function saveDraft(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!view || !projectStore.dirPath || !currentFilePath) return pendingSave ?? Promise.resolve();
    if (pendingSave) {
      queuedSave = true;
      return pendingSave.then(() => {
        if (!queuedSave) return;
        queuedSave = false;
        return saveDraft();
      });
    }
    const content = view.state.doc.toString();
    const savePromise = writeDraftNoteStrict(projectStore.dirPath, currentFilePath, content)
      .then(() => {
        if (view?.state.doc.toString() === content) isDirty = false;
      })
      .catch((error) => {
        isDirty = true;
        throw error;
      })
      .finally(() => {
        if (pendingSave === savePromise) pendingSave = null;
      });
    pendingSave = savePromise;
    return savePromise;
  }

  async function flushForRename(oldPath: string) {
    if (!currentFilePath) return;
    if (currentFilePath !== oldPath && !pathStartsWithChild(currentFilePath, oldPath)) return;
    if (isDirty) await saveDraft();
    if (pendingSave) await pendingSave;
  }

  async function loadDraft(path: string) {
    if (!projectStore.dirPath) return;

    // Save current draft before switching
    if (view && currentFilePath && isDirty) {
      await saveDraft();
    }

    currentFilePath = path;

    const result = await commands.readDraftNote(projectStore.dirPath, path);
    const content = result.status === 'ok' && result.data != null ? result.data : '';

    if (view) {
      view.destroy();
      view = null;
    }

    const state = EditorState.create({ doc: content, extensions: createDraftExtensions() });
    view = new EditorView({ state, parent: container });
    isDirty = false;
  }

  $effect(() => {
    if (filePath && container && filePath !== currentFilePath) {
      handleDraftSaveFireAndForget(loadDraft(filePath), handleDraftSaveFailure);
    }
  });

  onMount(() => {
    const unregisterRenameFlush = registerRenameFlushProvider(flushForRename);
    return () => {
      unregisterRenameFlush();
      if (saveTimer) clearTimeout(saveTimer);
      if (view && isDirty) {
        // Fire-and-forget save on unmount
        handleDraftSaveFireAndForget(saveDraft(), handleDraftSaveFailure);
      }
      if (view) {
        view.destroy();
        view = null;
      }
    };
  });
</script>

<div class="flex flex-col h-full">
  <div class="shrink-0 flex items-center justify-between px-3 py-1.5"
    style="border-bottom: 1px solid var(--novelist-border-subtle, var(--novelist-border)); background: var(--novelist-bg);">
    <span style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--novelist-text-secondary); font-weight: 600;">
      {t('draft.title')}
      {#if isDirty}
        <span style="color: var(--novelist-accent);">●</span>
      {/if}
    </span>
    <span style="font-size: 10px; color: var(--novelist-text-tertiary, var(--novelist-text-secondary)); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
      {filePath.split('/').pop() ?? ''}
    </span>
  </div>
  <div class="flex-1 min-h-0" bind:this={container}></div>
</div>
