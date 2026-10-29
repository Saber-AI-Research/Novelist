/**
 * Window event that asks the Sidebar to start its inline rename on a tree
 * entry (expanding parent folders first). Mobile's "Rename" for the current
 * file dispatches it after revealing the sidebar drawer; desktop keeps the
 * Save As dialog. No-op when the path is not in the open project's tree.
 */
export const START_RENAME_EVENT = 'novelist:start-rename';

export interface StartRenameDetail {
  path: string;
}

export function requestStartRename(path: string): void {
  window.dispatchEvent(new CustomEvent<StartRenameDetail>(START_RENAME_EVENT, { detail: { path } }));
}
