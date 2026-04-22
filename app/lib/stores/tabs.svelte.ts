import { commands } from '$lib/ipc/commands';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
import { isScratchFile, nextScratchDisplayName } from '$lib/utils/scratch';
import { isPlaceholder, renameFromH1 } from '$lib/utils/placeholder';
import { extractFirstH1 } from '$lib/utils/h1';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
import { t } from '$lib/i18n';
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
  /**
   * True for tabs that were created this session via "New File" / "New Scratch
   * File" / template "new-file". Gates H1-driven auto-rename in
   * `tryRenameAfterSave` so that opening an existing file whose name happens
   * to match a placeholder pattern (e.g. `第1章.md` the user created manually)
   * does NOT get silently renamed on Cmd+S. Cleared after a successful
   * auto-rename (one-shot); stays true across no-op saves so the rename can
   * still fire once the user actually types an H1.
   */
  justCreated: boolean;
}

interface OpenTabOptions {
  /** Opt-in flag for the H1 auto-rename pipeline. See TabState.justCreated. */
  justCreated?: boolean;
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
      // Merge pane-2 tabs into pane-1 (skip duplicates by filePath)
      const pane1 = this.panes[0];
      const pane2 = this.panes.find(p => p.id === 'pane-2');
      if (pane2) {
        const existingPaths = new Set(pane1.tabs.map(t => t.filePath));
        for (const tab of pane2.tabs) {
          if (!existingPaths.has(tab.filePath)) {
            pane1.tabs.push(tab);
          } else {
            // Clean up state for the duplicate tab being discarded
            savedEditorStates.delete(tab.id);
            editorViews.delete(tab.id);
          }
        }
      }
      this.panes = [pane1];
      this.activePaneId = pane1.id;
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

