import { tabsStore } from '$lib/stores/tabs.svelte';
import { t } from '$lib/i18n';

export interface AutoSaveOptions {
  /** Files the timer must leave alone, e.g. while their conflict dialog is open. */
  isBlocked?: (filePath: string) => boolean;
}

export interface AutoSave {
  /** (Re)arm the timer; `minutes <= 0` turns auto-save off. */
  setInterval(minutes: number): void;
  /** Save every eligible dirty tab now. Overlapping calls share one run. */
  runOnce(): Promise<void>;
  /** Stop the timer. */
  stop(): void;
}

/**
 * Periodic auto-save of every dirty tab in every pane. Skips tabs whose file
 * is blocked (a pending external-change conflict must not be overwritten
 * before the user chooses), tabs mid IME composition, and tabs whose file was
 * deleted on disk. Write failures surface in the operation-error toast.
 */
export function createAutoSave(options: AutoSaveOptions = {}): AutoSave {
  let timer: number | undefined;
  let running: Promise<void> | null = null;

  async function saveDirtyTabs() {
    for (const id of tabsStore.dirtyTabs.map(tab => tab.id)) {
      const tab = tabsStore.findTab(id);
      if (!tab?.isDirty || tab.externalState === 'deleted') continue;
      if (options.isBlocked?.(tab.filePath)) continue;
      if (tabsStore.isTabImeComposing(id)) continue;
      const name = tab.fileName;
      const result = await tabsStore.saveTab(id);
      if (result.status === 'error') {
        console.error(`[autosave] ${name}:`, result.error);
        window.dispatchEvent(new CustomEvent('novelist-operation-error', {
          detail: { message: t('autosave.failed', { name, error: result.error }) },
        }));
      }
    }
  }

  function runOnce(): Promise<void> {
    running ??= saveDirtyTabs().finally(() => { running = null; });
    return running;
  }

  function stop() {
    window.clearInterval(timer);
    timer = undefined;
  }

  return {
    setInterval(minutes: number) {
      stop();
      if (!(minutes > 0)) return;
      timer = window.setInterval(() => { void runOnce(); }, minutes * 60_000);
    },
    runOnce,
    stop,
  };
}
