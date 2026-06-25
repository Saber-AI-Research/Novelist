import { invoke } from '@tauri-apps/api/core';
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
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

  function clearSyncTimer() {
    if (syncIntervalId) { clearInterval(syncIntervalId); syncIntervalId = null; }
  }

  async function configureSyncTimer(dirPath: string) {
    clearSyncTimer();
    try {
      const config = await invoke('get_sync_config', { projectDir: dirPath }) as {
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

  // Re-read sync config whenever the open project changes. At cold start the
  // welcome screen is shown (dirPath === null), so a single up-front call would
  // never start the timer once a project is later opened/switched. `$effect.root`
  // lets us own a reactive effect from this onMount-invoked composable.
  const disposeSyncEffect = $effect.root(() => {
    $effect(() => {
      const dirPath = projectStore.dirPath;
      clearSyncTimer();
      if (dirPath) void configureSyncTimer(dirPath);
    });
  });

  // Window close (Cmd+Q or title-bar close button).
  // If there are unsaved files, prompt the user before closing. Cmd+W also
  // triggers this on macOS — `isClosingTab()` guards against double-prompting.
  // `closeConfirmed` latches after a successful prompt so re-entry (destroy()
  // on macOS, or another Cmd+Q) doesn't re-show the dialog.
  let closeConfirmed = false;
  try {
    getCurrentWindow().onCloseRequested(async (event) => {
      if (ctx.isClosingTab()) {
        event.preventDefault();
        return;
      }
      if (closeConfirmed) return;

      const dirty = tabsStore.dirtyTabs;
      if (dirty.length > 0) {
        event.preventDefault();
        try {
          const names = dirty.map(dt => dt.fileName).join(', ');
          const choice = await confirmUnsavedChanges({
            fileNames: names,
            saveLabel: ctx.t('dialog.save'),
          });
          if (choice === 'cancel') return;
          if (choice === 'save') {
            const saved = await tabsStore.saveAllDirty();
            if (!saved) return;
          }
          closeConfirmed = true;
          await getCurrentWindow().destroy();
        } catch (e) {
          console.error('[lifecycle] close-request handling failed:', e);
        }
      }
    }).then(fn => { unlistenCloseRequested = fn; }).catch((e) => {
      console.error('[lifecycle] failed to register close handler:', e);
    });
  } catch (e) {
    console.error('[lifecycle] close handler setup failed:', e);
  }

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
    clearSyncTimer();
    disposeSyncEffect();
  };
}
