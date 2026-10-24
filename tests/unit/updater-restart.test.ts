import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * [regression] "Restart Now" after an update: `relaunch()` bypasses the
 * window's close-requested prompt, so restartForUpdate must ask about dirty
 * tabs itself and save them (from their live editors) before relaunching.
 */

const { relaunch, writeFile } = vi.hoisted(() => ({
  relaunch: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn(), message: vi.fn(), save: vi.fn() }));
vi.mock('$lib/services/update-checker', () => ({
  runUpdateCheck: vi.fn(),
  SKIPPED_VERSION_KEY: 'skipped',
  takeLastAvailableHandle: vi.fn(),
}));
vi.mock('$lib/ipc/commands', () => ({
  commands: {
    writeFile,
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));
vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { restartForUpdate } from '$lib/updater';
import { registerEditorView, tabsStore, unregisterEditorView } from '$lib/stores/tabs.svelte';
import { resolveUnsavedPrompt, unsavedPromptState } from '$lib/composables/unsaved-prompt.svelte';

let view: EditorView | null = null;

function openEdited() {
  tabsStore.openTab('/p/a.md', 'disk');
  const tab = tabsStore.activeTab!;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ state: EditorState.create({ doc: 'disk' }), parent });
  registerEditorView(tab.id, view);
  view.dispatch({ changes: { from: 4, insert: ' 未保存' } });
  tabsStore.markDirty(tab.id);
  return tab;
}

async function restartAnswering(choice: 'save' | 'discard' | 'cancel') {
  const restarting = restartForUpdate();
  await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
  resolveUnsavedPrompt(choice);
  await restarting;
}

beforeEach(() => {
  relaunch.mockResolvedValue(undefined);
  writeFile.mockResolvedValue({ status: 'ok', data: null });
});

afterEach(() => {
  while (unsavedPromptState.pending) resolveUnsavedPrompt('cancel');
  const tab = tabsStore.activeTab;
  if (tab) unregisterEditorView(tab.id);
  view?.destroy();
  view = null;
  tabsStore.closeAll();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[regression] restartForUpdate', () => {
  it('relaunches straight away when nothing is dirty', async () => {
    await restartForUpdate();
    expect(unsavedPromptState.pending).toBeNull();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('Save writes the live editor text, then relaunches', async () => {
    openEdited();
    await restartAnswering('save');
    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'disk 未保存');
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('does not relaunch when saving fails', async () => {
    openEdited();
    writeFile.mockResolvedValueOnce({ status: 'error', error: 'disk full' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await restartAnswering('save');
    expect(relaunch).not.toHaveBeenCalled();
    expect(tabsStore.dirtyTabs).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('Cancel keeps the app running', async () => {
    openEdited();
    await restartAnswering('cancel');
    expect(relaunch).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("Don't Save relaunches without writing", async () => {
    openEdited();
    await restartAnswering('discard');
    expect(writeFile).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
