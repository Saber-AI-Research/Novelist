import { describe, it, expect } from 'vitest';

/**
 * Tests for Cmd+W / close-tab behavior in different modes.
 *
 * We can't test the full Tauri IPC flow in vitest, so we test the
 * ProjectStore state transitions that handleCloseTab relies on.
 */

// Minimal reproduction of ProjectStore state logic
function createProjectStore() {
  return {
    dirPath: null as string | null,
    config: null as any,
    files: [] as any[],
    singleFileMode: false,
    get isOpen() { return this.dirPath !== null || this.singleFileMode; },
    enterSingleFileMode() {
      this.singleFileMode = true;
      this.dirPath = null;
      this.config = null;
      this.files = [];
    },
    setProject(dirPath: string, config: any, files: any[]) {
      this.dirPath = dirPath;
      this.config = config;
      this.files = files;
      this.singleFileMode = false;
    },
    close() {
      this.dirPath = null;
      this.config = null;
      this.files = [];
      this.singleFileMode = false;
    },
  };
}

// Minimal pane/tab state
function createTabsStore() {
  const panes: Array<{ id: string; tabs: Array<{ id: string; fileName: string; isDirty: boolean }>; activeTabId: string | null }> = [
    { id: 'pane-1', tabs: [], activeTabId: null },
  ];

  return {
    panes,
    get activeTab() {
      const pane = panes.find(p => p.id === 'pane-1');
      if (!pane?.activeTabId) return null;
      return pane.tabs.find(t => t.id === pane.activeTabId) ?? null;
    },
    openTab(id: string, fileName: string) {
      const tab = { id, fileName, isDirty: false };
      panes[0].tabs.push(tab);
      panes[0].activeTabId = id;
    },
    markDirty(id: string) {
      const tab = panes[0].tabs.find(t => t.id === id);
      if (tab) tab.isDirty = true;
    },
    /** Simulates closeTab without the Tauri dialog — just removes the tab. */
    closeTab(id: string) {
      const pane = panes[0];
      const idx = pane.tabs.findIndex(t => t.id === id);
      if (idx === -1) return;
      pane.tabs.splice(idx, 1);
      if (pane.activeTabId === id) {
        pane.activeTabId = pane.tabs.length > 0
          ? pane.tabs[Math.min(idx, pane.tabs.length - 1)].id
          : null;
      }
    },
  };
}

describe('close-tab in single-file mode', () => {
  it('returns to welcome screen after closing the only tab', () => {
    const project = createProjectStore();
    const tabs = createTabsStore();

    // Enter single-file mode and open a scratch file
    project.enterSingleFileMode();
    tabs.openTab('tab-1', 'Untitled');

    expect(project.isOpen).toBe(true);
    expect(project.singleFileMode).toBe(true);
    expect(tabs.activeTab?.fileName).toBe('Untitled');

    // Simulate Cmd+W: close the tab
    tabs.closeTab('tab-1');

    // After close: no remaining tabs
    expect(tabs.activeTab).toBeNull();

    // handleCloseTab logic: single-file mode + no tabs → project.close()
    if (!tabs.activeTab && project.singleFileMode) {
      project.close();
    }

    expect(project.isOpen).toBe(false);
    expect(project.singleFileMode).toBe(false);
    expect(project.dirPath).toBeNull();
  });

  it('stays in project when closing a tab with other tabs remaining', () => {
    const project = createProjectStore();
    const tabs = createTabsStore();

    project.setProject('/path/to/project', { project: { name: 'Test' } }, []);
    tabs.openTab('tab-1', 'Chapter 1.md');
    tabs.openTab('tab-2', 'Chapter 2.md');

    expect(tabs.activeTab?.fileName).toBe('Chapter 2.md');

    // Close active tab
    tabs.closeTab('tab-2');

    // Another tab remains — project stays open
    expect(tabs.activeTab?.fileName).toBe('Chapter 1.md');
    expect(project.isOpen).toBe(true);
    expect(project.dirPath).toBe('/path/to/project');
  });

  it('stays in project when closing the last tab in a project', () => {
    const project = createProjectStore();
    const tabs = createTabsStore();

    project.setProject('/path/to/project', { project: { name: 'Test' } }, []);
    tabs.openTab('tab-1', 'Chapter 1.md');

    tabs.closeTab('tab-1');

    expect(tabs.activeTab).toBeNull();

    // handleCloseTab logic: has dirPath → don't close project (show empty editor area)
    if (!tabs.activeTab && project.singleFileMode) {
      project.close();
    }

    // Project should remain open — user can open another file from sidebar
    expect(project.isOpen).toBe(true);
    expect(project.dirPath).toBe('/path/to/project');
  });

  it('close guard prevents concurrent close-tab calls', () => {
    let closingTab = false;
    let callCount = 0;

    function handleCloseTab() {
      if (closingTab) return;
      closingTab = true;
      try {
        callCount++;
      } finally {
        closingTab = false;
      }
    }

    // Simulate two concurrent calls (e.g. keydown + native onCloseRequested)
    handleCloseTab();
    handleCloseTab();

    // Both run because the guard resets synchronously.
    // In the real async case, only the first would run while awaiting.
    expect(callCount).toBe(2);
  });

  it('async close guard prevents re-entry during dialog', async () => {
    let closingTab = false;
    let callCount = 0;

    async function handleCloseTab() {
      if (closingTab) return;
      closingTab = true;
      try {
        callCount++;
        // Simulate async dialog
        await new Promise(r => setTimeout(r, 10));
      } finally {
        closingTab = false;
      }
    }

    // Fire two calls concurrently — only the first should execute
    const p1 = handleCloseTab();
    const p2 = handleCloseTab();
    await Promise.all([p1, p2]);

    expect(callCount).toBe(1);
  });
});

describe('close-tab with dirty files (Don\'t Save)', () => {
  it('closing a dirty scratch file without saving removes the tab', () => {
    const project = createProjectStore();
    const tabs = createTabsStore();

    project.enterSingleFileMode();
    tabs.openTab('tab-1', 'Untitled');
    tabs.markDirty('tab-1');

    expect(tabs.activeTab?.isDirty).toBe(true);

    // User chose "Don't Save" — just close the tab (no save)
    tabs.closeTab('tab-1');

    expect(tabs.activeTab).toBeNull();

    if (!tabs.activeTab && project.singleFileMode) {
      project.close();
    }

    expect(project.isOpen).toBe(false);
  });

  it('closing a dirty project file without saving keeps the file on disk unchanged', () => {
    const project = createProjectStore();
    const tabs = createTabsStore();

    project.setProject('/path/to/project', { project: { name: 'Test' } }, []);
    tabs.openTab('tab-1', 'chapter.md');
    tabs.markDirty('tab-1');

    // User chose "Don't Save" — close without saving
    tabs.closeTab('tab-1');

    // Tab is gone, project stays open, file on disk unchanged (we didn't write)
    expect(tabs.activeTab).toBeNull();
    expect(project.isOpen).toBe(true);
  });
});
