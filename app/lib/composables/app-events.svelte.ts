import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  commands,
  type CliOpenPayload,
  type ExternalFileChangePayload,
  type PendingFile,
  type RecentProject,
} from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { handleCliOpen, openProjectInThisWindow } from '$lib/services/cli-open';
import { routeSingleFileOpen, wireFileRoutingBids } from '$lib/services/file-route';
import { pathBasename, pathDirname, pathStartsWithChild } from '$lib/utils/path';

export type AppEventContext = {
  /** Called when file-changed arrives for a dirty open tab. */
  onConflict: (filePath: string) => void;
  /** Called with the new list after backend finishes its recent-projects cleanup. */
  onRecentProjectsUpdated: (list: RecentProject[]) => void;
  /** Called by novelist-goto-line CustomEvent from ProjectSearch. */
  onGotoLine: (line: number) => void;
  /** Called when a folder must be opened in *this* window (cold start path). */
  onOpenProjectInThisWindow: (dirPath: string) => Promise<void> | void;
};

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.canvas', '.kanban', '.json', '.jsonl', '.csv'];
const EXTERNAL_CHANGE_DEBOUNCE_MS = 1_050;

type ExternalChangePayload =
  | ExternalFileChangePayload
  | { path: string };

type QueuedExternalChange = {
  identity: string;
  paths: string[];
  refreshSidebar: boolean;
  generation: number;
};

function reportEventError(label: string, error: unknown): void {
  console.error(`[app-events] ${label} failed:`, error);
}

function safeAsync<T>(label: string, fn: (value: T) => Promise<void> | void): (value: T) => Promise<void> {
  return async (value: T) => {
    try {
      await fn(value);
    } catch (e) {
      reportEventError(label, e);
    }
  };
}

/**
 * Open a text file by absolute path *in this window*. This is the local
 * "actually open the tab" step — it does NOT consult the cross-window
 * router. Callers come from one of:
 *   - The `open-file-deliver` event (router picked us as the winner).
 *   - Tests that pre-seed `commands.readFile` and want to assert tab state.
 *
 * Kicks the app into single-file mode if no project is open.
 *
 * Returns true on success so the caller can know whether to advance focus
 * (e.g. scroll to a goto line).
 */
async function openFileByPath(filePath: string, line: number | null = null): Promise<boolean> {
  const lower = filePath.toLowerCase();
  if (!TEXT_EXTENSIONS.some(ext => lower.endsWith(ext))) return false;

  const result = await commands.readFile(filePath);
  if (result.status !== 'ok') return false;

  if (!projectStore.isOpen) {
    await projectStore.enterSingleFileMode();
    uiStore.sidebarVisible = false;
  }
  tabsStore.openTab(filePath, result.data);
  await commands.registerOpenFile(filePath);

  if (line && line > 0) {
    // Defer to the next frame so the editor view has time to mount before
    // we ask it to jump.
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('novelist-goto-line', { detail: { line } }));
    });
  }
  return true;
}

/**
 * Subscribes to all window/IPC events App.svelte cares about. Returns a
 * teardown function to be called from the onMount cleanup block.
 */
