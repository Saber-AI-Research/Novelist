import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * [contract] tabsStore — split-pane management, tab lifecycle, and the
 * in-memory mutators (markDirty / updateContent / markSaved / reload). These
 * paths are not covered by the existing auto-rename + updatePath suites.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    renameItem: vi.fn(),
    broadcastFileRenamed: vi.fn(),
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    registerOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    writeFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/stores/new-file-settings.svelte', () => ({
  newFileSettings: { template: '第{N}章', autoRenameFromH1: true },
}));

vi.mock('$lib/i18n', () => ({ t: (k: string) => k }));

import {
  tabsStore,
  saveEditorState,
  getSavedEditorState,
  deleteSavedEditorState,
  registerEditorView,
  unregisterEditorView,
  isTabViewportMode,
  registerViewportSnapshotMetadata,
  getViewportSnapshotMetadata,
  getEditorView,
  getEditorContent,
} from '$lib/stores/tabs.svelte';
import { commands } from '$lib/ipc/commands';

beforeEach(() => {
  localStorage.clear();
  tabsStore.closeAll();
  vi.clearAllMocks();
  (commands.registerWriteIgnore as any).mockResolvedValue({ status: 'ok', data: null });
  (commands.registerOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
  (commands.writeFile as any).mockResolvedValue({ status: 'ok', data: null });
  (commands.unregisterOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
  (commands.broadcastFileRenamed as any).mockResolvedValue({ status: 'ok', data: null });
});

describe('[contract] tabsStore.toggleSplit', () => {
  it('adds pane-2 on first toggle', () => {
    tabsStore.toggleSplit();
    expect(tabsStore.panes).toHaveLength(2);
    expect(tabsStore.panes[1].id).toBe('pane-2');
    expect(tabsStore.splitActive).toBe(true);
  });

  it('merges pane-2 tabs back into pane-1 on second toggle (unique by filePath)', () => {
    tabsStore.openTab('/a.md', 'A');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/b.md', 'B');
    tabsStore.toggleSplit();
    expect(tabsStore.panes).toHaveLength(1);
    expect(tabsStore.splitActive).toBe(false);
    const paths = tabsStore.tabs.map(t => t.filePath);
    expect(paths).toEqual(['/a.md', '/b.md']);
  });

  it('discards pane-2 tabs whose filePath already exists in pane-1 (dedup)', () => {
    tabsStore.openTab('/shared.md', 'orig');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/shared.md', 'copy');
    tabsStore.toggleSplit();
    expect(tabsStore.panes).toHaveLength(1);
    expect(tabsStore.findAllByPath('/shared.md')).toHaveLength(1);
  });
});

describe('[contract] tabsStore pane accessors', () => {
  it('setActivePane switches the active pane', () => {
    tabsStore.toggleSplit();
    tabsStore.setActivePane('pane-2');
    expect(tabsStore.activePaneId).toBe('pane-2');
    expect(tabsStore.activePane.id).toBe('pane-2');
  });

  it('getPaneTabs / getPaneActiveTabId / getPaneActiveTab reflect the per-pane state', () => {
    tabsStore.openTab('/one.md', 'one');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/two.md', 'two');

    expect(tabsStore.getPaneTabs('pane-1').map(t => t.filePath)).toEqual(['/one.md']);
    expect(tabsStore.getPaneTabs('pane-2').map(t => t.filePath)).toEqual(['/two.md']);
    expect(tabsStore.getPaneTabs('ghost-pane')).toEqual([]);

    expect(tabsStore.getPaneActiveTabId('pane-2')).toBeTruthy();
    expect(tabsStore.getPaneActiveTabId('ghost-pane')).toBeNull();

    const active2 = tabsStore.getPaneActiveTab('pane-2');
    expect(active2?.filePath).toBe('/two.md');
    expect(tabsStore.getPaneActiveTab('ghost-pane')).toBeUndefined();
  });
});

describe('[contract] tabsStore.openTab + openTabInPane', () => {
  it('activates an existing tab rather than opening a duplicate', () => {
    tabsStore.openTab('/foo.md', 'first');
    const firstId = tabsStore.activeTabId;
    tabsStore.openTab('/foo.md', 'second');
    expect(tabsStore.tabs).toHaveLength(1);
    expect(tabsStore.activeTabId).toBe(firstId);
  });

  it('openTabInPane is a no-op when the pane id is unknown', () => {
    tabsStore.openTabInPane('pane-ghost', '/x.md', 'x');
    expect(tabsStore.tabs).toHaveLength(0);
  });

  it('openTabInPane activates the existing tab inside the target pane', () => {
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/same.md', 'v1');
    const id1 = tabsStore.getPaneActiveTabId('pane-2');
    tabsStore.openTabInPane('pane-2', '/same.md', 'v2');
    expect(tabsStore.getPaneTabs('pane-2')).toHaveLength(1);
    expect(tabsStore.getPaneActiveTabId('pane-2')).toBe(id1);
  });

  it('derives a friendly scratch display name when filePath matches the scratch pattern', () => {
    // isScratchFile checks the path; use the canonical scratch dir shape.
    tabsStore.openTab('/scratch/novelist-scratch-abc123.md', '');
    const tab = tabsStore.tabs[0];
    // Scratch display names are non-empty and shorter than the full path.
    expect(tab.fileName).not.toBe('');
    expect(tab.fileName).not.toContain('/');
  });
});

describe('[contract] tabsStore.activateTab + cycleActiveTab', () => {
  it('activateTab selects the tab and switches active pane to its owner', () => {
    tabsStore.openTab('/a.md', 'a');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/b.md', 'b');
    const bId = tabsStore.getPaneActiveTabId('pane-2')!;

    tabsStore.setActivePane('pane-1');
    tabsStore.activateTab(bId);
    expect(tabsStore.activePaneId).toBe('pane-2');
    expect(tabsStore.activeTabId).toBe(bId);
  });

  it('activateTab is a silent no-op for an unknown tab id', () => {
    tabsStore.openTab('/a.md', '');
    const before = tabsStore.activeTabId;
    tabsStore.activateTab('ghost-id');
    expect(tabsStore.activeTabId).toBe(before);
  });

  it('cycleActiveTab advances / wraps when there are multiple tabs', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.openTab('/b.md', '');
    tabsStore.openTab('/c.md', '');
    const ids = tabsStore.tabs.map(t => t.id);
    // active is currently the last one (c).
    expect(tabsStore.activeTabId).toBe(ids[2]);
    tabsStore.cycleActiveTab(1);
    // wraps to the first.
    expect(tabsStore.activeTabId).toBe(ids[0]);
    tabsStore.cycleActiveTab(-1);
    // wraps back to the last.
    expect(tabsStore.activeTabId).toBe(ids[2]);
  });

  it('cycleActiveTab is a no-op with 0 or 1 tabs', () => {
    expect(() => tabsStore.cycleActiveTab(1)).not.toThrow();
    tabsStore.openTab('/solo.md', '');
    const id = tabsStore.activeTabId;
    tabsStore.cycleActiveTab(1);
    expect(tabsStore.activeTabId).toBe(id);
  });
});

describe('[contract] tabsStore mutators', () => {
  it('markDirty flips isDirty without touching content', () => {
    tabsStore.openTab('/a.md', 'hello');
    const id = tabsStore.activeTabId!;
    tabsStore.markDirty(id);
    expect(tabsStore.tabs[0].isDirty).toBe(true);
    expect(tabsStore.tabs[0].content).toBe('hello');
    // Second call is a no-op (already dirty).
    tabsStore.markDirty(id);
    expect(tabsStore.tabs[0].isDirty).toBe(true);
  });

  it('updateContent sets new content and marks dirty', () => {
    tabsStore.openTab('/a.md', 'old');
    const id = tabsStore.activeTabId!;
    tabsStore.updateContent(id, 'new');
    expect(tabsStore.tabs[0].content).toBe('new');
    expect(tabsStore.tabs[0].isDirty).toBe(true);
  });

  it('markSaved clears isDirty on the matching tab', () => {
    tabsStore.openTab('/a.md', 'body');
    const id = tabsStore.activeTabId!;
    tabsStore.markDirty(id);
    tabsStore.markSaved(id);
    expect(tabsStore.tabs[0].isDirty).toBe(false);
  });

  it('markSavedByPath clears isDirty on every matching path across panes', () => {
    tabsStore.openTab('/shared.md', 'body');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/shared.md', 'body');
    const all = tabsStore.findAllByPath('/shared.md');
    for (const t of all) tabsStore.markDirty(t.id);
    tabsStore.markSavedByPath('/shared.md');
    expect(tabsStore.findAllByPath('/shared.md').every(t => !t.isDirty)).toBe(true);
  });

  it('updateFilePath re-points a single tab and refreshes its fileName', () => {
    tabsStore.openTab('/proj/scratch-1.md', '');
    const id = tabsStore.activeTabId!;
    tabsStore.updateFilePath(id, '/proj/saved.md');
    expect(tabsStore.tabs[0].filePath).toBe('/proj/saved.md');
    expect(tabsStore.tabs[0].fileName).toBe('saved.md');
  });

  it('retargetOpenPath re-registers the watcher for a renamed open file', async () => {
    tabsStore.openTab('/proj/old.md', '');
    await tabsStore.retargetOpenPath('/proj/old.md', '/proj/new.md', { broadcast: true });

    expect(tabsStore.findByPath('/proj/new.md')).toBeTruthy();
    expect(commands.unregisterOpenFile).toHaveBeenCalledWith('/proj/old.md');
    expect(commands.registerOpenFile).toHaveBeenCalledWith('/proj/new.md');
    expect(commands.broadcastFileRenamed).toHaveBeenCalledWith('/proj/old.md', '/proj/new.md');
  });

  it('retargetOpenPathTree re-points descendants and re-registers each open child', async () => {
    tabsStore.openTab('/proj/old/a.md', '');
    tabsStore.openTab('/proj/old/nested/b.md', '');

    await tabsStore.retargetOpenPathTree('/proj/old', '/proj/new');

    expect(tabsStore.findByPath('/proj/new/a.md')).toBeTruthy();
    expect(tabsStore.findByPath('/proj/new/nested/b.md')).toBeTruthy();
    expect(commands.unregisterOpenFile).toHaveBeenCalledWith('/proj/old/a.md');
    expect(commands.registerOpenFile).toHaveBeenCalledWith('/proj/new/a.md');
    expect(commands.unregisterOpenFile).toHaveBeenCalledWith('/proj/old/nested/b.md');
    expect(commands.registerOpenFile).toHaveBeenCalledWith('/proj/new/nested/b.md');
  });

  it('closeTab keeps watcher registration while the same path remains open in another pane', async () => {
    tabsStore.openTab('/proj/shared.md', '');
    const pane1Tab = tabsStore.activeTabId!;
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/proj/shared.md', '');

    await tabsStore.closeTab(pane1Tab);
    expect(commands.unregisterOpenFile).not.toHaveBeenCalled();

    const remaining = tabsStore.findByPath('/proj/shared.md')!;
    await tabsStore.closeTab(remaining.id);
    expect(commands.unregisterOpenFile).toHaveBeenCalledWith('/proj/shared.md');
  });

  it('reloadContent replaces content, clears dirty, and bumps version', () => {
    tabsStore.openTab('/a.md', 'v1');
    const id = tabsStore.activeTabId!;
    tabsStore.markDirty(id);
    const before = tabsStore.tabs[0].version;
    tabsStore.reloadContent(id, 'v2');
    expect(tabsStore.tabs[0].content).toBe('v2');
    expect(tabsStore.tabs[0].isDirty).toBe(false);
    expect(tabsStore.tabs[0].version).toBe(before + 1);
  });
});

describe('[contract] tabsStore.moveTabToPane', () => {
  it('moves a tab from pane-1 to pane-2 and activates it there', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.openTab('/b.md', '');
    tabsStore.toggleSplit();
    const bId = tabsStore.tabs.find(t => t.filePath === '/b.md')!.id;

    tabsStore.moveTabToPane(bId, 'pane-2');

    expect(tabsStore.getPaneTabs('pane-1').map(t => t.filePath)).toEqual(['/a.md']);
    expect(tabsStore.getPaneTabs('pane-2').map(t => t.filePath)).toEqual(['/b.md']);
    expect(tabsStore.getPaneActiveTabId('pane-2')).toBe(bId);
  });

  it('no-op when the target pane does not exist', () => {
    tabsStore.openTab('/a.md', '');
    const id = tabsStore.activeTabId!;
    tabsStore.moveTabToPane(id, 'pane-ghost');
    expect(tabsStore.tabs).toHaveLength(1);
  });

  it('no-op when the target pane is the source pane', () => {
    tabsStore.openTab('/a.md', '');
    const id = tabsStore.activeTabId!;
    tabsStore.moveTabToPane(id, 'pane-1');
    expect(tabsStore.getPaneTabs('pane-1')).toHaveLength(1);
  });

  it('no-op when the tab id is unknown', () => {
    tabsStore.toggleSplit();
    expect(() => tabsStore.moveTabToPane('ghost', 'pane-2')).not.toThrow();
    expect(tabsStore.getPaneTabs('pane-2')).toHaveLength(0);
  });
});

