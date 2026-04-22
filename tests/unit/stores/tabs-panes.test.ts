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
    writeFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/stores/new-file-settings.svelte', () => ({
  newFileSettings: { autoRenameFromH1: false },
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
  getEditorView,
  getEditorContent,
} from '$lib/stores/tabs.svelte';
import { commands } from '$lib/ipc/commands';

beforeEach(() => {
  tabsStore.closeAll();
  vi.clearAllMocks();
  (commands.registerWriteIgnore as any).mockResolvedValue({ status: 'ok', data: null });
  (commands.writeFile as any).mockResolvedValue({ status: 'ok', data: null });
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

    await tabsStore.saveAllDirty();

    expect(commands.writeFile).toHaveBeenCalledTimes(2);
    expect(tabsStore.dirtyTabs).toHaveLength(0);
  });

  it('saveAllDirty skips clean tabs', async () => {
    tabsStore.openTab('/a.md', 'A');
    await tabsStore.saveAllDirty();
    expect(commands.writeFile).not.toHaveBeenCalled();
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
    // Must NOT read from the partial view.
    expect(getEditorContent('tab-v')).toBeNull();
    unregisterEditorView('tab-v');
    expect(isTabViewportMode('tab-v')).toBe(false);
  });

  it('save/get/deleteSavedEditorState roundtrip', () => {
    const fakeState = { phantom: true } as any;
    saveEditorState('tab-s', fakeState);
    expect(getSavedEditorState('tab-s')).toBe(fakeState);
    deleteSavedEditorState('tab-s');
    expect(getSavedEditorState('tab-s')).toBeUndefined();
  });
});
