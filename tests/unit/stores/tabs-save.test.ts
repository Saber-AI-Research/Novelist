import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * [regression] Saving through the real tabs store with live editor views:
 * a file open in two panes, save-before-close, quit (`saveAllDirty`), edits
 * typed during a write, split collapse, and close-by-stale-index.
 */

const { writeFile, saveDialog } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  saveDialog: vi.fn(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    writeFile,
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveDialog }));

vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import {
  getSavedEditorState,
  registerEditorView,
  saveEditorState,
  tabsStore,
  unregisterEditorView,
} from '$lib/stores/tabs.svelte';
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

/** Drop a tab's editor the way the Editor does when it switches away. */
function unmountView(tabId: string) {
  const index = views.findIndex(v => v.tabId === tabId);
  const { view } = views[index];
  saveEditorState(tabId, view.state);
  tabsStore.syncFromView(tabId);
  unregisterEditorView(tabId);
  view.destroy();
  views.splice(index, 1);
}

/** What the Editor does on a keystroke: change the doc, flag the tab dirty. */
function type(tabId: string, view: EditorView, text: string) {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  tabsStore.markDirty(tabId);
}

function writtenTo(path: string): string[] {
  return writeFile.mock.calls.filter(([p]) => p === path).map(([, content]) => content as string);
}

async function answerPrompt(choice: 'save' | 'discard' | 'cancel') {
  await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
  resolveUnsavedPrompt(choice);
}

/** Pane 1: F in the background behind G. Pane 2: F live. Returns both F tabs. */
function openInTwoPanes() {
  tabsStore.openTab('/p/f.md', 'v1');
  const background = tabsStore.activeTab!;
  tabsStore.openTab('/p/g.md', 'g');
  tabsStore.toggleSplit();
  tabsStore.openTabInPane('pane-2', '/p/f.md', 'v1');
  const live = tabsStore.getPaneActiveTab('pane-2')!;
  const view = mountView(live.id);
  return { background, live, view };
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
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[regression] same file open in two panes', () => {
  it('quit/project switch (saveAllDirty) writes the edits typed in the second pane', async () => {
    const { background, live, view } = openInTwoPanes();
    type(live.id, view, ' 第二段');

    const saved = await tabsStore.saveAllDirty();

    expect(saved).toBe(true);
    expect(writtenTo('/p/f.md')).toEqual(['v1 第二段']);
    expect(tabsStore.findTab(background.id)?.content).toBe('v1 第二段');
    expect(tabsStore.dirtyTabs).toHaveLength(0);
  });

  it('writes the file once when both panes are dirty with the same text', async () => {
    const { background, live, view } = openInTwoPanes();
    tabsStore.activateTab(background.id);
    const backgroundView = mountView(background.id);
    type(live.id, view, ' x');
    type(background.id, backgroundView, ' x');

    expect(await tabsStore.saveAllDirty()).toBe(true);
    expect(writtenTo('/p/f.md')).toEqual(['v1 x']);
  });

  it('closing the second pane tab with Save writes that pane, not the first pane copy', async () => {
    const { background, live, view } = openInTwoPanes();
    type(live.id, view, ' mine');

    const closing = tabsStore.closeTab(live.id);
    await answerPrompt('save');
    await closing;

    expect(writtenTo('/p/f.md')).toEqual(['v1 mine']);
    expect(tabsStore.findTab(live.id)).toBeUndefined();
    const remaining = tabsStore.findTab(background.id)!;
    expect(remaining.content).toBe('v1 mine');
    expect(remaining.isDirty).toBe(false);
  });

  it('a background copy reopens with the text typed in the other pane', () => {
    const { background, live, view } = openInTwoPanes();
    saveEditorState(background.id, EditorState.create({ doc: 'v1' }));
    type(live.id, view, ' newer');

    tabsStore.adoptLiveSiblingContent(background.id);

    const tab = tabsStore.findTab(background.id)!;
    expect(tab.content).toBe('v1 newer');
    expect(tab.isDirty).toBe(true);
    expect(getSavedEditorState(background.id)).toBeUndefined();
  });

  it('a copy without an editor receives the text when the live editor syncs', () => {
    const { background, live, view } = openInTwoPanes();
    saveEditorState(background.id, EditorState.create({ doc: 'v1' }));
    type(live.id, view, ' synced');

    unmountView(live.id);

    const tab = tabsStore.findTab(background.id)!;
    expect(tab.content).toBe('v1 synced');
    expect(tab.isDirty).toBe(true);
    expect(getSavedEditorState(background.id)).toBeUndefined();
  });

  it('opening a file already open with unsaved edits starts from those edits', () => {
    tabsStore.openTab('/p/f.md', 'disk');
    const first = tabsStore.activeTab!;
    const view = mountView(first.id);
    type(first.id, view, ' unsaved');
    tabsStore.toggleSplit();

    tabsStore.openTabInPane('pane-2', '/p/f.md', 'disk');

    const second = tabsStore.getPaneActiveTab('pane-2')!;
    expect(second.content).toBe('disk unsaved');
    expect(second.isDirty).toBe(true);
  });
});

