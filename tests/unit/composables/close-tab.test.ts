import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * [regression] createCloseTab (Cmd+W) against the real tabs store: the
 * Save branch writes the live editor text, an empty split column closes the
 * column (never the window), and the double-fire guard holds while the
 * unsaved-changes prompt is open.
 */

const { destroy, writeFile, projectState, projectClose } = vi.hoisted(() => {
  const projectState = { singleFileMode: false, dirPath: null as string | null };
  return {
    destroy: vi.fn(),
    writeFile: vi.fn(),
    projectState,
    projectClose: vi.fn(async () => { projectState.singleFileMode = false; }),
  };
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ destroy }),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    writeFile,
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get singleFileMode() { return projectState.singleFileMode; },
    get dirPath() { return projectState.dirPath; },
    close: projectClose,
    rememberLastOpenFile: () => {},
  },
}));

vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { createCloseTab } from '$lib/composables/close-tab.svelte';
import { registerEditorView, tabsStore, unregisterEditorView } from '$lib/stores/tabs.svelte';
import { resolveUnsavedPrompt, unsavedPromptState } from '$lib/composables/unsaved-prompt.svelte';

const views: Array<{ tabId: string; view: EditorView }> = [];

function mountView(tabId: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const doc = tabsStore.findTab(tabId)!.content;
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  registerEditorView(tabId, view);
  views.push({ tabId, view });
  return view;
}

beforeEach(() => {
  writeFile.mockResolvedValue({ status: 'ok', data: null });
});

afterEach(() => {
  while (unsavedPromptState.pending) resolveUnsavedPrompt('cancel');
  for (const { tabId, view } of views) {
    unregisterEditorView(tabId);
    view.destroy();
  }
  views.length = 0;
  tabsStore.closeAll();
  projectState.singleFileMode = false;
  projectState.dirPath = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[regression] createCloseTab', () => {
  it('Save writes the live editor text before closing the tab', async () => {
    projectState.dirPath = '/p';
    tabsStore.openTab('/p/a.md', 'saved');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    view.dispatch({ changes: { from: 5, insert: ' 新增' } });
    tabsStore.markDirty(tab.id);

    const closing = createCloseTab().handleCloseTab();
    await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
    resolveUnsavedPrompt('save');
    await closing;

    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'saved 新增');
    expect(tabsStore.allTabs).toHaveLength(0);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('closes an empty split column instead of the window, keeping dirty tabs elsewhere', async () => {
    tabsStore.openTab('/p/a.md', 'a');
    tabsStore.markDirty(tabsStore.activeTab!.id);
    tabsStore.toggleSplit();
    tabsStore.setActivePane('pane-2');

    await createCloseTab().handleCloseTab();

    expect(destroy).not.toHaveBeenCalled();
    expect(tabsStore.panes.map(p => p.id)).toEqual(['pane-1']);
    expect(tabsStore.dirtyTabs).toHaveLength(1);
  });

  it('does not destroy the window when the active column empties but another holds tabs', async () => {
    tabsStore.openTab('/p/a.md', 'a');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/p/b.md', 'b');
    tabsStore.setActivePane('pane-2');

    await createCloseTab().handleCloseTab();

    expect(destroy).not.toHaveBeenCalled();
    expect(tabsStore.allTabs.map(t => t.filePath)).toEqual(['/p/a.md']);
  });

  it('destroys the window when there is no tab at all', async () => {
    await createCloseTab().handleCloseTab();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the window when the last tab closes and no project is open', async () => {
    tabsStore.openTab('/p/a.md', 'a');
    await createCloseTab().handleCloseTab();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('exits single-file mode when the last tab closes', async () => {
    projectState.singleFileMode = true;
    tabsStore.openTab('/p/a.md', 'a');
    await createCloseTab().handleCloseTab();
    expect(projectClose).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('keeps the window open when the last tab closes but a project is open', async () => {
    projectState.dirPath = '/p';
    tabsStore.openTab('/p/a.md', 'a');
    await createCloseTab().handleCloseTab();
    expect(destroy).not.toHaveBeenCalled();
    expect(projectClose).not.toHaveBeenCalled();
  });

  it('Cancel keeps the tab and the window', async () => {
    tabsStore.openTab('/p/a.md', 'a');
    tabsStore.markDirty(tabsStore.activeTab!.id);

    const closing = createCloseTab().handleCloseTab();
    await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
    resolveUnsavedPrompt('cancel');
    await closing;

    expect(tabsStore.allTabs).toHaveLength(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('ignores a second Cmd+W while the prompt is open and reports isClosing', async () => {
    projectState.dirPath = '/p';
    tabsStore.openTab('/p/a.md', 'a');
    tabsStore.markDirty(tabsStore.activeTab!.id);
    const api = createCloseTab();
    expect(api.isClosing()).toBe(false);

    const first = api.handleCloseTab();
    await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
    expect(api.isClosing()).toBe(true);
    await api.handleCloseTab();
    resolveUnsavedPrompt('discard');
    await first;

    expect(unsavedPromptState.pending).toBeNull();
    expect(tabsStore.allTabs).toHaveLength(0);
    expect(api.isClosing()).toBe(false);
  });
});
