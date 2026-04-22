import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] handleKeepMine / handleLoadTheirs — the two user choices in
 * the external-change conflict dialog. Small glue around IPC + tabsStore.
 */

const { registerWriteIgnore, writeFile, readFile, tabsStore, errorSpy } = vi.hoisted(() => {
  const tab = { id: 'tab-1', content: 'my-text' };
  const tabs = {
    _tab: tab as null | { id: string; content: string },
    findByPath: vi.fn((_p: string) => tabs._tab),
    tryRenameAfterSave: vi.fn(async (_p: string, _c: string) => {}),
    markSaved: vi.fn((_id: string) => {}),
    reloadContent: vi.fn((_id: string, _content: string) => {}),
  };
  return {
    registerWriteIgnore: vi.fn(async (_p: string) => {}),
    writeFile: vi.fn(async (_p: string, _c: string) => ({ status: 'ok' as const, data: null })),
    readFile: vi.fn(async (_p: string) => ({ status: 'ok' as const, data: 'disk-text' })),
    tabsStore: tabs,
    errorSpy: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
});

vi.mock('$lib/ipc/commands', () => ({
  commands: { registerWriteIgnore, writeFile, readFile },
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore,
}));

import { handleKeepMine, handleLoadTheirs } from '$lib/conflict-handlers';

beforeEach(() => {
  registerWriteIgnore.mockClear();
  writeFile.mockReset();
  readFile.mockReset();
  tabsStore.findByPath.mockClear();
  tabsStore.tryRenameAfterSave.mockClear();
  tabsStore.markSaved.mockClear();
  tabsStore.reloadContent.mockClear();
  errorSpy.mockClear();
  tabsStore._tab = { id: 'tab-1', content: 'my-text' };
  writeFile.mockResolvedValue({ status: 'ok', data: null });
  readFile.mockResolvedValue({ status: 'ok', data: 'disk-text' });
});

describe('[contract] handleKeepMine', () => {
  it('registers a write-ignore, overwrites disk, renames, and marks saved on success', async () => {
    await handleKeepMine('/p/a.md');
    expect(registerWriteIgnore).toHaveBeenCalledWith('/p/a.md');
    expect(writeFile).toHaveBeenCalledWith('/p/a.md', 'my-text');
    expect(tabsStore.tryRenameAfterSave).toHaveBeenCalledWith('/p/a.md', 'my-text');
    expect(tabsStore.markSaved).toHaveBeenCalledWith('tab-1');
  });

  it('no-ops when the tab is not found (closed since the dialog opened)', async () => {
    tabsStore._tab = null;
    await handleKeepMine('/p/missing.md');
    expect(registerWriteIgnore).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('logs and skips rename/markSaved when writeFile fails', async () => {
    writeFile.mockResolvedValue({ status: 'error', error: 'disk full' } as any);
    await handleKeepMine('/p/a.md');
    expect(errorSpy).toHaveBeenCalledWith('Failed to save (keep mine):', 'disk full');
    expect(tabsStore.tryRenameAfterSave).not.toHaveBeenCalled();
    expect(tabsStore.markSaved).not.toHaveBeenCalled();
  });
});

describe('[contract] handleLoadTheirs', () => {
  it('reloads the tab content from disk on success', async () => {
    await handleLoadTheirs('/p/a.md');
    expect(readFile).toHaveBeenCalledWith('/p/a.md');
    expect(tabsStore.reloadContent).toHaveBeenCalledWith('tab-1', 'disk-text');
  });

  it('no-ops when the tab is not found', async () => {
    tabsStore._tab = null;
    await handleLoadTheirs('/p/gone.md');
    expect(readFile).not.toHaveBeenCalled();
    expect(tabsStore.reloadContent).not.toHaveBeenCalled();
  });

  it('logs and skips reload when readFile fails', async () => {
    readFile.mockResolvedValue({ status: 'error', error: 'denied' } as any);
    await handleLoadTheirs('/p/a.md');
    expect(errorSpy).toHaveBeenCalledWith('Failed to read file (load theirs):', 'denied');
    expect(tabsStore.reloadContent).not.toHaveBeenCalled();
  });
});
