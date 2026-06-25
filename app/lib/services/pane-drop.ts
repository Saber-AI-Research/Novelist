import { commands } from '$lib/ipc/commands';
import { tabsStore } from '$lib/stores/tabs.svelte';

const OPENABLE_EXTENSIONS = ['.md', '.markdown', '.txt', '.canvas', '.kanban', '.json', '.jsonl', '.csv'];

export const SIDEBAR_PATH_MIME = 'application/x-novelist-path';

export function isOpenablePath(path: string): boolean {
  const lower = path.toLowerCase();
  return OPENABLE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function hasSidebarPath(types: ReadonlyArray<string> | DOMStringList | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if ((types as ArrayLike<string>)[i].toLowerCase() === SIDEBAR_PATH_MIME) return true;
  }
  return false;
}

/** Open a sidebar-dragged file inside an existing pane. */
export async function openPathInPane(paneId: string, filePath: string): Promise<boolean> {
  if (!isOpenablePath(filePath)) return false;
  const result = await commands.readFile(filePath);
  if (result.status !== 'ok') return false;
  tabsStore.openTabInPane(paneId, filePath, result.data);
  tabsStore.setActivePane(paneId);
  await commands.registerOpenFile(filePath).catch(() => {});
  return true;
}

/**
 * Drop a sidebar-dragged file into a "split right" zone:
 * enable split if it isn't already, then open the file in pane-2.
 */
export async function openPathSplitRight(filePath: string): Promise<boolean> {
  if (!isOpenablePath(filePath)) return false;
  if (!tabsStore.splitActive) tabsStore.toggleSplit();
  return openPathInPane('pane-2', filePath);
}

export type PaneDropEdge = 'left' | 'center' | 'right';

/** Where a drop lands relative to a pane at column index `paneIndex`. */
export interface PaneDropTarget {
  paneId: string;
  paneIndex: number;
  edge: PaneDropEdge;
}

/**
 * Unified drop handler for both sidebar files and tabs onto a pane.
 *  - CENTER → open/move into the target pane.
 *  - LEFT/RIGHT → create a new column on that side and put the item there
 *    (falls back to CENTER when the column cap is hit, signalled by a null
 *    pane id from the store).
 */
export async function handlePaneDrop(target: PaneDropTarget, dt: DataTransfer | null): Promise<void> {
  if (!dt) return;
  const { paneId, paneIndex, edge } = target;

  const tabId = dt.getData('novelist/tab-id');
  if (tabId) {
    if (edge === 'center') {
      tabsStore.moveTabToPaneAt(tabId, paneId);
      return;
    }
    const at = edge === 'left' ? paneIndex : paneIndex + 1;
    const created = tabsStore.createPaneWithTab(at, tabId);
    if (!created) tabsStore.moveTabToPaneAt(tabId, paneId); // cap reached
    return;
  }

  const path = dt.getData(SIDEBAR_PATH_MIME);
  if (path) {
    if (!isOpenablePath(path)) return;
    if (edge === 'center') {
      await openPathInPane(paneId, path);
      return;
    }
    const at = edge === 'left' ? paneIndex : paneIndex + 1;
    const created = tabsStore.createPane(at);
    await openPathInPane(created ?? paneId, path);
  }
}