describe('[regression] edits typed while a save is writing', () => {
  it('stay dirty after the write completes', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, ' one');
    const write = Promise.withResolvers<{ status: 'ok'; data: null }>();
    writeFile.mockImplementationOnce(() => write.promise);

    const saving = tabsStore.saveTab(tab.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    type(tab.id, view, ' two');
    write.resolve({ status: 'ok', data: null });

    expect(await saving).toEqual({ status: 'saved', filePath: '/p/a.md' });
    expect(writtenTo('/p/a.md')).toEqual(['base one']);
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
  });

  it('make saveAllDirty report failure so quit does not discard them', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, ' one');
    const write = Promise.withResolvers<{ status: 'ok'; data: null }>();
    writeFile.mockImplementationOnce(() => write.promise);

    const saving = tabsStore.saveAllDirty();
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    type(tab.id, view, ' two');
    write.resolve({ status: 'ok', data: null });

    expect(await saving).toBe(false);
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
  });

  it('a second save of the same file waits for the first write', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, ' one');
    const write = Promise.withResolvers<{ status: 'ok'; data: null }>();
    writeFile.mockImplementationOnce(() => write.promise);

    const first = tabsStore.saveTab(tab.id);
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    type(tab.id, view, ' two');
    const second = tabsStore.saveTab(tab.id);
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);
    write.resolve({ status: 'ok', data: null });
    await Promise.all([first, second]);

    expect(writtenTo('/p/a.md')).toEqual(['base one', 'base one two']);
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(false);
  });
});

describe('[regression] closeTab', () => {
  it('Save writes the live editor text and closes the tab', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, ' 修改');

    const closing = tabsStore.closeTab(tab.id);
    await answerPrompt('save');
    await closing;

    expect(writtenTo('/p/a.md')).toEqual(['base 修改']);
    expect(tabsStore.allTabs).toHaveLength(0);
  });

  it('a failed save keeps the tab open, dirty, and reports the error', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, ' edit');
    writeFile.mockResolvedValueOnce({ status: 'error', error: 'disk full' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const operationError = vi.fn();
    window.addEventListener('novelist-operation-error', operationError);

    const closing = tabsStore.closeTab(tab.id);
    await answerPrompt('save');
    await closing;

    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
    expect(operationError).toHaveBeenCalledTimes(1);
    window.removeEventListener('novelist-operation-error', operationError);
    errorSpy.mockRestore();
  });

  it('Save As on a scratch tab writes the live text to the chosen path', async () => {
    tabsStore.openTab('/cache/novelist_scratch_1700000000000.md', '');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id);
    type(tab.id, view, 'draft');
    saveDialog.mockResolvedValueOnce('/p/kept.md');

    const closing = tabsStore.closeTab(tab.id);
    await answerPrompt('save');
    await closing;

    expect(writtenTo('/p/kept.md')).toEqual(['draft']);
    expect(tabsStore.allTabs).toHaveLength(0);
  });

  it('removes the right tab when another tab closed while the prompt was open', async () => {
    tabsStore.openTab('/p/x.md', 'x');
    tabsStore.openTab('/p/a.md', 'a');
    const dirty = tabsStore.activeTab!;
    tabsStore.markDirty(dirty.id);
    tabsStore.openTab('/p/b.md', 'b');
    const x = tabsStore.findByPath('/p/x.md')!;

    const closing = tabsStore.closeTab(dirty.id);
    await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
    await tabsStore.closeTab(x.id);
    resolveUnsavedPrompt('discard');
    await closing;

    expect(tabsStore.allTabs.map(t => t.filePath)).toEqual(['/p/b.md']);
  });

  it('a second close of a tab whose prompt is open does not prompt again', async () => {
    tabsStore.openTab('/p/a.md', 'a');
    const tab = tabsStore.activeTab!;
    tabsStore.markDirty(tab.id);

    const first = tabsStore.closeTab(tab.id);
    await vi.waitFor(() => expect(unsavedPromptState.pending).not.toBeNull());
    await tabsStore.closeTab(tab.id);
    resolveUnsavedPrompt('cancel');
    await first;

    expect(unsavedPromptState.pending).toBeNull();
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
  });
});

describe('[regression] toggleSplit off with the same file in both panes', () => {
  it('carries a dirty duplicate into the kept background tab', () => {
    const { background, live, view } = openInTwoPanes();
    type(live.id, view, ' unsaved');

    tabsStore.toggleSplit();

    expect(tabsStore.panes).toHaveLength(1);
    expect(tabsStore.findAllByPath('/p/f.md')).toHaveLength(1);
    const kept = tabsStore.findTab(background.id)!;
    expect(kept.content).toBe('v1 unsaved');
    expect(kept.isDirty).toBe(true);
  });

  it('keeps both tabs when their unsaved texts differ', () => {
    const { background, live, view } = openInTwoPanes();
    tabsStore.activateTab(background.id);
    const backgroundView = mountView(background.id);
    type(background.id, backgroundView, ' left');
    type(live.id, view, ' right');

    tabsStore.toggleSplit();

    const texts = tabsStore.findAllByPath('/p/f.md').map(t => t.content);
    expect(texts).toHaveLength(2);
    expect(texts).toContain('v1 right');
  });
});
