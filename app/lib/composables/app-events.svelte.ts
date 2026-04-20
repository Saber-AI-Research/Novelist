import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { commands, type RecentProject } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { uiStore } from '$lib/stores/ui.svelte';

export type AppEventContext = {
  /** Called when file-changed arrives for a dirty open tab. */
  onConflict: (filePath: string) => void;
  /** Called with the new list after backend finishes its recent-projects cleanup. */
  onRecentProjectsUpdated: (list: RecentProject[]) => void;
  /** Called by novelist-goto-line CustomEvent from ProjectSearch. */
  onGotoLine: (line: number) => void;
};

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.jsonl', '.csv'];

/**
 * Open a text file by absolute path. Used by pending-files drain, the
 * open-file Tauri event (macOS Finder "Open With"), and drag-drop.
 *
 * Kicks the app into single-file mode if no project is open.
 */
async function openFileByPath(filePath: string) {
  const lower = filePath.toLowerCase();
  if (!TEXT_EXTENSIONS.some(ext => lower.endsWith(ext))) return;

  const result = await commands.readFile(filePath);
  if (result.status === 'ok') {
    if (!projectStore.isOpen) {
      projectStore.enterSingleFileMode();
      uiStore.sidebarVisible = false;
    }
    tabsStore.openTab(filePath, result.data);
    await commands.registerOpenFile(filePath);
  }
}

/**
 * Subscribes to all window/IPC events App.svelte cares about. Returns a
 * teardown function to be called from the onMount cleanup block.
 */
export function wireAppEvents(ctx: AppEventContext): () => void {
  let unlistenFileChanged: (() => void) | null = null;
  let unlistenDragDrop: (() => void) | null = null;
  let unlistenOpenFile: (() => void) | null = null;
  let unlistenFileRenamed: (() => void) | null = null;
  let unlistenRecentProjectsUpdated: (() => void) | null = null;

  // Drain any files queued before the frontend was ready
  // (CLI args, macOS "Open With" on cold start)
  (async () => {
    try {
      const pending = await invoke<string[]>('get_pending_open_files');
      for (const filePath of pending) {
        await openFileByPath(filePath);
      }
    } catch (_) {
      // ignore — command may not exist on older builds
    }
  })();

  // Listen for open-file events from Rust (macOS Finder "Open With" while running)
  listen<string>('open-file', async (event) => {
    await openFileByPath(event.payload);
  }).then(fn => { unlistenOpenFile = fn; });

  listen<{ path: string }>('file-changed', async (event) => {
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
    const slashIdx = path.lastIndexOf('/');
    if (slashIdx > 0) {
      await projectStore.refreshFolder(path.slice(0, slashIdx));
    }
  }).then(fn => { unlistenFileChanged = fn; });

  // Cross-window file rename broadcast: another window auto-renamed a file we
  // may have open. Update our tab paths and refresh the affected sidebar folder.
  listen<{ old_path: string; new_path: string }>('file-renamed', (event) => {
    const { old_path, new_path } = event.payload;
    tabsStore.updatePath(old_path, new_path);
    const parentIdx = new_path.lastIndexOf('/');
    if (parentIdx > 0) {
      const parent = new_path.slice(0, parentIdx);
      projectStore.refreshFolder(parent).catch(() => {});
    }
  }).then(fn => { unlistenFileRenamed = fn; });

  // Backend background cleanup of recent projects completed — refresh our
  // in-memory list. The event payload is the filtered list.
  listen<RecentProject[]>('recent-projects-updated', (event) => {
    ctx.onRecentProjectsUpdated(event.payload);
  }).then(fn => { unlistenRecentProjectsUpdated = fn; });

  // Drag-and-drop: open text files dropped onto the window
  getCurrentWindow().onDragDropEvent(async (event) => {
    if (event.payload.type === 'drop') {
      for (const filePath of event.payload.paths) {
        await openFileByPath(filePath);
      }
    }
  }).then(fn => { unlistenDragDrop = fn; });

  // Listen for goto-line events from ProjectSearch
  const handleGotoLine = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail?.line) ctx.onGotoLine(detail.line);
  };
  window.addEventListener('novelist-goto-line', handleGotoLine);

  return () => {
    unlistenFileChanged?.();
    unlistenDragDrop?.();
    unlistenOpenFile?.();
    unlistenFileRenamed?.();
    unlistenRecentProjectsUpdated?.();
    window.removeEventListener('novelist-goto-line', handleGotoLine);
  };
}
