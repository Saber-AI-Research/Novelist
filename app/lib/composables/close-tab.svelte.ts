import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';

/**
 * Close-tab pipeline with a guard against double-fire from both Cmd+W
 * and the native onCloseRequested listener. Returns the close handler
 * plus an `isClosing()` getter the lifecycle listener polls to skip its
 * own close path when ours is already in flight.
 */
export function createCloseTab() {
  let closingTab = false;

  async function handleCloseTab() {
    if (closingTab) return;
    closingTab = true;

    try {
      const tab = tabsStore.activeTab;

      if (!tab) {
        getCurrentWindow().destroy();
        return;
      }

      await tabsStore.closeTab(tab.id);

      const remainingTabs = tabsStore.activeTab;

      if (!remainingTabs && projectStore.singleFileMode) {
        projectStore.close();
      } else if (!remainingTabs && !projectStore.dirPath) {
        getCurrentWindow().destroy();
      }
    } finally {
      closingTab = false;
    }
  }

  return {
    handleCloseTab,
    isClosing: () => closingTab,
  };
}