describe('[contract] tabsStore.allTabs / dirtyTabs / saveAllDirty', () => {
  it('allTabs flattens every pane', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/b.md', '');
    expect(tabsStore.allTabs.map(t => t.filePath)).toEqual(['/a.md', '/b.md']);
  });

  it('dirtyTabs filters to only tabs with isDirty=true', () => {
    tabsStore.openTab('/clean.md', 'x');
    tabsStore.openTab('/dirty.md', 'y');
    tabsStore.markDirty(tabsStore.tabs[1].id);
    const dirty = tabsStore.dirtyTabs;
    expect(dirty).toHaveLength(1);
    expect(dirty[0].filePath).toBe('/dirty.md');
  });

  it('saveAllDirty writes every dirty tab and marks them saved', async () => {
    tabsStore.openTab('/a.md', 'A');
    tabsStore.openTab('/b.md', 'B');
    tabsStore.markDirty(tabsStore.tabs[0].id);
    tabsStore.markDirty(tabsStore.tabs[1].id);

    const saved = await tabsStore.saveAllDirty();

    expect(saved).toBe(true);
    expect(commands.writeFile).toHaveBeenCalledTimes(2);
    expect(tabsStore.dirtyTabs).toHaveLength(0);
  });

  it('saveAllDirty skips clean tabs', async () => {
    tabsStore.openTab('/a.md', 'A');
    const saved = await tabsStore.saveAllDirty();
    expect(saved).toBe(true);
    expect(commands.writeFile).not.toHaveBeenCalled();
  });

  it('saveAllDirty writes an empty dirty document instead of skipping it', async () => {
    tabsStore.openTab('/empty.md', 'initial');
    const id = tabsStore.activeTabId!;
    tabsStore.updateContent(id, '');

    const saved = await tabsStore.saveAllDirty();

    expect(saved).toBe(true);
    expect(commands.writeFile).toHaveBeenCalledWith('/empty.md', '');
    expect(tabsStore.dirtyTabs).toHaveLength(0);
  });

  it('saveAllDirty reports false and leaves the tab dirty when a write fails', async () => {
    tabsStore.openTab('/a.md', 'A');
    tabsStore.markDirty(tabsStore.activeTabId!);
    (commands.writeFile as any).mockResolvedValueOnce({ status: 'error', error: 'disk full' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const saved = await tabsStore.saveAllDirty();

    expect(saved).toBe(false);
    expect(tabsStore.dirtyTabs).toHaveLength(1);
    errorSpy.mockRestore();
  });
});

describe('[contract] editorView registry + saved EditorState helpers', () => {
  it('registerEditorView then getEditorView returns the view', () => {
    const fakeView = { state: { doc: { toString: () => 'content' } } } as any;
    registerEditorView('tab-1', fakeView);
    expect(getEditorView('tab-1')).toBe(fakeView);
    expect(isTabViewportMode('tab-1')).toBe(false);
    expect(getEditorContent('tab-1')).toBe('content');
    unregisterEditorView('tab-1');
    expect(getEditorView('tab-1')).toBeUndefined();
  });

  it('marks viewport mode when registered with the flag (and blocks getEditorContent)', () => {
    const fakeView = { state: { doc: { toString: () => 'window' } } } as any;
    registerEditorView('tab-v', fakeView, true);
    expect(isTabViewportMode('tab-v')).toBe(true);
    expect(getViewportSnapshotMetadata('tab-v')).toBeUndefined();
    // Must NOT read from the partial view.
    expect(getEditorContent('tab-v')).toBeNull();
    unregisterEditorView('tab-v');
    expect(isTabViewportMode('tab-v')).toBe(false);
  });

  it('registers complete viewport snapshot metadata and clears it with the view', () => {
    const fakeView = { state: { doc: { toString: () => 'window' } } } as any;
    const manager = { fileId: 'rope-file-1', baseCharOffset: 42 } as any;
    registerEditorView('tab-meta', fakeView);

    registerViewportSnapshotMetadata('tab-meta', {
      fileId: 'rope-file-1',
      manager,
    });

    expect(isTabViewportMode('tab-meta')).toBe(true);
    expect(getViewportSnapshotMetadata('tab-meta')).toEqual({
      fileId: 'rope-file-1',
      manager,
    });

    unregisterEditorView('tab-meta');
    expect(isTabViewportMode('tab-meta')).toBe(false);
    expect(getViewportSnapshotMetadata('tab-meta')).toBeUndefined();
  });

  it('save/get/deleteSavedEditorState roundtrip', () => {
    const fakeState = { phantom: true } as any;
    saveEditorState('tab-s', fakeState);
    expect(getSavedEditorState('tab-s')).toBe(fakeState);
    deleteSavedEditorState('tab-s');
    expect(getSavedEditorState('tab-s')).toBeUndefined();
  });
});

describe('[contract] tabsStore.createPane / removePane (dynamic columns)', () => {
  it('createPane inserts a new column at the index, activates it, and pads sizes', () => {
    const id = tabsStore.createPane(1);
    expect(id).toBe('pane-2');
    expect(tabsStore.panes.map(p => p.id)).toEqual(['pane-1', 'pane-2']);
    expect(tabsStore.paneSizes).toHaveLength(2);
    expect(tabsStore.activePaneId).toBe('pane-2');
    expect(tabsStore.splitActive).toBe(true);
  });

  it('caps the number of columns at 4 (returns null past the cap)', () => {
    expect(tabsStore.createPane(1)).toBe('pane-2');
    expect(tabsStore.createPane(2)).toBe('pane-3');
    expect(tabsStore.createPane(3)).toBe('pane-4');
    expect(tabsStore.createPane(4)).toBeNull();
    expect(tabsStore.panes).toHaveLength(4);
  });

  it('removePane drops the column, reflows sizes, and reassigns the active pane to a neighbor', () => {
    tabsStore.createPane(1); // pane-2 (active)
    tabsStore.createPane(2); // pane-3 (active)
    tabsStore.setActivePane('pane-2');
    tabsStore.removePane('pane-2');
    expect(tabsStore.panes.map(p => p.id)).toEqual(['pane-1', 'pane-3']);
    expect(tabsStore.paneSizes).toHaveLength(2);
    expect(tabsStore.activePaneId).toBe('pane-3');
  });

  it('removePane never removes the last column (empties it instead)', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.removePane('pane-1');
    expect(tabsStore.panes).toHaveLength(1);
    expect(tabsStore.panes[0].id).toBe('pane-1');
  });

  it('removePaneIfEmpty removes an emptied non-sole column but never the only one', () => {
    tabsStore.createPane(1); // pane-2, empty
    tabsStore.removePaneIfEmpty('pane-2');
    expect(tabsStore.panes).toHaveLength(1);
    // Sole empty pane is preserved.
    tabsStore.removePaneIfEmpty('pane-1');
    expect(tabsStore.panes).toHaveLength(1);
  });
});

