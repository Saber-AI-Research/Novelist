import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] createCloseTab — close-tab pipeline with a guard against
 * double-fire from Cmd+W and the native onCloseRequested listener.
 */

const { destroy, closeTab, tabsState, projectState, projectClose } = vi.hoisted(() => {
  const destroy = vi.fn();
  const closeTab = vi.fn();
  const tabsState = {
    activeTab: null as null | { id: string; fileName: string; isDirty: boolean },
  };
  const projectState = {
    singleFileMode: false,
    dirPath: null as null | string,
  };
  const projectClose = vi.fn(() => { projectState.singleFileMode = false; });
  return { destroy, closeTab, tabsState, projectState, projectClose };
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ destroy }),
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    get activeTab() { return tabsState.activeTab; },
    closeTab,
  },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get singleFileMode() { return projectState.singleFileMode; },
    get dirPath() { return projectState.dirPath; },
    close: projectClose,
  },
}));

import { createCloseTab } from '$lib/composables/close-tab.svelte';

beforeEach(() => {
  destroy.mockClear();
  closeTab.mockReset();
  projectClose.mockClear();
  tabsState.activeTab = null;
  projectState.singleFileMode = false;
  projectState.dirPath = null;
});

describe('[contract] createCloseTab', () => {
  it('destroys the window when there is no active tab', async () => {
    const api = createCloseTab();
    await api.handleCloseTab();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('closes the active tab without destroying the window when other tabs remain', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    projectState.dirPath = '/proj';
    closeTab.mockImplementation(async () => {
      // After close, a second tab becomes active — stay non-null.
      tabsState.activeTab = { id: 't2', fileName: 'b.md', isDirty: false };
    });
    const api = createCloseTab();
    await api.handleCloseTab();
    expect(closeTab).toHaveBeenCalledWith('t1');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('exits single-file mode when the last tab closes', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    projectState.singleFileMode = true;
    closeTab.mockImplementation(async () => { tabsState.activeTab = null; });
    const api = createCloseTab();
    await api.handleCloseTab();
    expect(projectClose).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys the window when the last tab closes and no project is open', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    // dirPath stays null and singleFileMode stays false.
    closeTab.mockImplementation(async () => { tabsState.activeTab = null; });
    const api = createCloseTab();
    await api.handleCloseTab();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(projectClose).not.toHaveBeenCalled();
  });

  it('keeps the window open when the last tab closes but a project is open', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    projectState.dirPath = '/proj';
    closeTab.mockImplementation(async () => { tabsState.activeTab = null; });
    const api = createCloseTab();
    await api.handleCloseTab();
    expect(destroy).not.toHaveBeenCalled();
    expect(projectClose).not.toHaveBeenCalled();
  });

  it('isClosing is true during the close, false before and after', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    projectState.dirPath = '/proj';
    let isClosingDuring: boolean | null = null;
    closeTab.mockImplementation(async () => {
      isClosingDuring = api.isClosing();
    });
    const api = createCloseTab();
    expect(api.isClosing()).toBe(false);
    await api.handleCloseTab();
    expect(isClosingDuring).toBe(true);
    expect(api.isClosing()).toBe(false);
  });

  it('guards against re-entry while a close is in flight', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    projectState.dirPath = '/proj';
    let secondCall: Promise<void> | null = null;
    closeTab.mockImplementation(async () => {
      // Re-enter while we're holding closingTab=true.
      secondCall = api.handleCloseTab();
    });
    const api = createCloseTab();
    await api.handleCloseTab();
    // Drain the re-entrant call (guaranteed non-null by mockImplementation above).
    await (secondCall as unknown as Promise<void>);
    // Only the first entry called closeTab.
    expect(closeTab).toHaveBeenCalledTimes(1);
  });

  it('clears the closing flag even when closeTab throws', async () => {
    tabsState.activeTab = { id: 't1', fileName: 'a.md', isDirty: false };
    closeTab.mockRejectedValue(new Error('boom'));
    const api = createCloseTab();
    await expect(api.handleCloseTab()).rejects.toThrow('boom');
    expect(api.isClosing()).toBe(false);
  });
});
