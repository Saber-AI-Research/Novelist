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
  import { registerProjectSwitchFlushProvider } from '$lib/services/project-switch-coordinator';
  import { handleDraftSaveFireAndForget, writeDraftNoteStrict } from '$lib/services/draft-notes';
  import { pathStartsWithChild } from '$lib/utils/path';
  import { DraftNoteSaver } from './draft-note-saver';

  interface Props {
    filePath: string;
  }

  let { filePath }: Props = $props();
  let container: HTMLDivElement;
  let view: EditorView | null = null;
  let loadingFilePath = '';
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let isDirty = $state(false);
  const saver = new DraftNoteSaver({
    write: (target, content) => writeDraftNoteStrict(target.projectDir, target.filePath, content),
    getContent: () => view?.state.doc.toString() ?? null,
    onDirtyChange: (dirty) => { isDirty = dirty; },
  });

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
          saver.markDirty();
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
    saver.markDirty();
    console.warn(message);
  }

  function saveDraft(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return saver.save();
  }

  async function flushForRename(oldPath: string) {
    const target = saver.target;
    if (!target) return;
    if (target.filePath !== oldPath && !pathStartsWithChild(target.filePath, oldPath)) return;
    await flushDraft();
  }

  async function flushDraft() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await saver.flush();
  }

  async function loadDraft(path: string) {
    const projectDir = projectStore.dirPath;
    if (!projectDir) return;
    loadingFilePath = path;

    // Save the current draft (to its own project and file) before switching.
    if (view && saver.dirty) await saveDraft();

    const result = await commands.readDraftNote(projectDir, path);
    // A newer file or project switch took over while this one was loading.
    if (loadingFilePath !== path || projectStore.dirPath !== projectDir) return;
    const content = result.status === 'ok' && result.data != null ? result.data : '';

    if (view) {
      view.destroy();
      view = null;
    }

    const state = EditorState.create({ doc: content, extensions: createDraftExtensions() });
    view = new EditorView({ state, parent: container });
    saver.setTarget({ projectDir, filePath: path });
  }

  $effect(() => {
    if (filePath && container && filePath !== loadingFilePath) {
      handleDraftSaveFireAndForget(loadDraft(filePath), handleDraftSaveFailure);
    }
  });

  onMount(() => {
    const unregisterRenameFlush = registerRenameFlushProvider(flushForRename);
    // The project store changes `dirPath` before the tabs (and this panel)
    // go away: write the draft into the project it belongs to first.
    const unregisterProjectSwitchFlush = registerProjectSwitchFlushProvider(() => flushDraft());
    return () => {
      unregisterRenameFlush();
      unregisterProjectSwitchFlush();
      if (saveTimer) clearTimeout(saveTimer);
      if (view && saver.dirty) {
        // Fire-and-forget save on unmount; text and target are captured now.
        handleDraftSaveFireAndForget(saver.save(), handleDraftSaveFailure);
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
