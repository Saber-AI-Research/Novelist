import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

/**
 * [regression] createAutoSave against the real tabs store and live editor
 * views, driven by fake timers: every pane's dirty tabs are saved from their
 * own editors, a file with an open conflict dialog is never written, and a
 * failed write is surfaced instead of being dropped silently.
 */

const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn() }));

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    writeFile,
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/i18n', () => ({ t: (key: string) => key }));

import { createAutoSave, type AutoSave } from '$lib/services/autosave';
import { registerEditorView, tabsStore, unregisterEditorView } from '$lib/stores/tabs.svelte';

const views: Array<{ tabId: string; view: EditorView }> = [];
let autoSave: AutoSave | null = null;

function openEdited(path: string, typed: string, paneId?: string) {
  if (paneId) tabsStore.openTabInPane(paneId, path, 'disk');
  else tabsStore.openTab(path, 'disk');
  const tab = paneId ? tabsStore.getPaneActiveTab(paneId)! : tabsStore.activeTab!;
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: 'disk' }), parent });
  registerEditorView(tab.id, view);
  views.push({ tabId: tab.id, view });
  view.dispatch({ changes: { from: 4, insert: typed } });
  tabsStore.markDirty(tab.id);
  return tab;
}

beforeEach(() => {
  vi.useFakeTimers();
  writeFile.mockResolvedValue({ status: 'ok', data: null });
});

afterEach(() => {
  autoSave?.stop();
  autoSave = null;
  vi.useRealTimers();
  for (const { tabId, view } of views) {
    unregisterEditorView(tabId);
    view.destroy();
  }
  views.length = 0;
  tabsStore.closeAll();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('[regression] createAutoSave', () => {
  it('saves the live text of dirty tabs in every pane after the interval', async () => {
    const a = openEdited('/p/a.md', ' 甲');
    tabsStore.toggleSplit();
    const b = openEdited('/p/b.md', ' 乙', 'pane-2');
    autoSave = createAutoSave();
    autoSave.setInterval(2);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'disk 甲');
    expect(writeFile).toHaveBeenCalledWith('/p/b.md', 'disk 乙');
    expect(tabsStore.findTab(a.id)?.isDirty).toBe(false);
    expect(tabsStore.findTab(b.id)?.isDirty).toBe(false);
  });

  it('never writes a file whose conflict dialog is unresolved', async () => {
    const conflicted = openEdited('/p/conflict.md', ' mine');
    openEdited('/p/other.md', ' fine');
    const blocked = new Set(['/p/conflict.md']);
    autoSave = createAutoSave({ isBlocked: path => blocked.has(path) });
    autoSave.setInterval(1);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('/p/other.md', 'disk fine');
    expect(tabsStore.findTab(conflicted.id)?.isDirty).toBe(true);

    blocked.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeFile).toHaveBeenCalledWith('/p/conflict.md', 'disk mine');
  });

  it('skips a tab whose file was deleted on disk', async () => {
    const tab = openEdited('/p/gone.md', ' text');
    tabsStore.markExternalDeleted(tab.id);
    autoSave = createAutoSave();

    await autoSave.runOnce();

    expect(writeFile).not.toHaveBeenCalled();
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
  });

  it('reports a failed write and leaves the tab dirty', async () => {
    const tab = openEdited('/p/a.md', ' edit');
    writeFile.mockResolvedValueOnce({ status: 'error', error: 'disk full' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const operationError = vi.fn();
    window.addEventListener('novelist-operation-error', operationError);
    autoSave = createAutoSave();

    await autoSave.runOnce();

    expect(operationError).toHaveBeenCalledTimes(1);
    expect((operationError.mock.calls[0][0] as CustomEvent).detail.message).toBe('autosave.failed');
    expect(tabsStore.findTab(tab.id)?.isDirty).toBe(true);
    window.removeEventListener('novelist-operation-error', operationError);
    errorSpy.mockRestore();
  });

  it('turns off with a non-positive interval', async () => {
    openEdited('/p/a.md', ' edit');
    autoSave = createAutoSave();
    autoSave.setInterval(1);
    autoSave.setInterval(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(writeFile).not.toHaveBeenCalled();
  });
});
