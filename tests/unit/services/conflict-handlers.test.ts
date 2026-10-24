import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * [regression] Conflict dialog choices against the real tabs store with live
 * editor views. "Keep mine" must write what the editor shows (typing only
 * flags the tab dirty; `tab.content` still holds the last-saved text).
 */

const { registerWriteIgnore, writeFile, readFile } = vi.hoisted(() => ({
  registerWriteIgnore: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    registerWriteIgnore,
    writeFile,
    readFile,
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { handleKeepMine, handleLoadTheirs } from '$lib/conflict-handlers';
import { registerEditorView, tabsStore, unregisterEditorView } from '$lib/stores/tabs.svelte';

const views: Array<{ tabId: string; view: EditorView }> = [];

function mountView(tabId: string, doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  registerEditorView(tabId, view);
  views.push({ tabId, view });
  return view;
}

/** What the Editor does on a keystroke: change the doc, flag the tab dirty. */
function type(tabId: string, view: EditorView, text: string) {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  tabsStore.markDirty(tabId);
}

beforeEach(() => {
  registerWriteIgnore.mockResolvedValue({ status: 'ok', data: null });
  writeFile.mockResolvedValue({ status: 'ok', data: null });
  readFile.mockResolvedValue({ status: 'ok', data: 'their text' });
});

afterEach(() => {
  for (const { tabId, view } of views) {
    unregisterEditorView(tabId);
    view.destroy();
  }
  views.length = 0;
  tabsStore.closeAll();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[regression] handleKeepMine', () => {
  it('writes the live editor text, not the last-saved tab content, then marks the tab clean', async () => {
    tabsStore.openTab('/p/a.md', 'saved text');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id, 'saved text');
    type(tab.id, view, ' + 新的段落');

    await handleKeepMine('/p/a.md');

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'saved text + 新的段落');
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(false);
    expect(tabsStore.findTab(tab.id)?.content).toBe('saved text + 新的段落');
  });

  it('saves the pane holding the edits and gives the other pane the written text', async () => {
    tabsStore.openTab('/p/a.md', 'v1');
    const background = tabsStore.activeTab!;
    tabsStore.openTab('/p/other.md', 'other');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/p/a.md', 'v1');
    const live = tabsStore.getPaneActiveTab('pane-2')!;
    const view = mountView(live.id, 'v1');
    type(live.id, view, ' mine');
    // The watcher reloads clean copies with the external text before the
    // conflict is raised for the dirty one.
    tabsStore.reloadContent(background.id, 'their text');

    await handleKeepMine('/p/a.md');

    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'v1 mine');
    expect(tabsStore.findTab(background.id)?.content).toBe('v1 mine');
    expect(tabsStore.findAllByPath('/p/a.md').every(t => !t.isDirty)).toBe(true);
  });

  it('keeps the tab dirty when typing continues during the write', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id, 'base');
    type(tab.id, view, ' one');
    const write = Promise.withResolvers<{ status: 'ok'; data: null }>();
    writeFile.mockImplementationOnce(() => write.promise);

    const pending = handleKeepMine('/p/a.md');
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
    type(tab.id, view, ' two');
    write.resolve({ status: 'ok', data: null });
    await pending;

    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'base one');
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
  });

  it('leaves the tab dirty and reports the failure when the write fails', async () => {
    tabsStore.openTab('/p/a.md', 'base');
    const tab = tabsStore.activeTab!;
    const view = mountView(tab.id, 'base');
    type(tab.id, view, ' edit');
    writeFile.mockResolvedValueOnce({ status: 'error', error: 'disk full' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const operationError = vi.fn();
    window.addEventListener('novelist-operation-error', operationError);

    await handleKeepMine('/p/a.md');

    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
    expect(operationError).toHaveBeenCalledTimes(1);
    window.removeEventListener('novelist-operation-error', operationError);
    errorSpy.mockRestore();
  });

  it('does nothing when the file is no longer open', async () => {
    await handleKeepMine('/p/closed.md');
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('[regression] handleLoadTheirs', () => {
  it('reloads every tab of the file from disk', async () => {
    tabsStore.openTab('/p/a.md', 'mine');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/p/a.md', 'mine');
    for (const tab of tabsStore.findAllByPath('/p/a.md')) tabsStore.markDirty(tab.id);

    await handleLoadTheirs('/p/a.md');

    expect(readFile).toHaveBeenCalledWith('/p/a.md');
    const tabs = tabsStore.findAllByPath('/p/a.md');
    expect(tabs).toHaveLength(2);
    expect(tabs.every(t => t.content === 'their text' && !t.isDirty)).toBe(true);
  });

  it('keeps unsaved text when the disk read fails', async () => {
    tabsStore.openTab('/p/a.md', 'mine');
    tabsStore.markDirty(tabsStore.activeTab!.id);
    readFile.mockResolvedValueOnce({ status: 'error', error: 'denied' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleLoadTheirs('/p/a.md');

    expect(tabsStore.activeTab?.content).toBe('mine');
    expect(tabsStore.activeTab?.isDirty).toBe(true);
    errorSpy.mockRestore();
  });

  it('does not read the disk when the file is no longer open', async () => {
    await handleLoadTheirs('/p/closed.md');
    expect(readFile).not.toHaveBeenCalled();
  });
});