export function wireAppEvents(ctx: AppEventContext): () => void {
  let unlistenFileChanged: (() => void) | null = null;
  let unlistenDragDrop: (() => void) | null = null;
  let unlistenOpenFile: (() => void) | null = null;
  let unlistenOpenFileDeliver: (() => void) | null = null;
  let unlistenFileRoutingBids: (() => void) | null = null;
  let unlistenFileRenamed: (() => void) | null = null;
  let unlistenDirectoryChanged: (() => void) | null = null;
  let unlistenRecentProjectsUpdated: (() => void) | null = null;

  let unlistenCliOpen: (() => void) | null = null;
  let disposed = false;
  const pendingExternalChanges = new Map<string, QueuedExternalChange>();
  const imeDeferredChanges = new Map<string, QueuedExternalChange>();
  const externalChangeTimers = new Map<string, ReturnType<typeof window.setTimeout>>();
  // Per canonical identity, the highest generation owns store mutation.
  // Scheduling a newer change invalidates every older alias read immediately.
  const externalChangeGenerations = new Map<string, number>();

  // Drain any files + folders queued before the frontend was ready
  // (CLI args, macOS "Open With" on cold start). Folders take precedence:
  // if both are pending, the first folder loads as the project here and
  // any other folders spawn additional windows; files then load as tabs.
  (async () => {
    try {
      const pendingProjects = await invoke<string[]>('get_pending_open_projects');
      const pendingFiles = await invoke<PendingFile[]>('get_pending_open_files');
      if (pendingProjects.length > 0) {
        recordNativeE2eEvent('pending-project', pendingProjects[0]);
        await ctx.onOpenProjectInThisWindow(pendingProjects[0]);
        recordNativeE2eEvent('project-opened', pendingProjects[0]);
        // Extra folders go to fresh windows.
        for (const extra of pendingProjects.slice(1)) {
          await openProjectInThisWindow(extra, /*spawnNew*/ true);
        }
      }
      for (const f of pendingFiles) {
        await routeSingleFileOpen(f.path, f.line ?? null, f.col ?? null);
      }
    } catch (error) {
      recordNativeE2eEvent('pending-open-error', String(error));
      // ignore — command may not exist on older builds
    }
  })();

  function bindEvent<T>(
    name: string,
    handler: (event: { payload: T }) => Promise<void> | void,
    assign: (fn: () => void) => void,
  ) {
    try {
      listen<T>(name, safeAsync(`event:${name}`, handler))
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            assign(unlisten);
          }
        })
        .catch((e) => {
          reportEventError(`listen:${name}`, e);
        });
    } catch (e) {
      reportEventError(`listen:${name}`, e);
    }
  }

  // On Windows `emit_to` broadcasts to every webview, so the backend stamps the
  // single intended window's label on each external-open event. Skip events not
  // addressed to us. Defensive form (only when present) keeps older/cached
  // frontends and existing tests working.
  const notForThisWindow = (targetLabel: string | undefined): boolean =>
    !!targetLabel && targetLabel !== getCurrentWindow().label;

  // Listen for open-file events from Rust (macOS Finder "Open With" while running).
  // Goes through the cross-window router — may end up in a different window.
  bindEvent<{ path: string; target_label?: string }>('open-file', async (event) => {
    if (notForThisWindow(event.payload.target_label)) return;
    await routeSingleFileOpen(event.payload.path);
  }, fn => { unlistenOpenFile = fn; });

  // Router delivered this file *to this window*. Open it locally.
  bindEvent<{ path: string; line: number | null; col: number | null; target_label?: string }>(
    'open-file-deliver',
    async (event) => {
      if (notForThisWindow(event.payload.target_label)) return;
      await openFileByPath(event.payload.path, event.payload.line ?? null);
    },
    fn => { unlistenOpenFileDeliver = fn; },
  );

  // Respond to bid requests from the router (in any window).
  wireFileRoutingBids()
    .then((fn) => {
      if (disposed) fn();
      else unlistenFileRoutingBids = fn;
    })
    .catch((e) => reportEventError('listen:file-open-bid-request', e));

  // Hot-path CLI invocations: a second `novelist ...` process forwarded its
  // args via tauri-plugin-single-instance. Folders spawn new windows; files
  // go through the cross-window router.
  bindEvent<CliOpenPayload & { target_label?: string }>('cli-open', async (event) => {
    if (notForThisWindow(event.payload.target_label)) return;
    await handleCliOpen(event.payload);
  }, fn => { unlistenCliOpen = fn; });

  // Reload an open tab when its file changed on disk (or surface a conflict if
  // the tab has unsaved edits). Shared by the notify `file-changed` event and
  // the polling fallback below.
  function normalizeExternalChange(payload: ExternalChangePayload | string): { identity: string; paths: string[] } | null {
    if (typeof payload === 'string') {
      return payload.length > 0 ? { identity: payload, paths: [payload] } : null;
    }
    if ('identity' in payload) {
      if (payload.identity.length === 0) return null;
      const paths = Array.from(new Set(payload.paths.filter(path => path.length > 0))).sort();
      return paths.length > 0 ? { identity: payload.identity, paths } : null;
    }
    return payload.path.length > 0 ? { identity: payload.path, paths: [payload.path] } : null;
  }

  function advanceExternalChangeGeneration(identity: string): number {
    const generation = (externalChangeGenerations.get(identity) ?? 0) + 1;
    externalChangeGenerations.set(identity, generation);
    return generation;
  }

  function isCurrentExternalChange(identity: string, generation: number): boolean {
    return !disposed && externalChangeGenerations.get(identity) === generation;
  }

  function recordNativeE2eEvent(kind: string, path: string) {
    const testWindow = window as typeof window & {
      __PW_ACTIVE__?: boolean;
      __NOVELIST_NATIVE_E2E_EVENTS__?: Array<{ kind: string; path: string }>;
    };
    if (!testWindow.__PW_ACTIVE__) return;
    (testWindow.__NOVELIST_NATIVE_E2E_EVENTS__ ??= []).push({ kind, path });
  }

  async function isConfirmedExternalDeletion(path: string): Promise<boolean> {
    const parent = pathDirname(path);
    const name = pathBasename(path);
    if (!parent || !name) return false;
    const listed = await commands.listDirectory(parent, true);
    if (listed.status !== 'ok') return false;
    return !listed.data.some(entry => entry.name === name && !entry.is_dir);
  }

  function ownerTabs(paths: string[]) {
    const owners = new Map<string, { path: string; tab: ReturnType<typeof tabsStore.findByPath> }>();
    for (const path of paths) {
      for (const tab of tabsStore.findAllByPath(path)) {
        owners.set(tab.id, { path, tab });
      }
    }
    return Array.from(owners.values()).filter(
      (owner): owner is { path: string; tab: NonNullable<typeof owner.tab> } => owner.tab !== undefined,
    );
  }

  function hasComposingOwner(paths: string[]): boolean {
    return ownerTabs(paths).some(({ tab }) => tabsStore.isTabImeComposing(tab.id));
  }

  function deferExternalChange(change: QueuedExternalChange) {
    for (const path of change.paths) recordNativeE2eEvent('ime-deferred', path);
    imeDeferredChanges.set(change.identity, change);
  }

  async function readExternalContent(paths: string[]) {
    let lastError: Awaited<ReturnType<typeof commands.readFile>> | null = null;
    for (const path of paths) {
      const result = await commands.readFile(path);
      if (result.status === 'ok') return result;
      lastError = result;
    }
    return lastError;
  }

  async function refreshExternalChangeParents(paths: string[]) {
    const parents = new Set(paths.map(pathDirname).filter((parent): parent is string => parent.length > 0));
    for (const parent of parents) {
      await projectStore.refreshFolder(parent);
    }
  }

  async function deliverExternalChange(change: QueuedExternalChange) {
    const { identity, paths, refreshSidebar, generation } = change;
    if (!isCurrentExternalChange(identity, generation)) return;
    let owners = ownerTabs(paths);
    if (owners.some(({ tab }) => tabsStore.isTabImeComposing(tab.id))) {
      deferExternalChange(change);
      return;
    }

    if (owners.length > 0) {
      const result = await readExternalContent(owners.map(({ path }) => path));
      if (!isCurrentExternalChange(identity, generation)) return;
      owners = ownerTabs(paths);
      if (owners.some(({ tab }) => tabsStore.isTabImeComposing(tab.id))) {
        deferExternalChange(change);
        return;
      }

      if (result?.status === 'ok') {
        const conflictPaths = new Set<string>();
        for (const { path, tab } of owners) {
          if (tab.isDirty) {
            conflictPaths.add(path);
          } else {
            recordNativeE2eEvent('reload', path);
            tabsStore.reloadContent(tab.id, result.data);
          }
        }
        for (const path of conflictPaths) {
          recordNativeE2eEvent('conflict', path);
          ctx.onConflict(path);
        }
      } else {
        const conflictPaths = new Set<string>();
        for (const path of Array.from(new Set(owners.map(owner => owner.path)))) {
          const confirmedDeleted = await isConfirmedExternalDeletion(path);
          if (!isCurrentExternalChange(identity, generation)) return;
          const pathOwners = tabsStore.findAllByPath(path);
          if (pathOwners.some(tab => tabsStore.isTabImeComposing(tab.id))) {
            deferExternalChange(change);
            return;
          }
          for (const tab of pathOwners) {
            if (confirmedDeleted) tabsStore.markExternalDeleted(tab.id);
            if (tab.isDirty) conflictPaths.add(path);
          }
        }
        for (const path of conflictPaths) {
          recordNativeE2eEvent('conflict', path);
          ctx.onConflict(path);
        }
      }
    }

    if (refreshSidebar) {
      await refreshExternalChangeParents(paths);
    }
  }

  function armExternalChangeTimer(identity: string) {
    const existingTimer = externalChangeTimers.get(identity);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    externalChangeTimers.set(identity, window.setTimeout(() => {
      externalChangeTimers.delete(identity);
      const change = pendingExternalChanges.get(identity);
      if (!change) return;
      pendingExternalChanges.delete(identity);
      void deliverExternalChange(change).catch((error) => {
        reportEventError(`external-change:${identity}`, error);
      });
    }, EXTERNAL_CHANGE_DEBOUNCE_MS));
  }

  function retargetQueuedPath(path: string, oldRoot: string, newRoot: string): string {
    if (path === oldRoot) return newRoot;
    return pathStartsWithChild(path, oldRoot)
      ? `${newRoot}${path.slice(oldRoot.length)}`
      : path;
  }

  function retargetQueuedExternalChanges(oldRoot: string, newRoot: string): string[] {
    const pendingIdentities: string[] = [];
    for (const queue of [pendingExternalChanges, imeDeferredChanges]) {
      for (const [identity, change] of queue) {
        const paths = Array.from(new Set(
          change.paths.map(path => retargetQueuedPath(path, oldRoot, newRoot)),
        )).sort();
        if (paths.every((path, index) => path === change.paths[index])) continue;
        queue.set(identity, { ...change, paths });
        if (queue === pendingExternalChanges) pendingIdentities.push(identity);
      }
    }
    return pendingIdentities;
  }

  function scheduleExternalChange(payload: ExternalChangePayload | string, refreshSidebar: boolean) {
    if (disposed) return;
    const normalized = normalizeExternalChange(payload);
    if (!normalized) return;
    const generation = advanceExternalChangeGeneration(normalized.identity);
    const existing = pendingExternalChanges.get(normalized.identity)
      ?? imeDeferredChanges.get(normalized.identity);
    const change: QueuedExternalChange = {
      ...normalized,
      refreshSidebar: refreshSidebar || existing?.refreshSidebar === true,
      generation,
    };
    pendingExternalChanges.delete(normalized.identity);
    imeDeferredChanges.delete(normalized.identity);
    if (hasComposingOwner(normalized.paths)) {
      deferExternalChange(change);
      return;
    }
    pendingExternalChanges.set(normalized.identity, change);
    armExternalChangeTimer(normalized.identity);
  }

  function drainImeDeferredChanges() {
    for (const [identity, change] of Array.from(imeDeferredChanges.entries())) {
      if (!isCurrentExternalChange(identity, change.generation)) {
        imeDeferredChanges.delete(identity);
        continue;
      }
      if (hasComposingOwner(change.paths)) continue;
      imeDeferredChanges.delete(identity);
      scheduleExternalChange(change, change.refreshSidebar);
    }
  }

  window.addEventListener('novelist-composition-end', drainImeDeferredChanges);

  bindEvent<ExternalChangePayload>('file-changed', async (event) => {
    const normalized = normalizeExternalChange(event.payload);
    if (!normalized) return;
    for (const path of normalized.paths) recordNativeE2eEvent('notify', path);
    scheduleExternalChange(normalized, true);
  }, fn => { unlistenFileChanged = fn; });

  bindEvent<{ path: string }>('directory-changed', async (event) => {
    await projectStore.refreshFolder(event.payload.path);
  }, fn => { unlistenDirectoryChanged = fn; });

  const refreshInterval = window.setInterval(() => {
    if (projectStore.dirPath) {
      projectStore.refreshLoadedFolders().catch(() => {});
    }
  }, 15_000);

  // Polling fallback for external-edit auto-reload. The notify watcher only
  // covers an open *project* directory, so files opened in single-file mode
  // (no project → no watcher) — and files under symlinked roots, or edits the
  // OS coalesces/drops — would otherwise never reload without a manual
  // re-open. The backend re-hashes every tracked open file (mtime-gated, with
  // self-write suppression) and returns the ones that changed. The 1s interval
  // sits comfortably under the watcher's 2s self-write ignore window so saves
  // are never reported as external edits. Cheap: usually a handful of `stat`s.
  let polling = false;
  const externalPollInterval = window.setInterval(async () => {
    if (polling) return; // don't overlap if a tick runs long
    drainImeDeferredChanges();
    polling = true;
    try {
      const result = await commands.pollExternalChanges();
      if (result.status === 'ok') {
        for (const change of result.data) {
          const normalized = normalizeExternalChange(change);
          if (!normalized) continue;
          for (const path of normalized.paths) recordNativeE2eEvent('poll', path);
          scheduleExternalChange(normalized, true);
        }
      }
    } catch (e) {
      reportEventError('poll-external-changes', e);
    } finally {
      polling = false;
    }
  }, 1_000);

  // Cross-window file rename broadcast: another window auto-renamed a file we
  // may have open. Update our tab paths and refresh the affected sidebar folder.
  bindEvent<{ old_path: string; new_path: string }>('file-renamed', async (event) => {
    const { old_path, new_path } = event.payload;
    const pendingIdentities = retargetQueuedExternalChanges(old_path, new_path);
    for (const identity of pendingIdentities) {
      const timer = externalChangeTimers.get(identity);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        externalChangeTimers.delete(identity);
      }
    }
    await tabsStore.retargetOpenPathTree(old_path, new_path);
    for (const identity of pendingIdentities) armExternalChangeTimer(identity);
    const oldParent = pathDirname(old_path);
    const newParent = pathDirname(new_path);
    if (oldParent) {
      await projectStore.refreshFolder(oldParent);
    }
    if (newParent && newParent !== oldParent) {
      await projectStore.refreshFolder(newParent);
    }
  }, fn => { unlistenFileRenamed = fn; });

  // Backend background cleanup of recent projects completed — refresh our
  // in-memory list. The event payload is the filtered list.
  bindEvent<RecentProject[]>('recent-projects-updated', (event) => {
    ctx.onRecentProjectsUpdated(event.payload);
  }, fn => { unlistenRecentProjectsUpdated = fn; });

  // Drag-and-drop: open text files dropped onto the window
  try {
    getCurrentWindow().onDragDropEvent(safeAsync('drag-drop', async (event) => {
      if (event.payload.type === 'drop') {
        for (const filePath of event.payload.paths) {
          await routeSingleFileOpen(filePath);
        }
      }
    })).then((fn) => {
      if (disposed) fn();
      else unlistenDragDrop = fn;
    }).catch((e) => {
      reportEventError('drag-drop-listener', e);
    });
  } catch (e) {
    reportEventError('drag-drop-listener', e);
  }

  // Listen for goto-line events from ProjectSearch
  const handleGotoLine = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.line) ctx.onGotoLine(detail.line);
  };
  window.addEventListener('novelist-goto-line', handleGotoLine);

  return () => {
    disposed = true;
    unlistenFileChanged?.();
    unlistenDirectoryChanged?.();
    unlistenDragDrop?.();
    unlistenOpenFile?.();
    unlistenOpenFileDeliver?.();
    unlistenFileRoutingBids?.();
    unlistenFileRenamed?.();
    unlistenRecentProjectsUpdated?.();
    unlistenCliOpen?.();
    window.clearInterval(refreshInterval);
    window.clearInterval(externalPollInterval);
    window.removeEventListener('novelist-composition-end', drainImeDeferredChanges);
    pendingExternalChanges.clear();
    imeDeferredChanges.clear();
    externalChangeGenerations.clear();
    for (const timer of externalChangeTimers.values()) window.clearTimeout(timer);
    externalChangeTimers.clear();
    window.removeEventListener('novelist-goto-line', handleGotoLine);
  };
}
