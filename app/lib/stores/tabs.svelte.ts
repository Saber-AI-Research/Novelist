import { commands } from '$lib/ipc/commands';
import { renameItemAfterSidecarFlush } from '$lib/services/rename-coordinator';
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
import { projectStore } from '$lib/stores/project.svelte';
import { t } from '$lib/i18n';
import { pathBasename, pathDirname, pathStartsWithChild } from '$lib/utils/path';
import { sanitizeFilenameStem } from '$lib/utils/filename';
import {
  loadManagedName,
  migrateManagedNameCachePath,
  updateManagedNameAnchor,
} from '$lib/services/managed-name-persistence';
import { isImeComposing } from '$lib/editor/ime-guard';
import type { EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';

interface TabState {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  isDirty: boolean;
  scrollPosition: number;
  cursorPosition: number;
  version: number;
  externalState: 'present' | 'deleted';
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

interface ManagedRenameOptions {
  reconcileCurrentH1?: boolean;
}

export interface PathRetargetResult {
  changed: number;
  status: 'ok' | 'warning';
  failedOperations: string[];
}

type IpcResult = { status: 'ok' } | { status: 'error'; error: unknown };

/** Outcome of `tabsStore.saveTab`. */
export type SaveTabResult =
  | { status: 'saved'; filePath: string }
  | { status: 'clean' }
  | { status: 'missing' }
  | { status: 'error'; error: string };

/** Surface a failed save in the app's operation-error toast. */
export function reportSaveFailure(fileName: string, error: unknown) {
  console.error(`[tabs] save failed for ${fileName}:`, error);
  window.dispatchEvent(new CustomEvent('novelist-operation-error', {
    detail: { message: t('dialog.saveFailedFor', { name: fileName, error: String(error) }) },
  }));
}

/** Write a document, telling the watcher to ignore the resulting change. */
async function writeDocument(
  filePath: string,
  content: string,
): Promise<{ status: 'ok' } | { status: 'error'; error: string }> {
  try {
    await commands.registerWriteIgnore(filePath);
    const result = await commands.writeFile(filePath, content);
    return result.status === 'ok' ? { status: 'ok' } : { status: 'error', error: String(result.error) };
  } catch (e) {
    return { status: 'error', error: String(e) };
  }
}

async function runPathSyncOperation(
  operation: string,
  run: () => Promise<IpcResult>,
): Promise<string | null> {
  try {
    const result = await run();
    return result.status === 'ok' ? null : operation;
  } catch {
    return operation;
  }
}

function finishPathRetarget(changed: number, failedOperations: string[]): PathRetargetResult {
  if (failedOperations.length > 0) {
    console.warn(
      `Path retarget completed with synchronization failures: ${failedOperations.join(', ')}`,
    );
    window.dispatchEvent(new CustomEvent('novelist-operation-error', {
      detail: { message: t('file.pathSyncFailed') },
    }));
  }
  return {
    changed,
    status: failedOperations.length > 0 ? 'warning' : 'ok',
    failedOperations,
  };
}

/**
 * Registry mapping tab IDs to live EditorViews.
 * Used to read content directly from CM6 at save time,
 * avoiding expensive doc.toString() on every keystroke.
 */
const editorViews = new Map<string, EditorView>();

/**
 * Saved CM6 EditorStates per tab, preserving undo history across tab switches.
 */
const savedEditorStates = new Map<string, EditorState>();

export function saveEditorState(tabId: string, state: EditorState) {
  savedEditorStates.set(tabId, state);
}

export function getSavedEditorState(tabId: string): EditorState | undefined {
  return savedEditorStates.get(tabId);
}

export function deleteSavedEditorState(tabId: string) {
  savedEditorStates.delete(tabId);
}

export function registerEditorView(tabId: string, view: EditorView) {
  editorViews.set(tabId, view);
}

export function unregisterEditorView(tabId: string) {
  editorViews.delete(tabId);
}

export function getEditorView(tabId: string): EditorView | undefined {
  return editorViews.get(tabId);
}

export function getEditorContent(tabId: string): string | null {
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

function bumpNameUntilFree(newName: string, siblings: string[], currentName: string): string {
  const taken = new Set(siblings);
  taken.delete(currentName);
  if (!taken.has(newName)) return newName;
  const dot = newName.lastIndexOf('.');
  const stem = dot > 0 ? newName.slice(0, dot) : newName;
  const ext = dot > 0 ? newName.slice(dot) : '';
  for (let n = 2; n < 10000; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return newName;
}

function fallbackNameFromH1(currentName: string, h1: string, siblings: string[]): string | null {
  const stem = sanitizeAutoNameStem(h1);
  if (stem.length === 0) return null;
  const dot = currentName.lastIndexOf('.');
  const ext = dot > 0 ? currentName.slice(dot) : '';
  const newName = `${stem}${ext}`;
  if (newName === currentName) return null;
  return bumpNameUntilFree(newName, siblings, currentName);
}

function sanitizeAutoNameStem(h1: string): string {
  const stem = sanitizeFilenameStem(h1);
  return /[\p{L}\p{N}]/u.test(stem) ? stem : '';
}

function filenameStem(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

class TabsStore {
  panes = $state<PaneState[]>([{ id: 'pane-1', tabs: [], activeTabId: null }]);
  activePaneId = $state('pane-1');
  splitActive = $state(false);
  /** Flex weights, index-aligned to `panes`. Column i renders `flex: w 1 0%`. */
  paneSizes = $state<number[]>([1]);
  /** Monotonic counter for minting pane ids beyond pane-1/pane-2. */
  private paneSeq = 1;
  /** Tabs whose close (prompt, save) is in flight. */
  private closingTabIds = new Set<string>();
  /** Per-path write chain, so two saves of one file never overlap. */
  private writeChains = new Map<string, Promise<unknown>>();

  private rememberActiveFile() {
    projectStore.rememberLastOpenFile(this.activeTab?.filePath ?? null);
  }

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
      // Collapse to one column: merge every other pane's tabs into pane-1.
      // A duplicate of a file pane-1 already shows is folded into that tab.
      const pane1 = this.panes[0];
      for (const pane of this.panes.slice(1)) {
        for (const tab of pane.tabs) {
          const kept = pane1.tabs.find(t => t.filePath === tab.filePath);
          if (!kept) {
            pane1.tabs.push(tab);
          } else if (!this.foldDuplicateInto(tab, kept)) {
            // Its unsaved text differs from the kept tab: keep both rather
            // than drop edits.
            pane1.tabs.push(tab);
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

  /**
   * Drop `dup`, a same-file duplicate of `kept`, after carrying its edits
   * over. Returns false (and leaves `dup` alone) when `dup` holds unsaved
   * text that differs from `kept`, since dropping it would lose that text.
   */
  private foldDuplicateInto(dup: TabState, kept: TabState): boolean {
    // Syncing copies a live editor's text into same-file tabs that have no
    // editor, so a background `kept` tab receives the duplicate's edits here.
    this.syncFromView(dup.id);
    if (dup.isDirty) {
      if (dup.content !== (getEditorContent(kept.id) ?? kept.content)) return false;
      kept.isDirty = true;
    }
    savedEditorStates.delete(dup.id);
    editorViews.delete(dup.id);
    return true;
  }

  setActivePane(paneId: string) {
    this.activePaneId = paneId;
    this.rememberActiveFile();
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

  private async syncWatcherAfterPathChange(oldPath: string, newPath: string): Promise<string[]> {
    if (oldPath === newPath) return [];
    const failures: string[] = [];
    if (this.findAllByPath(oldPath).length === 0) {
      const failed = await runPathSyncOperation(
        'unregister-open-file',
        () => commands.unregisterOpenFile(oldPath),
      );
      if (failed) failures.push(failed);
    }
    if (this.findAllByPath(newPath).length > 0) {
      const failed = await runPathSyncOperation(
        'register-open-file',
        () => commands.registerOpenFile(newPath),
      );
      if (failed) failures.push(failed);
    }
    return failures;
  }

  /**
   * Re-point all open tabs for one file path and keep the backend watcher in
   * sync. Use this after an actual filesystem rename/move.
   */
  async retargetOpenPath(
    oldPath: string,
    newPath: string,
    options: { broadcast?: boolean } = {},
  ): Promise<PathRetargetResult> {
    const count = this.findAllByPath(oldPath).length;
    const failures: string[] = [];
    if (count > 0) {
      this.updatePath(oldPath, newPath);
      if (projectStore.dirPath) await migrateManagedNameCachePath(projectStore.dirPath, oldPath, newPath);
      failures.push(...await this.syncWatcherAfterPathChange(oldPath, newPath));
    }
    projectStore.retargetWorkspacePath(oldPath, newPath);
    if (options.broadcast) {
      const failed = await runPathSyncOperation(
        'broadcast-file-renamed',
        () => commands.broadcastFileRenamed(oldPath, newPath),
      );
      if (failed) failures.push(failed);
    }
    return finishPathRetarget(count, failures);
  }

  /**
   * Re-point a single tab, preserving other tabs that still reference the old
   * path. Use this for Save As flows where the old file remains on disk.
   */
  async retargetTabPath(tabId: string, newPath: string): Promise<PathRetargetResult> {
    const tab = this.allTabs.find(t => t.id === tabId);
    if (!tab) return finishPathRetarget(0, []);
    const oldPath = tab.filePath;
    this.updateFilePath(tabId, newPath);
    projectStore.retargetWorkspacePath(oldPath, newPath);
    if (projectStore.dirPath) await migrateManagedNameCachePath(projectStore.dirPath, oldPath, newPath);
    const failures = await this.syncWatcherAfterPathChange(oldPath, newPath);
    return finishPathRetarget(1, failures);
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
  ): Promise<PathRetargetResult> {
    const changes = new Map<string, string>();
    const failures: string[] = [];
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
      if (projectStore.dirPath) await migrateManagedNameCachePath(projectStore.dirPath, oldPath, newPath);
      failures.push(...await this.syncWatcherAfterPathChange(oldPath, newPath));
    }
    projectStore.retargetWorkspacePath(oldRoot, newRoot);
    if (options.broadcast) {
      const failed = await runPathSyncOperation(
        'broadcast-file-renamed',
        () => commands.broadcastFileRenamed(oldRoot, newRoot),
      );
      if (failed) failures.push(failed);
    }
    return finishPathRetarget(changes.size, failures);
  }

  /**
   * Post-write hook: keep the filename in sync with the file's H1 heading.
   * Returns the new path (== old path if no rename). Safe to call after every
   * successful writeFile — both manual Cmd+S and auto-save funnel here.
   *
   * Gated by explicit persisted managed-name state: only runs for files whose
   * on-disk sidecar records `status: 'managed'`. Enrollment happens at file
   * creation time via `enableManagedNameForCreatedFile` when the source
   * template contains canonical `{title}`. Manual rename does NOT detach —
   * only the Sidebar `Stop Auto Naming` action (or another explicit call to
   * `detachManagedName`) flips status to `detached`.
   *
   *  Path A — placeholder first-time rename:
   *    File still matches `isPlaceholder()` and has a non-empty H1.
   *    Uses `renameFromH1`.
   *
   *  Path B — ongoing sync:
   *    File is past the placeholder stage; we compare the just-saved H1
   *    against `state.currentH1` (falling back to the tab's `lastSyncedH1`).
   *    If the old H1 anchor is still present in the filename we swap it in
   *    place; if the anchor is absent (e.g. after a manual rename) we fall
   *    back to a sanitized H1 basename plus the existing extension, keeping
   *    the file managed.
   */
  async tryRenameAfterSave(
    filePath: string,
    content: string,
    options: ManagedRenameOptions = {},
  ): Promise<string> {
    if (!projectStore.dirPath) return filePath;
    if (isScratchFile(filePath)) return filePath;

    const loaded = await loadManagedName(projectStore.dirPath, filePath);
    if (loaded.kind !== 'ready' || loaded.state.status !== 'managed') return filePath;

    const state = loaded.state;
    const tab = this.findByPath(filePath);
    const oldH1 = tab?.lastSyncedH1 ?? state.currentH1 ?? '';
    const newH1 = extractFirstH1(content) ?? '';
    const newH1Stem = sanitizeAutoNameStem(newH1);

    const fileName = pathBasename(filePath) || filePath;
    const parentDir = pathDirname(filePath) || filePath;

    // -------- Path A: placeholder → titled (existing behavior) --------
    // Run this before the `newH1 === oldH1` fast path. A placeholder file
    // opened from disk may already have its H1 seeded into `lastSyncedH1`,
    // but the filename still needs its first H1-driven rename on Cmd+S.
    // Built-in placeholder families (Untitled N, 第N章, …) plus the user
    // template's own rendered placeholder (e.g. 第{N}章-{title} →
    // 第1章-Untitled.md), which the static pattern list can't enumerate.
    if (isPlaceholder(fileName) || isTemplateTitlePlaceholder(fileName, state.templateRaw)) {
      if (newH1Stem.length === 0) {
        // No H1 yet; nothing to do. Don't update anchor either — let next
        // save with a real H1 fall through here again.
        return filePath;
      }
      const list = await commands.listDirectory(parentDir, null);
      const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];
      const newName = renameFromH1(fileName, newH1, siblings)
        ?? renameFromTemplateTitleSlot(fileName, newH1, state.templateRaw, siblings);
      if (!newName) {
        if (filenameStem(fileName) === newH1Stem) {
          const written = await updateManagedNameAnchor(projectStore.dirPath, filePath, state, newH1);
          if (written) this.setLastSyncedH1ByPath(filePath, newH1);
        }
        return filePath;
      }
      const result = await renameItemAfterSidecarFlush(projectStore.dirPath, filePath, newName, true);
      if (result.status !== 'ok') {
        console.warn('Auto-rename failed:', result.error);
        return filePath;
      }
      const newPath = result.data.new_path;
      await this.retargetOpenPath(filePath, newPath, { broadcast: false });
      const migrated = await loadManagedName(projectStore.dirPath, newPath);
      const written = await updateManagedNameAnchor(
        projectStore.dirPath,
        newPath,
        migrated.kind === 'ready' ? migrated.state : state,
        newH1,
      );
      if (written) this.setLastSyncedH1ByPath(newPath, newH1);
      return newPath;
    }

    if (newH1 === oldH1 && !options.reconcileCurrentH1) return filePath; // no change

    // -------- Path B: ongoing sync --------
    // If we have no anchor (e.g. tab opened before this feature, or file
    // opened from disk with no H1), adopt the current H1 silently so the
    // next *change* has something to compare against.
    if (oldH1.length === 0) {
      if (newH1Stem.length > 0) {
        const written = await updateManagedNameAnchor(projectStore.dirPath, filePath, state, newH1);
        if (written) this.setLastSyncedH1ByPath(filePath, newH1);
      }
      return filePath;
    }
    // User emptied the H1 — keep filename, do NOT update anchor (so retyping
    // the same H1 short-circuits via `newH1 === oldH1`).
    if (newH1Stem.length === 0) {
      return filePath;
    }

    const list = await commands.listDirectory(parentDir, null);
    const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];
    const newName = applyH1Substitution(fileName, oldH1, newH1, siblings)
      ?? fallbackNameFromH1(fileName, newH1, siblings);
    if (!newName) {
      if (filenameStem(fileName) === newH1Stem) {
        const written = await updateManagedNameAnchor(projectStore.dirPath, filePath, state, newH1);
        if (written) this.setLastSyncedH1ByPath(filePath, newH1);
      }
      return filePath;
    }

    const result = await renameItemAfterSidecarFlush(projectStore.dirPath, filePath, newName, true);
    if (result.status !== 'ok') {
      console.warn('Auto-rename failed:', result.error);
      return filePath;
    }
    const newPath = result.data.new_path;
    await this.retargetOpenPath(filePath, newPath, { broadcast: false });
    const migrated = await loadManagedName(projectStore.dirPath, newPath);
    const written = await updateManagedNameAnchor(
      projectStore.dirPath,
      newPath,
      migrated.kind === 'ready' ? migrated.state : state,
      newH1,
    );
    if (written) this.setLastSyncedH1ByPath(newPath, newH1);
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
    if (existing) {
      pane.activeTabId = existing.id;
      projectStore.rememberLastOpenFile(filePath);
      return;
    }

    const tab = this.createTab(filePath, content, options, () => (
      isScratchFile(filePath) ? nextScratchDisplayName() : pathBasename(filePath) || filePath
    ));
    pane.tabs.push(tab);
    pane.activeTabId = tab.id;
    projectStore.rememberLastOpenFile(filePath);
  }

  /**
   * Build a tab record. When the file is already open in another pane the new
   * tab starts from that tab's live text, dirty flag and name, not the disk
   * `content` the caller read, so the two copies never diverge.
   */
  private createTab(
    filePath: string,
    content: string,
    options: OpenTabOptions,
    displayName: () => string,
  ): TabState {
    const sibling = this.freshestTabForPath(filePath);
    if (sibling) this.syncFromView(sibling.id);
    const text = sibling ? sibling.content : content;
    return {
      id: crypto.randomUUID(),
      filePath,
      fileName: sibling ? sibling.fileName : displayName(),
      content: text,
      isDirty: sibling?.isDirty ?? false,
      scrollPosition: 0,
      cursorPosition: 0,
      version: 0,
      externalState: sibling?.externalState ?? 'present',
      justCreated: options.justCreated === true,
      lastSyncedH1: sibling ? sibling.lastSyncedH1 : extractFirstH1(text) ?? '',
    };
  }

  /** Open a tab in a specific pane (for "Open in Other Pane"). */
  openTabInPane(paneId: string, filePath: string, content: string, options: OpenTabOptions = {}) {
    const pane = this.panes.find(p => p.id === paneId);
    if (!pane) return;
    const existing = pane.tabs.find(t => t.filePath === filePath);
    if (existing) {
      pane.activeTabId = existing.id;
      projectStore.rememberLastOpenFile(filePath);
      return;
    }

    const tab = this.createTab(filePath, content, options, () => pathBasename(filePath) || filePath);
    pane.tabs.push(tab);
    pane.activeTabId = tab.id;
    projectStore.rememberLastOpenFile(filePath);
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
    this.rememberActiveFile();

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
    if (pane.id === this.activePaneId) this.rememberActiveFile();
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
    const tab = this.findTab(id);
    // A second close of the same tab (X click, then Cmd+W behind the prompt)
    // must not queue a second prompt for a tab the first one may remove.
    if (!tab || this.closingTabIds.has(id)) return;
    this.closingTabIds.add(id);
    try {
      // Typing only flags the tab dirty; pick up any text the flag missed.
      this.syncFromView(id);
      if (tab.isDirty) {
        const scratch = isScratchFile(tab.filePath);
        const choice = await confirmUnsavedChanges({
          fileNames: tab.fileName,
          saveLabel: scratch ? t('dialog.saveAs') : t('dialog.save'),
        });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          const saved = scratch
            ? await this.saveScratchBeforeClose(id)
            : await this.saveBeforeClose(id);
          if (!saved) return;
        }
        // choice === 'discard' falls through: close without saving.
      }
      // Prompts and writes awaited above: the tab may have moved or gone.
      this.removeTab(id);
    } finally {
      this.closingTabIds.delete(id);
    }
  }

  /** Save a tab that is about to close. False keeps it open. */
  private async saveBeforeClose(id: string): Promise<boolean> {
    const name = this.findTab(id)?.fileName ?? '';
    const result = await this.saveTab(id);
    if (result.status === 'error') {
      reportSaveFailure(name, result.error);
      return false;
    }
    if (result.status === 'missing') return false;
    // Keys typed while the write ran are not on disk: keep the tab open.
    return this.findTab(id)?.isDirty === false;
  }

  /** Save As for a scratch tab that is about to close. False keeps it open. */
  private async saveScratchBeforeClose(id: string): Promise<boolean> {
    const before = this.findTab(id);
    if (!before) return false;
    const savePath = await saveDialog({
      defaultPath: before.fileName,
      filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv'] }],
    });
    // Cancelling the native picker aborts the close.
    if (!savePath) return false;
    const tab = this.findTab(id);
    if (!tab) return false;
    this.syncFromView(id);
    const content = tab.content;
    const result = await writeDocument(savePath, content);
    if (result.status === 'error') {
      reportSaveFailure(tab.fileName, result.error);
      return false;
    }
    return (getEditorContent(id) ?? tab.content) === content;
  }

  /** Remove a tab by id from whichever pane holds it now. */
  private removeTab(id: string) {
    for (const pane of this.panes) {
      const idx = pane.tabs.findIndex(t => t.id === id);
      if (idx === -1) continue;
      const [tab] = pane.tabs.splice(idx, 1);
      savedEditorStates.delete(id);
      if (pane.activeTabId === id) {
        pane.activeTabId = pane.tabs.length > 0 ? pane.tabs[Math.min(idx, pane.tabs.length - 1)].id : null;
      }
      if (!this.findByPath(tab.filePath)) {
        commands.unregisterOpenFile(tab.filePath).catch(() => {});
      }
      // An emptied non-sole column collapses away (VSCode-like).
      this.removePaneIfEmpty(pane.id);
      this.rememberActiveFile();
      return;
    }
  }

  private async withWriteLock<T>(filePath: string, run: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.writeChains.set(filePath, current);
    try {
      return await current;
    } finally {
      if (this.writeChains.get(filePath) === current) this.writeChains.delete(filePath);
    }
  }

  /**
   * Write one tab's live text to its own file. The text comes from this tab's
   * editor (looked up by id), never from another pane's copy of the file.
   * After the write it runs the H1 rename and `markWritten` for every tab of
   * the file. `force` writes a clean tab too (conflict "Keep mine").
   */
  async saveTab(id: string, options: { force?: boolean } = {}): Promise<SaveTabResult> {
    const initial = this.findTab(id);
    if (!initial) return { status: 'missing' };
    return this.withWriteLock(initial.filePath, async (): Promise<SaveTabResult> => {
      const tab = this.findTab(id);
      if (!tab) return { status: 'missing' };
      this.syncFromView(id);
      if (!tab.isDirty && !options.force) return { status: 'clean' };
      const { filePath, content } = tab;
      const written = await writeDocument(filePath, content);
      if (written.status === 'error') return written;
      let finalPath = filePath;
      try {
        finalPath = await this.tryRenameAfterSave(filePath, content);
      } catch (e) {
        console.warn('[tabs] auto-rename after save failed:', e);
        finalPath = this.findTab(id)?.filePath ?? filePath;
      }
      this.markWritten(finalPath, content);
      return { status: 'saved', filePath: finalPath };
    });
  }

  /**
   * `content` is now on disk at `filePath`. Each tab of that file whose live
   * text equals it becomes clean. A dirty tab whose text differs stays dirty:
   * keys typed during the write are not on disk. A clean tab whose text
   * differs is a stale copy and is reloaded with the written text.
   */
  markWritten(filePath: string, content: string) {
    for (const tab of this.findAllByPath(filePath)) {
      tab.externalState = 'present';
      if ((getEditorContent(tab.id) ?? tab.content) === content) {
        tab.content = content;
        tab.isDirty = false;
      } else if (!tab.isDirty) {
        this.replaceTabContent(tab, content);
      }
    }
  }

  /** Swap in new text, discarding saved editor state so a mounted editor reloads. */
  private replaceTabContent(tab: TabState, content: string) {
    tab.content = content;
    tab.version += 1;
    savedEditorStates.delete(tab.id);
  }

  /**
   * Called before a tab mounts its editor. If the same file is live in
   * another pane's editor, take that text: edits made there never reached
   * this background tab. Drops this tab's saved editor state if it differs.
   */
  adoptLiveSiblingContent(id: string) {
    const tab = this.findTab(id);
    if (!tab) return;
    const live = this.findAllByPath(tab.filePath).find(t => t.id !== id && editorViews.has(t.id));
    const text = live ? getEditorContent(live.id) : null;
    if (!live || text === null) return;
    const saved = savedEditorStates.get(id);
    if ((saved ? saved.doc.toString() : tab.content) === text) return;
    tab.content = text;
    tab.isDirty = live.isDirty;
    savedEditorStates.delete(id);
  }

  /** The tab of `filePath` holding the newest text: one with a live editor, else the first. */
  private freshestTabForPath(filePath: string): TabState | undefined {
    const tabs = this.findAllByPath(filePath);
    return tabs.find(t => editorViews.has(t.id)) ?? tabs[0];
  }

  /** The tab with this id, in whichever pane holds it. */
  findTab(id: string): TabState | undefined {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) return tab;
    }
    return undefined;
  }

  activateTab(id: string) {
    // Find which pane contains this tab and activate it
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        pane.activeTabId = id;
        this.activePaneId = pane.id;
        this.rememberActiveFile();
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
    this.rememberActiveFile();
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
    const tab = this.findTab(id);
    if (!tab) return;
    if (tab.content !== content) {
      tab.content = content;
      tab.isDirty = true;
    }
    // Cross-pane edits only reach same-file tabs that have an editor. Give
    // the others this text so none of them reopens an older copy later.
    for (const sibling of this.findAllByPath(tab.filePath)) {
      if (sibling.id === id || editorViews.has(sibling.id) || sibling.content === content) continue;
      this.replaceTabContent(sibling, content);
      sibling.isDirty = tab.isDirty;
    }
  }

  markSaved(id: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) { tab.isDirty = false; tab.externalState = 'present'; return; }
    }
  }

  /**
   * Update a tab's file path (used by Save As to re-point a scratch file).
   *
   * Intentionally does NOT reset `lastSyncedH1`. Detachment is driven only
   * by explicit persisted managed-name state (see `tryRenameAfterSave`), so
   * a manual rename / Save As keeps managed files managed. When the old H1
   * anchor is absent from the new filename Path B falls back to a sanitized
   * H1 basename; only the Sidebar `Stop Auto Naming` action (or another
   * explicit `detachManagedName` call) flips status to detached.
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

  reloadContent(id: string, newContent: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) {
        tab.content = newContent;
        tab.isDirty = false;
        tab.externalState = 'present';
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

  markExternalDeleted(id: string) {
    for (const pane of this.panes) {
      const tab = pane.tabs.find(t => t.id === id);
      if (tab) { tab.externalState = 'deleted'; return; }
    }
  }

  isTabImeComposing(id: string): boolean {
    const view = editorViews.get(id);
    return view ? isImeComposing(view) : false;
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
  closeAll(options: { preserveWorkspace?: boolean } = {}) {
    this.panes = [{ id: 'pane-1', tabs: [], activeTabId: null }];
    this.activePaneId = 'pane-1';
    this.splitActive = false;
    this.paneSizes = [1];
    this.paneSeq = 1;
    savedEditorStates.clear();
    if (!options.preserveWorkspace) projectStore.rememberLastOpenFile(null);
  }

  // Returns all tabs across all panes (for auto-save)
  get allTabs(): TabState[] {
    return this.panes.flatMap(p => p.tabs);
  }

  /** Returns list of dirty tabs across all panes. */
  get dirtyTabs(): TabState[] {
    return this.allTabs.filter(t => t.isDirty);
  }

  /**
   * Save every dirty tab (quit, project switch, export). Returns false when a
   * write failed or a tab is still dirty afterwards (edited during the save).
   */
  async saveAllDirty(): Promise<boolean> {
    let allSaved = true;
    for (const id of this.dirtyTabs.map(tab => tab.id)) {
      const tab = this.findTab(id);
      // Already written along with a same-file tab in another pane.
      if (!tab?.isDirty) continue;
      const name = tab.fileName;
      const result = await this.saveTab(id);
      if (result.status === 'error') {
        reportSaveFailure(name, result.error);
        allSaved = false;
      }
    }
    return allSaved && this.dirtyTabs.length === 0;
  }

  /**
   * Ask about unsaved tabs before the app exits without the window's
   * close-requested prompt (e.g. `relaunch()`). Resolves true when it is safe
   * to go on: nothing dirty, everything saved, or the user chose Don't Save.
   */
  async promptUnsavedBeforeExit(): Promise<boolean> {
    const dirty = this.dirtyTabs;
    if (dirty.length === 0) return true;
    const choice = await confirmUnsavedChanges({
      fileNames: dirty.map(tab => tab.fileName).join(', '),
      saveLabel: t('dialog.save'),
    });
    if (choice === 'cancel') return false;
    return choice === 'discard' || this.saveAllDirty();
  }
}

export const tabsStore = new TabsStore();
export type { TabState, PaneState };