  /** Find ALL tabs across ALL panes with a given file path. */
  findAllByPath(filePath: string): TabState[] {
    const result: TabState[] = [];
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === filePath) result.push(tab);
      }
    }
    return result;
  }

  /** Update filePath and fileName for ALL tabs across ALL panes that match `oldPath`. */
  updatePath(oldPath: string, newPath: string) {
    const newName = newPath.split('/').pop() || newPath;
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === oldPath) {
          tab.filePath = newPath;
          tab.fileName = newName;
        }
      }
    }
  }

  /**
   * Post-write hook: if the file is a placeholder and its content has an H1,
   * rename the file to match. Returns the new path (== old path if no rename).
   * Safe to call after every successful writeFile.
   *
   * Gated on the tab's `justCreated` flag — only fires for tabs created this
   * session via New File / New Scratch / template new-file. Opening an
   * existing file whose name happens to match a placeholder pattern (e.g.
   * a `第1章.md` the user created in Finder) must NOT be auto-renamed, since
   * the user explicitly chose that name. See the TabState.justCreated doc.
   */
  async tryRenameAfterSave(filePath: string, content: string): Promise<string> {
    if (!newFileSettings.autoRenameFromH1) return filePath;

    const tab = this.findByPath(filePath);
    if (!tab || !tab.justCreated) return filePath;

    const fileName = filePath.split('/').pop() || filePath;
    if (!isPlaceholder(fileName)) return filePath;
    const h1 = extractFirstH1(content);
    if (!h1 || h1.trim().length === 0) return filePath;

    const lastSlash = filePath.lastIndexOf('/');
    const parentDir = lastSlash > 0 ? filePath.slice(0, lastSlash) : filePath;

    // Re-list to get current siblings for collision check
    const list = await commands.listDirectory(parentDir, null);
    const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];

    const newName = renameFromH1(fileName, h1, siblings);
    if (!newName || newName === fileName) return filePath;

    const result = await commands.renameItem(filePath, newName, true);
    if (result.status !== 'ok') {
      console.warn('Auto-rename failed:', result.error);
      return filePath;
    }
    const newPath = result.data;
    this.updatePath(filePath, newPath);
    // Consume the one-shot: after a successful rename the tab is no longer
    // a freshly-created placeholder. Future saves go through the normal path.
    for (const pane of this.panes) {
      for (const t of pane.tabs) {
        if (t.filePath === newPath) t.justCreated = false;
      }
    }

    // Broadcast to other windows so their tabs/sidebar can update.
    await commands.broadcastFileRenamed(filePath, newPath).catch(() => {});

    return newPath;
  }

  openTab(filePath: string, content: string, options: OpenTabOptions = {}) {
    const pane = this.activePane;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) { pane.activeTabId = existing.id; return; }

    const rawName = filePath.split('/').pop() || filePath;
    const fileName = isScratchFile(filePath) ? nextScratchDisplayName() : rawName;
    const id = crypto.randomUUID();
    pane.tabs.push({
      id,
      filePath,
      fileName,
      content,
      isDirty: false,
      scrollPosition: 0,
      cursorPosition: 0,
      version: 0,
      justCreated: options.justCreated === true,
    });
    pane.activeTabId = id;
  }

  /** Open a tab in a specific pane (for "Open in Other Pane"). */
  openTabInPane(paneId: string, filePath: string, content: string, options: OpenTabOptions = {}) {
    const pane = this.panes.find(p => p.id === paneId);
    if (!pane) return;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) { pane.activeTabId = existing.id; return; }

    const fileName = filePath.split('/').pop() || filePath;
    const id = crypto.randomUUID();
    pane.tabs.push({
      id,
      filePath,
      fileName,
      content,
      isDirty: false,
      scrollPosition: 0,
      cursorPosition: 0,
      version: 0,
      justCreated: options.justCreated === true,
    });
    pane.activeTabId = id;
  }

  /** Move a tab from its current pane to a target pane. */
  moveTabToPane(tabId: string, targetPaneId: string) {
    let sourcePane: PaneState | undefined;
    let tabIdx = -1;
    for (const pane of this.panes) {
      const idx = pane.tabs.findIndex(t => t.id === tabId);
      if (idx !== -1) { sourcePane = pane; tabIdx = idx; break; }
    }
    if (!sourcePane || tabIdx === -1) return;
    const targetPane = this.panes.find(p => p.id === targetPaneId);
    if (!targetPane || targetPane.id === sourcePane.id) return;

    const [tab] = sourcePane.tabs.splice(tabIdx, 1);
    targetPane.tabs.push(tab);
    targetPane.activeTabId = tab.id;

    // Fix source pane's active tab
    if (sourcePane.activeTabId === tabId) {
      sourcePane.activeTabId = sourcePane.tabs.length > 0
        ? sourcePane.tabs[Math.min(tabIdx, sourcePane.tabs.length - 1)].id
        : null;
    }
  }

  async closeTab(id: string) {
    // Find which pane contains this tab
    for (const pane of this.panes) {
      const idx = pane.tabs.findIndex(t => t.id === id);
      if (idx === -1) continue;
      const tab = pane.tabs[idx];

      // Prompt for unsaved changes (Save / Don't Save / Cancel)
      if (tab.isDirty) {
        const scratch = isScratchFile(tab.filePath);
        const choice = await confirmUnsavedChanges({
          fileNames: tab.fileName,
          saveLabel: scratch ? t('dialog.saveAs') : t('dialog.save'),
        });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          this.syncFromView(tab.id);
          const fresh = this.findByPath(tab.filePath);
          if (fresh?.content) {
            if (scratch) {
              const savePath = await saveDialog({
                defaultPath: fresh.fileName,
                filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv'] }],
              });
              if (savePath) {
                await commands.registerWriteIgnore(savePath);
                const result = await commands.writeFile(savePath, fresh.content);
                if (result.status === 'ok') this.markSaved(fresh.id);
              } else {
                // User cancelled the Save-As native picker — abort the close.
                return;
              }
            } else {
              await commands.registerWriteIgnore(fresh.filePath);
              const result = await commands.writeFile(fresh.filePath, fresh.content);
              if (result.status === 'ok') {
                await this.tryRenameAfterSave(fresh.filePath, fresh.content);
                this.markSaved(fresh.id);
              }
            }
          }
        }
        // choice === 'discard' falls through: close without saving.
      }

      commands.unregisterOpenFile(tab.filePath).catch(() => {});
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

  /**
   * Cycle the active pane's active tab by `delta` (+1 next, -1 previous).
   * Wraps around at both ends. No-op if the pane has 0 or 1 tabs.
   */
  cycleActiveTab(delta: number) {
    const pane = this.activePane;
    if (pane.tabs.length < 2) return;
    const currentIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId);
    const base = currentIdx === -1 ? 0 : currentIdx;
    const len = pane.tabs.length;
    const nextIdx = ((base + delta) % len + len) % len;
    pane.activeTabId = pane.tabs[nextIdx].id;
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
   * Only marks the tab dirty if the content actually changed.
   */
  syncFromView(id: string) {
    const content = getEditorContent(id);
    if (content === null) return;
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        if (tab.content !== content) {
          tab.content = content;
          tab.isDirty = true;
        }
        return;
      }
    }
  }

  markSaved(id: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) { tab.isDirty = false; return; }
    }
  }

  /** Update a tab's file path (used by Save As to re-point a scratch file). */
  updateFilePath(id: string, newPath: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        tab.filePath = newPath;
        tab.fileName = newPath.split('/').pop() || newPath;
        return;
      }
    }
  }

  /** Mark all tabs with the given file path as saved (used after cross-pane sync saves). */
  markSavedByPath(filePath: string) {
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === filePath) tab.isDirty = false;
      }
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
        if (result.status === 'ok') {
          await this.tryRenameAfterSave(fresh.filePath, fresh.content);
          this.markSaved(fresh.id);
        }
      }
    }
  }
}

export const tabsStore = new TabsStore();
export type { TabState, PaneState };
