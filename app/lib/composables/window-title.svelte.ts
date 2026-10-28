import { getCurrentWindow } from '@tauri-apps/api/window';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { platform } from '$lib/stores/platform.svelte';

/**
 * Pure: compose the window title from the current (tab, project, name) inputs.
 * Extracted for direct unit testing; the effect below just wires reactive
 * inputs + the Tauri setTitle call.
 */
export function computeWindowTitle(
  appName: string,
  tab: { fileName: string; isDirty: boolean } | null,
  project: { name: string; isOpen: boolean; singleFileMode: boolean },
): string {
  if (tab) {
    const dot = tab.isDirty ? '● ' : '';
    return project.singleFileMode
      ? `${dot}${tab.fileName} — ${appName}`
      : `${dot}${tab.fileName} — ${project.name} — ${appName}`;
  }
  if (project.isOpen && !project.singleFileMode) {
    return `${project.name} — ${appName}`;
  }
  return appName;
}

/**
 * Keeps the Tauri window title in sync with the active tab / project / dirty
 * state. Must be called from a Svelte component init (uses `$effect`).
 * Mobile has no window title (the touch toolbar shows the file name).
 */
export function useWindowTitle(t: (key: string) => string) {
  if (platform.isMobile) return;
  $effect(() => {
    const tab = tabsStore.activeTab;
    const title = computeWindowTitle(
      t('app.name'),
      tab ? { fileName: tab.fileName, isDirty: tab.isDirty } : null,
      {
        name: projectStore.name,
        isOpen: projectStore.isOpen,
        singleFileMode: projectStore.singleFileMode,
      },
    );
    getCurrentWindow().setTitle(title);
  });
}
