import { commands } from '$lib/ipc/commands';
import type { EditorView } from '@codemirror/view';

interface TabState {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  isDirty: boolean;
  scrollPosition: number;
  cursorPosition: number;
  version: number;
}

/**
 * Registry mapping tab IDs to live EditorViews.
 * Used to read content directly from CM6 at save time,
 * avoiding expensive doc.toString() on every keystroke.
 */
const editorViews = new Map<string, EditorView>();

/**
 * Tracks which tabs are in viewport mode.
 * For these tabs, syncFromView() must NOT read from CM6 (it only has a window).
 * Save must go through the Rope backend instead.
 */
const viewportModeTabs = new Set<string>();

/**
 * Saved CM6 EditorStates per tab, preserving undo history across tab switches.
 */
const savedEditorStates = new Map<string, import('@codemirror/state').EditorState>();

export function saveEditorState(tabId: string, state: import('@codemirror/state').EditorState) {
  savedEditorStates.set(tabId, state);
}

export function getSavedEditorState(tabId: string): import('@codemirror/state').EditorState | undefined {
  return savedEditorStates.get(tabId);
}

export function deleteSavedEditorState(tabId: string) {
  savedEditorStates.delete(tabId);
}

export function registerEditorView(tabId: string, view: EditorView, isViewportMode = false) {
  editorViews.set(tabId, view);
  if (isViewportMode) {
    viewportModeTabs.add(tabId);
  } else {
    viewportModeTabs.delete(tabId);
  }
}

export function unregisterEditorView(tabId: string) {
  editorViews.delete(tabId);
  viewportModeTabs.delete(tabId);
}

export function isTabViewportMode(tabId: string): boolean {
  return viewportModeTabs.has(tabId);
}

export function getEditorView(tabId: string): EditorView | undefined {
  return editorViews.get(tabId);
}

export function getEditorContent(tabId: string): string | null {
  // NEVER read from CM6 for viewport mode tabs — it only has a window!
  if (viewportModeTabs.has(tabId)) return null;
  const view = editorViews.get(tabId);
  return view ? view.state.doc.toString() : null;
}

interface PaneState {
  id: string;
  tabs: TabState[];
  activeTabId: string | null;
}

class TabsStore {
  panes = $state<PaneState[]>([{ id: 'pane-1', tabs: [], activeTabId: null }]);
  activePaneId = $state('pane-1');
  splitActive = $state(false);

  get activePane(): PaneState {
    return this.panes.find(p => p.id === this.activePaneId) || this.panes[0];
  }

  get activeTab(): TabState | undefined {
    const pane = this.activePane;
    return pane.tabs.find(t => t.id === pane.activeTabId);
  }

  // Backward-compat: returns active pane's tabs
  get tabs(): TabState[] { return this.activePane.tabs; }

  // Backward-compat: returns active pane's activeTabId
  get activeTabId(): string | null { return this.activePane.activeTabId; }

  toggleSplit() {
    if (this.splitActive) {
      this.panes = [this.panes[0]];
      this.activePaneId = this.panes[0].id;
      this.splitActive = false;
    } else {
      this.panes = [...this.panes, { id: 'pane-2', tabs: [], activeTabId: null }];
      this.splitActive = true;
    }
  }

  setActivePane(paneId: string) {
    this.activePaneId = paneId;
  }

  getPaneTabs(paneId: string): TabState[] {
    return this.panes.find(p => p.id === paneId)?.tabs ?? [];
  }

  getPaneActiveTabId(paneId: string): string | null {
    return this.panes.find(p => p.id === paneId)?.activeTabId ?? null;
  }

  getPaneActiveTab(paneId: string): TabState | undefined {
    const pane = this.panes.find(p => p.id === paneId);
    if (!pane) return undefined;
    return pane.tabs.find(t => t.id === pane.activeTabId);
  }

  openTab(filePath: string, content: string) {
    const pane = this.activePane;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) { pane.activeTabId = existing.id; return; }

    const fileName = filePath.split('/').pop() || filePath;
    const id = crypto.randomUUID();
    pane.tabs.push({ id, filePath, fileName, content, isDirty: false, scrollPosition: 0, cursorPosition: 0, version: 0 });
    pane.activeTabId = id;
  }

  closeTab(id: string) {
    // Find which pane contains this tab
    for (const pane of this.panes) {
      const idx = pane.tabs.findIndex(t => t.id === id);
      if (idx === -1) continue;
      const tab = pane.tabs[idx];
      commands.unregisterOpenFile(tab.filePath).catch(err => {
        console.error('Failed to unregister open file:', err);
      });
      savedEditorStates.delete(id);
      pane.tabs.splice(idx, 1);
      if (pane.activeTabId === id) {
        pane.activeTabId = pane.tabs.length > 0 ? pane.tabs[Math.min(idx, pane.tabs.length - 1)].id : null;
      }
      return;
    }
  }

  activateTab(id: string) {
    // Find which pane contains this tab and activate it
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        pane.activeTabId = id;
        this.activePaneId = pane.id;
        return;
      }
    }
  }

  /** Mark tab as dirty without copying content (used during typing). */
  markDirty(id: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab && !tab.isDirty) { tab.isDirty = true; return; }
    }
  }

  updateContent(id: string, content: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) { tab.content = content; tab.isDirty = true; return; }
    }
  }

  /**
   * Sync content from EditorView into tab store.
   * Call before saving or when the view is about to be destroyed.
   */
  syncFromView(id: string) {
    const content = getEditorContent(id);
    if (content !== null) {
      this.updateContent(id, content);
    }
  }

  markSaved(id: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) { tab.isDirty = false; return; }
    }
  }

  reloadContent(id: string, newContent: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        tab.content = newContent;
        tab.isDirty = false;
        tab.version += 1;
        // Clear saved editor state so the tab gets a fresh state with new content
        savedEditorStates.delete(id);
        return;
      }
    }
  }

  // Search ALL panes
  findByPath(filePath: string): TabState | undefined {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.filePath === filePath);
      if (tab) return tab;
    }
    return undefined;
  }

  // Clear ALL panes
  closeAll() {
    this.panes = [{ id: 'pane-1', tabs: [], activeTabId: null }];
    this.activePaneId = 'pane-1';
    this.splitActive = false;
    savedEditorStates.clear();
  }

  // Returns all tabs across all panes (for auto-save)
  get allTabs(): TabState[] {
    return this.panes.flatMap(p => p.tabs);
  }

  /** Returns list of dirty tabs across all panes. */
  get dirtyTabs(): TabState[] {
    return this.allTabs.filter(t => t.isDirty);
  }

  /** Sync all dirty tabs from their EditorViews and save to disk. */
  async saveAllDirty(): Promise<void> {
    for (const tab of this.dirtyTabs) {
      this.syncFromView(tab.id);
      const fresh = this.findByPath(tab.filePath);
      if (fresh?.isDirty && fresh.content) {
        await commands.registerWriteIgnore(fresh.filePath);
        const result = await commands.writeFile(fresh.filePath, fresh.content);
        if (result.status === 'ok') this.markSaved(fresh.id);
      }
    }
  }
}

export const tabsStore = new TabsStore();
export type { TabState, PaneState };
