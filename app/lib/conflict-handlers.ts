import { commands } from '$lib/ipc/commands';
import { tabsStore } from '$lib/stores/tabs.svelte';

/**
 * User chose "keep my version" in the conflict dialog: write the tab's
 * current content back to disk, overwriting the external change. Ignores
 * the resulting watcher event so we don't prompt ourselves again.
 */
export async function handleKeepMine(filePath: string) {
  const tab = tabsStore.findByPath(filePath);
  if (!tab) return;
  await commands.registerWriteIgnore(filePath);
  const result = await commands.writeFile(filePath, tab.content);
  if (result.status === 'ok') {
    await tabsStore.tryRenameAfterSave(filePath, tab.content);
    tabsStore.markSaved(tab.id);
  } else {
    console.error('Failed to save (keep mine):', result.error);
  }
}

/**
 * User chose "load disk version": reload the tab content from disk,
 * discarding unsaved changes.
 */
export async function handleLoadTheirs(filePath: string) {
  const tab = tabsStore.findByPath(filePath);
  if (!tab) return;
  const result = await commands.readFile(filePath);
  if (result.status === 'ok') {
    tabsStore.reloadContent(tab.id, result.data);
  } else {
    console.error('Failed to read file (load theirs):', result.error);
  }
}
