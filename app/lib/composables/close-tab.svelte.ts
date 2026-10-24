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
        // An empty split column: close the column. Destroying the window here
        // would skip the unsaved-changes prompt for tabs in other panes.
        if (tabsStore.panes.length > 1) {
          tabsStore.removePane(tabsStore.activePaneId);
        } else {
          getCurrentWindow().destroy();
        }
        return;
      }

      await tabsStore.closeTab(tab.id);

      // Only leave the project / window once no pane holds a tab: the active
      // pane may be an empty column while another one still has dirty tabs.
      if (tabsStore.allTabs.length > 0) return;
      if (projectStore.singleFileMode) {
        await projectStore.close();
      } else if (!projectStore.dirPath) {
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
