import { commands } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { pathDirname, pathStartsWithChild, pathsEqual } from '$lib/utils/path';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface DeletableEntry {
  path: string;
  name: string;
  is_dir: boolean;
}

export interface DeleteEntriesResult {
  status: 'cancelled' | 'completed';
  deletedPaths: string[];
  failedPaths: string[];
}

/**
 * Delete one or more files/folders through the same lifecycle used by the
 * sidebar and command palette.
 *
 * The confirmation happens before any tab is closed. Every affected open tab
 * then gets the normal unsaved-changes flow; if any close is cancelled, no
 * filesystem deletion begins. Selected descendants of a selected folder are
 * collapsed into the folder target so the backend never receives redundant
 * child deletes.
 */
export async function deleteEntries(
  entries: readonly DeletableEntry[],
  t: T,
): Promise<DeleteEntriesResult> {
  const targets = collapseNestedTargets(entries);
  if (targets.length === 0) {
    return { status: 'completed', deletedPaths: [], failedPaths: [] };
  }

  const message = targets.length === 1
    ? t('sidebar.deleteConfirm', { name: targets[0].name })
    : t('sidebar.deleteMultipleConfirm', { count: targets.length });
  if (!confirm(message)) {
    return { status: 'cancelled', deletedPaths: [], failedPaths: [] };
  }

  const openTabs = tabsStore.allTabs.filter(tab =>
    targets.some(target =>
      pathsEqual(tab.filePath, target.path)
      || (target.is_dir && pathStartsWithChild(tab.filePath, target.path))
    )
  );
  for (const tab of openTabs) {
    const pathBeforeClose = tab.filePath;
    await tabsStore.closeTab(tab.id);
    if (tabsStore.findByPath(pathBeforeClose)) {
      return { status: 'cancelled', deletedPaths: [], failedPaths: [] };
    }
  }

  const deletedPaths: string[] = [];
  const failedPaths: string[] = [];
  const refreshParents = new Set<string>();
  for (const target of targets) {
    const result = await commands.deleteItem(target.path);
    if (result.status === 'ok') {
      deletedPaths.push(target.path);
      projectStore.removeWorkspacePath(target.path);
      const parent = pathDirname(target.path);
      if (parent) refreshParents.add(parent);
    } else {
      failedPaths.push(target.path);
      console.error(`Failed to delete ${target.path}:`, result.error);
    }
  }

  if (projectStore.dirPath) {
    for (const parent of refreshParents) {
      if (pathsEqual(parent, projectStore.dirPath) || pathStartsWithChild(parent, projectStore.dirPath)) {
        await projectStore.refreshFolder(parent);
      }
    }
  }

  return { status: 'completed', deletedPaths, failedPaths };
}

export function collapseNestedTargets(entries: readonly DeletableEntry[]): DeletableEntry[] {
  const unique: DeletableEntry[] = [];
  for (const entry of entries) {
    if (!unique.some(candidate => pathsEqual(candidate.path, entry.path))) unique.push(entry);
  }
  unique.sort((left, right) => left.path.length - right.path.length);

  return unique.filter(entry => !unique.some(parent =>
    parent !== entry
    && parent.is_dir
    && pathStartsWithChild(entry.path, parent.path)
  ));
}