describe('[contract] tabsStore.moveTabToPaneAt / reorderTabInPane / createPaneWithTab', () => {
  it('moveTabToPaneAt inserts at the given index in the target pane', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.openTab('/b.md', '');
    const id = tabsStore.createPane(1)!; // pane-2
    tabsStore.openTabInPane(id, '/c.md', '');
    tabsStore.openTabInPane(id, '/d.md', '');
    const aId = tabsStore.getPaneTabs('pane-1').find(t => t.filePath === '/a.md')!.id;

    tabsStore.moveTabToPaneAt(aId, id, 1);
    expect(tabsStore.getPaneTabs(id).map(t => t.filePath)).toEqual(['/c.md', '/a.md', '/d.md']);
  });

  it('moveTabToPaneAt auto-removes the source pane when it empties', () => {
    tabsStore.openTab('/a.md', '');
    const id = tabsStore.createPane(1)!; // pane-2
    tabsStore.openTabInPane(id, '/b.md', '');
    const aId = tabsStore.getPaneTabs('pane-1').find(t => t.filePath === '/a.md')!.id;

    tabsStore.moveTabToPaneAt(aId, id);
    // pane-1 emptied → removed; only the (renamed) pane survives.
    expect(tabsStore.panes).toHaveLength(1);
    expect(tabsStore.panes[0].tabs.map(t => t.filePath)).toEqual(['/b.md', '/a.md']);
  });

  it('reorderTabInPane moves a tab to a new index within its pane', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.openTab('/b.md', '');
    tabsStore.openTab('/c.md', '');
    const aId = tabsStore.getPaneTabs('pane-1').find(t => t.filePath === '/a.md')!.id;

    tabsStore.reorderTabInPane('pane-1', aId, 2);
    expect(tabsStore.getPaneTabs('pane-1').map(t => t.filePath)).toEqual(['/b.md', '/c.md', '/a.md']);
  });

  it('createPaneWithTab splits the dragged tab into a fresh column', () => {
    tabsStore.openTab('/a.md', '');
    tabsStore.openTab('/b.md', '');
    const bId = tabsStore.getPaneTabs('pane-1').find(t => t.filePath === '/b.md')!.id;

    const newId = tabsStore.createPaneWithTab(1, bId);
    expect(newId).not.toBeNull();
    expect(tabsStore.getPaneTabs('pane-1').map(t => t.filePath)).toEqual(['/a.md']);
    expect(tabsStore.getPaneTabs(newId!).map(t => t.filePath)).toEqual(['/b.md']);
  });
});
