import { commands } from '$lib/ipc/commands';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
import { isScratchFile, nextScratchDisplayName } from '$lib/utils/scratch';
import {
  isPlaceholder,
  isTemplateTitlePlaceholder,
  renameFromH1,
  renameFromTemplateTitleSlot,
  applyH1Substitution,
} from '$lib/utils/placeholder';
import { extractFirstH1 } from '$lib/utils/h1';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
import { t } from '$lib/i18n';
import { pathBasename, pathDirname, pathStartsWithChild } from '$lib/utils/path';
import type { EditorView } from '@codemirror/view';
import type { ViewportManager } from '$lib/editor/viewport';

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
   * Deprecated since v0.2.4 — see spec 2026-05-07-v0.2.4-rename-and-macros.md.
   * Field retained so existing call sites and IPC mocks compile; no longer
   * read by `tryRenameAfterSave`. Slated for removal after v0.2.5 once
   * we confirm no external consumers depend on it.
   */
  justCreated: boolean;
  /**
   * Last H1 we successfully synchronized into the filename (or seeded from
   * disk content at open time). Drives the ongoing H1→filename sync in
   * `tryRenameAfterSave` — see spec 2026-05-12-h1-filename-ongoing-sync-design.md.
   *
   * Empty string means "the file currently has no H1, and that is also what
   * the filename reflects". `null` means "not initialized yet" (treated the
   * same as empty by the sync algorithm).
   */
  lastSyncedH1: string | null;
}

interface OpenTabOptions {
  /** Deprecated since v0.2.4 — kept for call-site compatibility. */
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

export interface ViewportSnapshotMetadata {
  manager: ViewportManager;
}

const viewportSnapshotMetadata = new Map<string, ViewportSnapshotMetadata>();

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
    viewportSnapshotMetadata.delete(tabId);
  }
}

export function registerViewportSnapshotMetadata(
  tabId: string,
  metadata: ViewportSnapshotMetadata,
) {
  viewportModeTabs.add(tabId);
  viewportSnapshotMetadata.set(tabId, { manager: metadata.manager });
}

export function getViewportSnapshotMetadata(
  tabId: string,
): ViewportSnapshotMetadata | undefined {
  return viewportSnapshotMetadata.get(tabId);
}

