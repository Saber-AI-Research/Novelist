import { commands } from '$lib/ipc/commands';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { createStructuredTabSaver, type StructuredTabSaver } from './structured-file';

/** Structured-file autosave bound to the real tab store and file IPC. */
export function createTabsStructuredSaver(): StructuredTabSaver {
  return createStructuredTabSaver({
    getTab: (tabId) => tabsStore.allTabs.find((tab) => tab.id === tabId),
    async write(filePath, content) {
      await commands.registerWriteIgnore(filePath);
      const result = await commands.writeFile(filePath, content);
      if (result.status !== 'ok') console.error('[structured-file] write failed:', result.error);
      return result.status === 'ok';
    },
    markSaved: (tabId) => tabsStore.markSaved(tabId),
  });
}
