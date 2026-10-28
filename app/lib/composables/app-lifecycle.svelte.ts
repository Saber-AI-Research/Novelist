import { invoke } from '@tauri-apps/api/core';
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
import { platform } from '$lib/stores/platform.svelte';
import { flushProjectSwitch } from '$lib/services/project-switch-coordinator';
import { pluginDocumentSessions } from '$lib/services/plugin-document-sessions';

export type AppLifecycleContext = {
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Returns true when App.svelte's own Cmd+W tab-close handler is mid-flight; suppresses native close. */
  isClosingTab: () => boolean;
  /**
   * Save every eligible dirty tab through the auto-save service (skips
   * conflicted, deleted and still-composing tabs). Used by the mobile
   * edit debounce and the background flush.
   */
  saveDirtyTabs: () => Promise<void>;
};

/** Idle time after the last edit before a mobile auto-save runs. */
export const MOBILE_AUTOSAVE_DEBOUNCE_MS = 1_500;
/** Upper bound for an IME composition to settle after a background blur. */
const COMPOSITION_SETTLE_TIMEOUT_MS = 150;

/**
 * Sets up long-lived app-lifecycle behaviors:
 *  - WebDAV auto-sync timer (reads get_sync_config for the currently-open project)
 *  - onCloseRequested prompt for unsaved changes
 *  - beforeunload final sync attempt
 *  - mobile: debounced auto-save after edits, a best-effort flush (dirty
 *    tabs, draft notes, plugin document writes, then WebDAV sync) when the
 *    app is backgrounded, and a sync when it returns to the foreground
 *
 * The background flush is best effort: the OS may suspend or kill the
 * WebView before an async write finishes, so it never replaces the
 * debounced auto-save that keeps the on-disk copy current while editing.
 *
 * Returns a teardown function for the onMount cleanup block.
 */
