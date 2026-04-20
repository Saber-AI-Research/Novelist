import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';

export type AppLifecycleContext = {
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Returns true when App.svelte's own Cmd+W tab-close handler is mid-flight; suppresses native close. */
  isClosingTab: () => boolean;
};

/**
 * Sets up long-lived app-lifecycle behaviors:
 *  - WebDAV auto-sync timer (reads get_sync_config for the currently-open project)
 *  - onCloseRequested prompt for unsaved changes
 *  - beforeunload final sync attempt
 *
 * Returns a teardown function for the onMount cleanup block.
 */
export function useAppLifecycle(ctx: AppLifecycleContext): () => void {
  let unlistenCloseRequested: (() => void) | null = null;
  let syncIntervalId: ReturnType<typeof setInterval> | null = null;

  async function setupSyncTimer() {
    if (syncIntervalId) { clearInterval(syncIntervalId); syncIntervalId = null; }
    if (!projectStore.dirPath) return;
    try {
      const config = await invoke('get_sync_config', { projectDir: projectStore.dirPath }) as {
        enabled: boolean;
        interval_minutes: number;
      };
      if (config.enabled && config.interval_minutes > 0) {
        syncIntervalId = setInterval(async () => {
          if (!projectStore.dirPath) return;
          try {
            await invoke('sync_now', { projectDir: projectStore.dirPath });
          } catch (e) {
            console.error('Auto-sync failed:', e);
          }
        }, config.interval_minutes * 60 * 1000);
      }
    } catch (_) {
      // Sync not configured — that's fine.
    }
  }

  setupSyncTimer();

  // Window close (Cmd+Q or title-bar close button).
  // If there are unsaved files, prompt the user before closing. Cmd+W also
  // triggers this on macOS — `isClosingTab()` guards against double-prompting.
  // `closeConfirmed` latches after a successful prompt so re-entry (destroy()
  // on macOS, or another Cmd+Q) doesn't re-show the dialog.
  let closeConfirmed = false;
  getCurrentWindow().onCloseRequested(async (event) => {
    if (ctx.isClosingTab()) {
      event.preventDefault();
      return;
    }
    if (closeConfirmed) return;

    const dirty = tabsStore.dirtyTabs;
    if (dirty.length > 0) {
      event.preventDefault();
      const names = dirty.map(dt => dt.fileName).join(', ');
      const shouldSave = await ask(
        ctx.t('dialog.unsavedBeforeClose', { names }),
        { title: ctx.t('dialog.unsavedChanges'), kind: 'warning', okLabel: ctx.t('dialog.save'), cancelLabel: ctx.t('dialog.dontSave') },
      );
      if (shouldSave) {
        await tabsStore.saveAllDirty();
      }
      for (const tab of tabsStore.dirtyTabs) tabsStore.markSaved(tab.id);
      closeConfirmed = true;
      await getCurrentWindow().destroy();
    }
  }).then(fn => { unlistenCloseRequested = fn; });

  // Final sync attempt on app close.
  function handleBeforeUnload() {
    if (projectStore.dirPath) {
      invoke('sync_now', { projectDir: projectStore.dirPath }).catch(() => {});
    }
  }
  window.addEventListener('beforeunload', handleBeforeUnload);

  return () => {
    unlistenCloseRequested?.();
    window.removeEventListener('beforeunload', handleBeforeUnload);
    if (syncIntervalId) clearInterval(syncIntervalId);
  };
}
