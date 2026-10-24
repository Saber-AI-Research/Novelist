import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStructuredTabSaver,
  createTabReloadGate,
  type StructuredSaverTab,
} from '$lib/components/structured-file';

type Tab = StructuredSaverTab & { id: string };

function harness(initial: Tab[]) {
  const tabs = new Map(initial.map((tab) => [tab.id, { ...tab }]));
  const disk = new Map<string, string>();
  const writes: Array<{ path: string; content: string }> = [];
  let beforeWriteResolves: (() => void) | null = null;
  const saver = createStructuredTabSaver({
    getTab: (id) => tabs.get(id),
    async write(path, content) {
      writes.push({ path, content });
      beforeWriteResolves?.();
      disk.set(path, content);
      return true;
    },
    markSaved: (id) => {
      const tab = tabs.get(id);
      if (tab) tab.isDirty = false;
    },
  });
  /** Simulates an editor edit: the tab store gets the text at once. */
  function edit(id: string, content: string) {
    const tab = tabs.get(id)!;
    tab.content = content;
    tab.isDirty = true;
    saver.schedule(id);
  }
  return {
    tabs,
    disk,
    writes,
    saver,
    edit,
    onWrite(fn: () => void) { beforeWriteResolves = fn; },
  };
}

describe('createStructuredTabSaver', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('flush writes the pending edit instead of dropping it (editor unmount within 400 ms)', async () => {
    const h = harness([{ id: 'a', filePath: '/p/a.kanban', content: '{}', isDirty: false }]);
    h.edit('a', '{"columns":[]}');
    await h.saver.flush();
    expect(h.disk.get('/p/a.kanban')).toBe('{"columns":[]}');
    expect(h.tabs.get('a')!.isDirty).toBe(false);
    // The debounce timer is gone, so nothing writes a second time later.
    await vi.runAllTimersAsync();
    expect(h.writes).toHaveLength(1);
  });

  it('keeps one pending save per tab: editing tab B does not cancel tab A', async () => {
    const h = harness([
      { id: 'a', filePath: '/p/a.canvas', content: '', isDirty: false },
      { id: 'b', filePath: '/p/b.canvas', content: '', isDirty: false },
    ]);
    h.edit('a', 'A1');
    await vi.advanceTimersByTimeAsync(200);
    h.edit('b', 'B1');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.disk.get('/p/a.canvas')).toBe('A1');
    expect(h.disk.get('/p/b.canvas')).toBe('B1');
  });

  it('debounces repeated edits of one tab into one write of the latest text', async () => {
    const h = harness([{ id: 'a', filePath: '/p/a.kanban', content: '', isDirty: false }]);
    h.edit('a', 'v1');
    await vi.advanceTimersByTimeAsync(100);
    h.edit('a', 'v2');
    await vi.advanceTimersByTimeAsync(400);
    expect(h.writes).toEqual([{ path: '/p/a.kanban', content: 'v2' }]);
  });

  it('stays dirty when the user edits while the write runs', async () => {
    const h = harness([{ id: 'a', filePath: '/p/a.kanban', content: '', isDirty: false }]);
    h.onWrite(() => {
      const tab = h.tabs.get('a')!;
      tab.content = 'typed during write';
    });
    h.edit('a', 'v1');
    await h.saver.flush();
    expect(h.disk.get('/p/a.kanban')).toBe('v1');
    expect(h.tabs.get('a')!.isDirty).toBe(true);
  });

  it('does not write a tab that was closed or reloaded from disk before the timer fired', async () => {
    const h = harness([
      { id: 'closed', filePath: '/p/c.kanban', content: '', isDirty: false },
      { id: 'reloaded', filePath: '/p/r.kanban', content: '', isDirty: false },
    ]);
    h.edit('closed', 'unsaved');
    h.edit('reloaded', 'stale');
    h.tabs.delete('closed');
    // reloadContent: external text, clean tab.
    Object.assign(h.tabs.get('reloaded')!, { content: 'external', isDirty: false });
    await h.saver.flush();
    expect(h.writes).toEqual([]);
  });
});

describe('createTabReloadGate', () => {
  it('reloads for a new tab, a renamed file and a new on-disk version, but not for edits', () => {
    const shouldReload = createTabReloadGate();
    const tab = { id: 't1', filePath: '/p/board.kanban', version: 0 };
    expect(shouldReload(tab)).toBe(true);
    expect(shouldReload({ ...tab })).toBe(false);
    // reloadContent after a file-watcher change bumps the version.
    expect(shouldReload({ ...tab, version: 1 })).toBe(true);
    expect(shouldReload({ ...tab, version: 1, filePath: '/p/renamed.kanban' })).toBe(true);
    expect(shouldReload({ ...tab, id: 't2', version: 1, filePath: '/p/renamed.kanban' })).toBe(true);
    expect(shouldReload(undefined)).toBe(true);
    expect(shouldReload(undefined)).toBe(false);
  });
});