export function useAppLifecycle(ctx: AppLifecycleContext): () => void {
  let unlistenCloseRequested: (() => void) | null = null;
  let syncIntervalId: ReturnType<typeof setInterval> | null = null;
  // Bumped by every clear so a `get_sync_config` that resolves after a newer
  // project switch (or teardown) can't install a stale, leaked interval.
  let syncTimerGeneration = 0;
  /** WebDAV sync enabled for the open project (read with the timer config). */
  let syncEnabledFor: string | null = null;

  function clearSyncTimer() {
    syncTimerGeneration++;
    syncEnabledFor = null;
    if (syncIntervalId) { clearInterval(syncIntervalId); syncIntervalId = null; }
  }

  async function configureSyncTimer(dirPath: string) {
    clearSyncTimer();
    const generation = syncTimerGeneration;
    try {
      const config = await invoke('get_sync_config', { projectDir: dirPath }) as {
        enabled: boolean;
        interval_minutes: number;
      };
      if (generation !== syncTimerGeneration) return;
      if (config.enabled) syncEnabledFor = dirPath;
      if (config.enabled && config.interval_minutes > 0) {
        syncIntervalId = setInterval(async () => {
          if (projectStore.dirPath !== dirPath) return;
          try {
            await invoke('sync_now', { projectDir: dirPath });
          } catch (e) {
            console.error('Auto-sync failed:', e);
          }
        }, config.interval_minutes * 60 * 1000);
      }
    } catch {
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

  // Account/project linking or the WebDAV form changed this project's sync
  // config: re-arm the timer without reopening the project.
  function handleSyncConfigChanged(event: Event) {
    const projectDir = (event as CustomEvent<{ projectDir?: string }>).detail?.projectDir;
    const dirPath = projectStore.dirPath;
    if (!dirPath || projectDir !== dirPath) return;
    void configureSyncTimer(dirPath);
  }
  window.addEventListener('novelist-sync-config-changed', handleSyncConfigChanged);
  // Edits made offline reach the remote as soon as the device reconnects.
  function handleOnline() { syncIfEnabled(projectStore.dirPath); }
  window.addEventListener('online', handleOnline);

  // Window close (Cmd+Q or title-bar close button).
  // If there are unsaved files, prompt the user before closing. Cmd+W also
  // triggers this on macOS — `isClosingTab()` guards against double-prompting.
  // `closeConfirmed` latches after a successful prompt so re-entry (destroy()
  // on macOS, or another Cmd+Q) doesn't re-show the dialog. Mobile apps have
  // no close request: the OS backgrounds/kills them (see the flush below).
  let closeConfirmed = false;
  if (!platform.isMobile) {
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
  }

  const disposeMobile = platform.isMobile ? wireMobileLifecycle() : () => {};

  function syncIfEnabled(dirPath: string | null) {
    if (!dirPath || syncEnabledFor !== dirPath || !navigator.onLine) return;
    invoke('sync_now', { projectDir: dirPath }).catch((e) => {
      console.error('Background sync failed:', e);
    });
  }

  /**
   * Mobile persistence: debounce an auto-save after edits (typing, dictation
   * and IME commits all emit `input` / composition-end), and flush on
   * background. There is no file watcher on mobile; external changes are
   * picked up by the resume rescan in app-events.
   */
  function wireMobileLifecycle(): () => void {
    let debounceTimer: number | undefined;
    let flushing: Promise<void> | null = null;

    const scheduleSave = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        void ctx.saveDirtyTabs();
      }, MOBILE_AUTOSAVE_DEBOUNCE_MS);
    };

    // A tab turning dirty (editor, canvas/kanban, plugin documents) also
    // schedules a save; `input` covers every later keystroke.
    const disposeDirtyEffect = $effect.root(() => {
      $effect(() => {
        if (tabsStore.dirtyTabs.length > 0) scheduleSave();
      });
    });

    /**
     * Blur a composing editor so the IME commits its text, then wait for the
     * guard to settle; auto-save skips tabs that are still composing.
     */
    async function commitActiveComposition(): Promise<void> {
      const tab = tabsStore.activeTab;
      const view = tab ? getEditorView(tab.id) : undefined;
      if (!tab || !view || !tabsStore.isTabImeComposing(tab.id)) return;
      // Executor form (not Promise.withResolvers): iOS 16 WKWebView lacks it.
      const settled = new Promise<void>((resolve) => {
        const done = () => { window.removeEventListener('novelist-composition-end', done); resolve(); };
        window.addEventListener('novelist-composition-end', done);
        window.setTimeout(done, COMPOSITION_SETTLE_TIMEOUT_MS);
      });
      view.contentDOM.blur();
      await settled;
    }

    function flushForBackground(): Promise<void> {
      window.clearTimeout(debounceTimer);
      debounceTimer = undefined;
      flushing ??= (async () => {
        const dirPath = projectStore.dirPath;
        try {
          await commitActiveComposition();
          await ctx.saveDirtyTabs();
          await flushProjectSwitch(dirPath, dirPath);
          await pluginDocumentSessions.settled();
        } catch (e) {
          console.error('[lifecycle] background flush failed:', e);
        }
        syncIfEnabled(dirPath);
      })().finally(() => { flushing = null; });
      return flushing;
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void flushForBackground();
      } else {
        // Pull remote changes for synced projects; the resume rescan in
        // app-events reloads any open file the sync rewrote.
        syncIfEnabled(projectStore.dirPath);
      }
    };
    const handlePageHide = () => { void flushForBackground(); };

    document.addEventListener('input', scheduleSave, true);
    window.addEventListener('novelist-composition-end', scheduleSave);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);

    return () => {
      clearTimeout(debounceTimer);
      disposeDirtyEffect();
      document.removeEventListener('input', scheduleSave, true);
      window.removeEventListener('novelist-composition-end', scheduleSave);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
    };
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
    window.removeEventListener('novelist-sync-config-changed', handleSyncConfigChanged);
    window.removeEventListener('online', handleOnline);
    clearSyncTimer();
    disposeSyncEffect();
    disposeMobile();
  };
}
