import { commands } from '$lib/ipc/commands';
import { getEditorView, reportSaveFailure, tabsStore } from '$lib/stores/tabs.svelte';

/**
 * User chose "keep my version" in the conflict dialog: write the editor's
 * current text back to disk, overwriting the external change. The tab with
 * the edits is saved by id (its live editor is the source), and every other
 * tab of the file then shows what was written.
 */
export async function handleKeepMine(filePath: string) {
  const tabs = tabsStore.findAllByPath(filePath);
  const mine = tabs.find(t => t.isDirty && getEditorView(t.id))
    ?? tabs.find(t => t.isDirty)
    ?? tabs[0];
  if (!mine) return;
  const name = mine.fileName;
  const result = await tabsStore.saveTab(mine.id, { force: true });
  if (result.status === 'error') reportSaveFailure(name, result.error);
}

/**
 * User chose "load disk version": reload every tab of the file from disk,
 * discarding unsaved changes.
 */
export async function handleLoadTheirs(filePath: string) {
  if (tabsStore.findAllByPath(filePath).length === 0) return;
  const result = await commands.readFile(filePath);
  if (result.status !== 'ok') {
    console.error('Failed to read file (load theirs):', result.error);
    return;
  }
  for (const tab of tabsStore.findAllByPath(filePath)) {
    tabsStore.reloadContent(tab.id, result.data);
  }
}
