import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';

/**
 * Keeps the Tauri window title in sync with the active tab / project / dirty
 * state. Must be called from a Svelte component init (uses `$effect`).
 */
export function useWindowTitle(t: (key: string) => string) {
  $effect(() => {
    const tab = tabsStore.activeTab;
    const project = projectStore.name;
    let title = t('app.name');
    if (tab) {
      if (projectStore.singleFileMode) {
        title = `${tab.isDirty ? '● ' : ''}${tab.fileName} — ${t('app.name')}`;
      } else {
        title = `${tab.isDirty ? '● ' : ''}${tab.fileName} — ${project} — ${t('app.name')}`;
      }
    } else if (projectStore.isOpen && !projectStore.singleFileMode) {
      title = `${project} — ${t('app.name')}`;
    }
    getCurrentWindow().setTitle(title);
  });
}