export function unregisterEditorView(tabId: string) {
  editorViews.delete(tabId);
  viewportModeTabs.delete(tabId);
  viewportSnapshotMetadata.delete(tabId);
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

/** Max editor columns. Beyond this, drag-to-split falls back to "open here". */
const MAX_PANES = 4;
/** Smallest a pane column may be shrunk to (fraction of the row). */
const MIN_PANE_WEIGHT = 0.15;

class TabsStore {
  panes = $state<PaneState[]>([{ id: 'pane-1', tabs: [], activeTabId: null }]);
  activePaneId = $state('pane-1');
  splitActive = $state(false);
  /** Flex weights, index-aligned to `panes`. Column i renders `flex: w 1 0%`. */
  paneSizes = $state<number[]>([1]);
  /** Monotonic counter for minting pane ids beyond pane-1/pane-2. */
  private paneSeq = 1;

  get activePane(): PaneState {
    return this.panes.find(p => p.id === this.activePaneId) || this.panes[0];
  }

  /** Mint a pane id not currently in use (pane-2, pane-3, …). */
  private nextPaneId(): string {
    let id: string;
    do {
      id = `pane-${++this.paneSeq}`;
    } while (this.panes.some(p => p.id === id));
    return id;
  }

  /** Pad/truncate `paneSizes` to match `panes.length` (new columns get 1). */
  private normalizePaneSizes() {
    const next = this.panes.map((_, i) => this.paneSizes[i] ?? 1);
    this.paneSizes = next;
    this.splitActive = this.panes.length > 1;
  }

  /** Resize column `i`, redistributing against neighbor `i+1` (divider drag). */
  setPaneSize(i: number, weight: number) {
    if (i < 0 || i >= this.paneSizes.length) return;
    const next = [...this.paneSizes];
    next[i] = Math.max(MIN_PANE_WEIGHT, weight);
    this.paneSizes = next;
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
      // Collapse to one column: merge every other pane's tabs into pane-1,
      // skipping duplicates by filePath (cleaning up their per-tab state).
      const pane1 = this.panes[0];
      const existingPaths = new Set(pane1.tabs.map(t => t.filePath));
      for (const pane of this.panes.slice(1)) {
        for (const tab of pane.tabs) {
          if (!existingPaths.has(tab.filePath)) {
            pane1.tabs.push(tab);
            existingPaths.add(tab.filePath);
          } else {
            // Mirror unregisterEditorView, plus the saved CM state.
            savedEditorStates.delete(tab.id);
            editorViews.delete(tab.id);
            viewportModeTabs.delete(tab.id);
            viewportSnapshotMetadata.delete(tab.id);
          }
        }
      }
      this.panes = [pane1];
      this.activePaneId = pane1.id;
      this.normalizePaneSizes();
    } else {
      // 2-pane convenience: append the literal `pane-2` column.
      this.panes = [...this.panes, { id: 'pane-2', tabs: [], activeTabId: null }];
      // Seed the 2-pane sizes from the persisted ratio if available later;
      // default to an even split here.
      this.normalizePaneSizes();
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
    const newName = pathBasename(newPath) || newPath;
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === oldPath) {
          tab.filePath = newPath;
          tab.fileName = newName;
        }
      }
    }
  }

  private async syncWatcherAfterPathChange(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    if (this.findAllByPath(oldPath).length === 0) {
      await commands.unregisterOpenFile(oldPath).catch(() => {});
    }
    if (this.findAllByPath(newPath).length > 0) {
      await commands.registerOpenFile(newPath).catch(() => {});
    }
  }

  /**
   * Re-point all open tabs for one file path and keep the backend watcher in
   * sync. Use this after an actual filesystem rename/move.
   */
  async retargetOpenPath(
    oldPath: string,
    newPath: string,
    options: { broadcast?: boolean } = {},
  ): Promise<number> {
    const count = this.findAllByPath(oldPath).length;
    if (count > 0) {
      this.updatePath(oldPath, newPath);
      await this.syncWatcherAfterPathChange(oldPath, newPath);
    }
    if (options.broadcast) {
      await commands.broadcastFileRenamed(oldPath, newPath).catch(() => {});
    }
    return count;
  }

  /**
   * Re-point a single tab, preserving other tabs that still reference the old
   * path. Use this for Save As flows where the old file remains on disk.
   */
  async retargetTabPath(tabId: string, newPath: string): Promise<boolean> {
    const tab = this.allTabs.find(t => t.id === tabId);
    if (!tab) return false;
    const oldPath = tab.filePath;
    this.updateFilePath(tabId, newPath);
    await this.syncWatcherAfterPathChange(oldPath, newPath);
    return true;
  }

  /**
   * Re-point any open tab under a renamed/moved file or folder root. The
   * broadcast payload stays at the root path so other windows can apply the
   * same prefix transform.
   */
  async retargetOpenPathTree(
    oldRoot: string,
    newRoot: string,
    options: { broadcast?: boolean } = {},
  ): Promise<number> {
    const changes = new Map<string, string>();
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === oldRoot) {
          changes.set(tab.filePath, newRoot);
        } else if (pathStartsWithChild(tab.filePath, oldRoot)) {
          changes.set(tab.filePath, newRoot + tab.filePath.slice(oldRoot.length));
        }
      }
    }

    for (const [oldPath, newPath] of changes) {
      this.updatePath(oldPath, newPath);
      await this.syncWatcherAfterPathChange(oldPath, newPath);
    }
    if (options.broadcast) {
      await commands.broadcastFileRenamed(oldRoot, newRoot).catch(() => {});
    }
    return changes.size;
  }

  /**
   * Post-write hook: keep the filename in sync with the file's H1 heading.
   * Returns the new path (== old path if no rename). Safe to call after every
   * successful writeFile — both manual Cmd+S and auto-save funnel here.
   *
   * Gated implicitly: the user's new-file template must include `{title}`.
   * Using `{title}` is the user's explicit signal that filenames should
   * follow the H1 heading.
   *
   *  Path A — placeholder first-time rename:
   *    File still matches `isPlaceholder()` and has a non-empty H1.
   *    Uses `renameFromH1`.
   *
   *  Path B — ongoing sync:
   *    File is past the placeholder stage; we compare the just-saved H1
   *    against the per-tab `lastSyncedH1`. If changed and the old H1 still
   *    appears in the current filename, swap that substring for the new H1.
   *    Manually renamed files have no anchor to find, so sync auto-detaches.
   */
  async tryRenameAfterSave(filePath: string, content: string): Promise<string> {
    // NOT the legacy `autoRenameFromH1` checkbox — that setting lost its UI
    // in 1e0ab6e and users with a persisted `false` could never re-enable it.
    // (47bc5f3 accidentally reverted this line to the checkbox; see the
    // docstring above, which always described the template gate.)
    if (!newFileSettings.template.includes('{title}')) return filePath;
    if (isScratchFile(filePath)) return filePath;

    // Find the tab so we can read/update `lastSyncedH1`. Save-from-another-pane
    // is possible; we update every matching tab via `updatePath` after rename.
    const tab = this.findByPath(filePath);
    const oldH1 = tab?.lastSyncedH1 ?? '';
    const newH1 = extractFirstH1(content) ?? '';

    const fileName = pathBasename(filePath) || filePath;
    const parentDir = pathDirname(filePath) || filePath;

    // -------- Path A: placeholder → titled (existing behavior) --------
    // Run this before the `newH1 === oldH1` fast path. A placeholder file
    // opened from disk may already have its H1 seeded into `lastSyncedH1`,
    // but the filename still needs its first H1-driven rename on Cmd+S.
    // Built-in placeholder families (Untitled N, 第N章, …) plus the user
    // template's own rendered placeholder (e.g. 第{N}章-{title} →
    // 第1章-Untitled.md), which the static pattern list can't enumerate.
    if (isPlaceholder(fileName) || isTemplateTitlePlaceholder(fileName, newFileSettings.template)) {
      if (newH1.trim().length === 0) {
        // No H1 yet; nothing to do. Don't update anchor either — let next
        // save with a real H1 fall through here again.
        return filePath;
      }
      const list = await commands.listDirectory(parentDir, null);
      const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];
      const newName = renameFromH1(fileName, newH1, siblings)
        ?? renameFromTemplateTitleSlot(fileName, newH1, newFileSettings.template, siblings);
      if (!newName) {
        // `renameFromH1` returned null (sanitized H1 empty or computed name
        // would equal current). We DID observe an H1; record it so Path B
        // can pick up future changes.
        this.setLastSyncedH1ByPath(filePath, newH1);
        return filePath;
      }
      const result = await commands.renameItem(filePath, newName, true);
      if (result.status !== 'ok') {
        console.warn('Auto-rename failed:', result.error);
        return filePath;
      }
      const newPath = result.data;
      await this.retargetOpenPath(filePath, newPath, { broadcast: true });
      this.setLastSyncedH1ByPath(newPath, newH1);
      return newPath;
    }

    if (newH1 === oldH1) return filePath; // no change

    // -------- Path B: ongoing sync --------
    // If we have no anchor (e.g. tab opened before this feature, or file
    // opened from disk with no H1), adopt the current H1 silently so the
    // next *change* has something to compare against.
    if (oldH1.length === 0) {
      this.setLastSyncedH1ByPath(filePath, newH1);
      return filePath;
    }
    // User emptied the H1 — keep filename, do NOT update anchor (so retyping
    // the same H1 short-circuits via `newH1 === oldH1`).
    if (newH1.trim().length === 0) {
      return filePath;
    }

    const list = await commands.listDirectory(parentDir, null);
    const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];
    const newName = applyH1Substitution(fileName, oldH1, newH1, siblings);
    if (!newName) {
      // Manual-rename detach OR sanitize-equal. Update anchor so we don't
      // keep retrying the same comparison every save.
      this.setLastSyncedH1ByPath(filePath, newH1);
      return filePath;
    }

    const result = await commands.renameItem(filePath, newName, true);
    if (result.status !== 'ok') {
      console.warn('Auto-rename failed:', result.error);
      return filePath;
    }
    const newPath = result.data;
    await this.retargetOpenPath(filePath, newPath, { broadcast: true });
    this.setLastSyncedH1ByPath(newPath, newH1);
    return newPath;
  }

  /** Internal helper: update `lastSyncedH1` on every tab matching `filePath`. */
  private setLastSyncedH1ByPath(filePath: string, h1: string) {
    for (const pane of this.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === filePath) tab.lastSyncedH1 = h1;
      }
    }
  }

  openTab(filePath: string, content: string, options: OpenTabOptions = {}) {
    const pane = this.activePane;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) { pane.activeTabId = existing.id; return; }

    const rawName = pathBasename(filePath) || filePath;
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
      lastSyncedH1: extractFirstH1(content) ?? '',
    });
    pane.activeTabId = id;
  }

  /** Open a tab in a specific pane (for "Open in Other Pane"). */
  openTabInPane(paneId: string, filePath: string, content: string, options: OpenTabOptions = {}) {
    const pane = this.panes.find(p => p.id === paneId);
    if (!pane) return;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) { pane.activeTabId = existing.id; return; }

    const fileName = pathBasename(filePath) || filePath;
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
      lastSyncedH1: extractFirstH1(content) ?? '',
    });
    pane.activeTabId = id;
  }

  /** Move a tab from its current pane to a target pane. */
  /** Back-compat append-move (kept for existing callers/tests). */
  moveTabToPane(tabId: string, targetPaneId: string) {
    this.moveTabToPaneAt(tabId, targetPaneId);
  }

  /**
   * Move a tab to another pane, inserting at `insertIndex` (append if omitted).
   * Activates it in the target, fixes the source's active tab, and removes the
   * source pane if it ends up empty.
   */
  moveTabToPaneAt(tabId: string, targetPaneId: string, insertIndex?: number) {
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
    const at = insertIndex === undefined
      ? targetPane.tabs.length
      : Math.max(0, Math.min(insertIndex, targetPane.tabs.length));
    targetPane.tabs.splice(at, 0, tab);
    targetPane.activeTabId = tab.id;
    this.activePaneId = targetPane.id;

    // Fix source pane's active tab
    if (sourcePane.activeTabId === tabId) {
      sourcePane.activeTabId = sourcePane.tabs.length > 0
        ? sourcePane.tabs[Math.min(tabIdx, sourcePane.tabs.length - 1)].id
        : null;
    }
    this.removePaneIfEmpty(sourcePane.id);
  }

  /** Reorder a tab within its own pane to `insertIndex`. */
  reorderTabInPane(paneId: string, tabId: string, insertIndex: number) {
    const pane = this.panes.find(p => p.id === paneId);
    if (!pane) return;
    const from = pane.tabs.findIndex(t => t.id === tabId);
    if (from === -1) return;
    const [tab] = pane.tabs.splice(from, 1);
    const at = Math.max(0, Math.min(insertIndex, pane.tabs.length));
    pane.tabs.splice(at, 0, tab);
    pane.activeTabId = tab.id;
  }

  /**
   * Insert a new empty column at `atIndex` and return its id, or null if at the
   * column cap. Always leaves `activePaneId` on the new pane.
   */
  createPane(atIndex: number): string | null {
    if (this.panes.length >= MAX_PANES) return null;
    const id = this.nextPaneId();
    const at = Math.max(0, Math.min(atIndex, this.panes.length));
    this.panes.splice(at, 0, { id, tabs: [], activeTabId: null });
    // Mirror the splice into paneSizes so weights stay index-aligned.
    const sizes = [...this.paneSizes];
    sizes.splice(at, 0, 1);
    this.paneSizes = sizes;
    this.normalizePaneSizes();
    this.activePaneId = id;
    return id;
  }

  /** Create a new column at `atIndex` and move `fromTabId` into it. */
  createPaneWithTab(atIndex: number, fromTabId: string): string | null {
    const id = this.createPane(atIndex);
    if (!id) return null;
    this.moveTabToPaneAt(fromTabId, id, 0);
    return id;
  }

  /**
   * Remove a pane and reflow columns. Reassigns the active pane to a survivor.
   * Never removes the last pane (resets it to the empty pane-1 shape instead).
   */
  removePane(paneId: string) {
    const idx = this.panes.findIndex(p => p.id === paneId);
    if (idx === -1) return;
    if (this.panes.length === 1) {
      // Keep at least one pane; just empty it.
      this.panes = [{ id: 'pane-1', tabs: [], activeTabId: null }];
      this.activePaneId = 'pane-1';
      this.paneSizes = [1];
      this.normalizePaneSizes();
      return;
    }
    this.panes.splice(idx, 1);
    const sizes = [...this.paneSizes];
    sizes.splice(idx, 1);
    this.paneSizes = sizes;
    if (this.activePaneId === paneId) {
      const neighbor = this.panes[Math.min(idx, this.panes.length - 1)];
      this.activePaneId = neighbor.id;
    }
    this.normalizePaneSizes();
  }

  /** Remove a pane if it has no tabs (but never the sole remaining pane). */
  removePaneIfEmpty(paneId: string) {
    if (this.panes.length <= 1) return;
    const pane = this.panes.find(p => p.id === paneId);
    if (pane && pane.tabs.length === 0) this.removePane(paneId);
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
          if (fresh) {
            if (scratch) {
              const savePath = await saveDialog({
                defaultPath: fresh.fileName,
                filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv'] }],
              });
              if (savePath) {
                await commands.registerWriteIgnore(savePath);
                const result = await commands.writeFile(savePath, fresh.content);
                if (result.status === 'ok') {
                  this.markSaved(fresh.id);
                } else {
                  console.error('[tabs] save before close failed:', result.error);
                  return;
                }
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
              } else {
                console.error('[tabs] save before close failed:', result.error);
                return;
              }
            }
          }
        }
        // choice === 'discard' falls through: close without saving.
      }

      savedEditorStates.delete(id);
      const closedFilePath = tab.filePath;
      pane.tabs.splice(idx, 1);
      if (pane.activeTabId === id) {
        pane.activeTabId = pane.tabs.length > 0 ? pane.tabs[Math.min(idx, pane.tabs.length - 1)].id : null;
      }
      if (!this.findByPath(closedFilePath)) {
        commands.unregisterOpenFile(closedFilePath).catch(() => {});
      }
      // An emptied non-sole column collapses away (VSCode-like).
      this.removePaneIfEmpty(pane.id);
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

  /**
   * Update a tab's file path (used by Save As to re-point a scratch file).
   *
   * Intentionally does NOT reset `lastSyncedH1`. The H1→filename sync's
   * Path B (see `tryRenameAfterSave`) detects "old anchor not in new
   * filename" and self-detaches, which is exactly the correct behavior
   * after a manual rename / Save As.
   */
  updateFilePath(id: string, newPath: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        tab.filePath = newPath;
        tab.fileName = pathBasename(newPath) || newPath;
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
        // External-edit policy: refresh anchor silently so the next save
        // doesn't see a stale `lastSyncedH1` and try to rename based on
        // someone else's edit. See spec §"Edge cases".
        tab.lastSyncedH1 = extractFirstH1(newContent) ?? '';
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
    this.paneSizes = [1];
    this.paneSeq = 1;
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
  async saveAllDirty(): Promise<boolean> {
    let allSaved = true;
    for (const tab of this.dirtyTabs) {
      this.syncFromView(tab.id);
      const fresh = this.findByPath(tab.filePath);
      if (fresh?.isDirty) {
        await commands.registerWriteIgnore(fresh.filePath);
        const result = await commands.writeFile(fresh.filePath, fresh.content);
        if (result.status === 'ok') {
          await this.tryRenameAfterSave(fresh.filePath, fresh.content);
          this.markSaved(fresh.id);
        } else {
          console.error('[tabs] saveAllDirty failed:', result.error);
          allSaved = false;
        }
      }
    }
    return allSaved;
  }
}

export const tabsStore = new TabsStore();
export type { TabState, PaneState };
