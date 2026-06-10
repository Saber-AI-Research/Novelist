import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands, type CliOpenPayload, type PendingFile, type RecentProject } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { handleCliOpen, openProjectInThisWindow } from '$lib/services/cli-open';
import { routeSingleFileOpen, wireFileRoutingBids } from '$lib/services/file-route';
import { pathDirname } from '$lib/utils/path';

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
    projectStore.enterSingleFileMode();
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

  // Drain any files + folders queued before the frontend was ready
  // (CLI args, macOS "Open With" on cold start). Folders take precedence:
  // if both are pending, the first folder loads as the project here and
  // any other folders spawn additional windows; files then load as tabs.
  (async () => {
    try {
      const pendingProjects = await invoke<string[]>('get_pending_open_projects');
      const pendingFiles = await invoke<PendingFile[]>('get_pending_open_files');
      if (pendingProjects.length > 0) {
        await ctx.onOpenProjectInThisWindow(pendingProjects[0]);
        // Extra folders go to fresh windows.
        for (const extra of pendingProjects.slice(1)) {
          await openProjectInThisWindow(extra, /*spawnNew*/ true);
        }
      }
      for (const f of pendingFiles) {
        await routeSingleFileOpen(f.path, f.line ?? null, f.col ?? null);
      }
    } catch (_) {
      // ignore — command may not exist on older builds
    }
  })();

  function bindEvent<T>(
    name: string,
    handler: (event: { payload: T }) => Promise<void> | void,
    assign: (fn: () => void) => void,
  ) {
    try {
      listen<T>(name, safeAsync(`event:${name}`, handler)).then(assign).catch((e) => {
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
    .then(fn => { unlistenFileRoutingBids = fn; })
    .catch((e) => reportEventError('listen:file-open-bid-request', e));

  // Hot-path CLI invocations: a second `novelist ...` process forwarded its
  // args via tauri-plugin-single-instance. Folders spawn new windows; files
  // go through the cross-window router.
  bindEvent<CliOpenPayload & { target_label?: string }>('cli-open', async (event) => {
    if (notForThisWindow(event.payload.target_label)) return;
    await handleCliOpen(event.payload);
  }, fn => { unlistenCliOpen = fn; });

  bindEvent<{ path: string }>('file-changed', async (event) => {
    const { path } = event.payload;

    // Refresh tab content if a currently-open file changed on disk.
    const tab = tabsStore.findByPath(path);
    if (tab) {
      if (!tab.isDirty) {
        const result = await commands.readFile(path);
        if (result.status === 'ok') {
          tabsStore.reloadContent(tab.id, result.data);
        }
      } else {
        ctx.onConflict(path);
      }
    }

    // Refresh the sidebar folder containing the changed path, IF it's
    // been loaded (expanded at least once). refreshFolder is a no-op for
    // folders whose children are still undefined.
    const parent = pathDirname(path);
    if (parent) {
      await projectStore.refreshFolder(parent);
    }
  }, fn => { unlistenFileChanged = fn; });

  bindEvent<{ path: string }>('directory-changed', async (event) => {
    await projectStore.refreshFolder(event.payload.path);
  }, fn => { unlistenDirectoryChanged = fn; });

  const refreshInterval = window.setInterval(() => {
    if (projectStore.dirPath) {
      projectStore.refreshLoadedFolders().catch(() => {});
    }
  }, 15_000);

  // Cross-window file rename broadcast: another window auto-renamed a file we
  // may have open. Update our tab paths and refresh the affected sidebar folder.
  bindEvent<{ old_path: string; new_path: string }>('file-renamed', (event) => {
    const { old_path, new_path } = event.payload;
    tabsStore.updatePath(old_path, new_path);
    const parent = pathDirname(new_path);
    if (parent) {
      projectStore.refreshFolder(parent).catch(() => {});
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
    })).then(fn => { unlistenDragDrop = fn; }).catch((e) => {
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
    window.removeEventListener('novelist-goto-line', handleGotoLine);
  };
}
