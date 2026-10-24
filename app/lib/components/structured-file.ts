/**
 * Shared plumbing for the structured file editors (kanban, canvas).
 *
 * Saving: the editor writes every edit into the tab store right away (so
 * Save, Save All and the close prompt always see the current text); the
 * saver only batches the disk write. It keeps one pending write per tab, so
 * an edit in another tab never cancels this one, and `flush()` runs every
 * pending write instead of dropping it when the editor unmounts.
 *
 * Loading: `createTabReloadGate` tells the editor when to re-parse the tab.
 */

export interface StructuredLoadTab {
  id: string;
  filePath: string;
  version: number;
}

/**
 * Returns a function that is `true` when the editor must (re)load from the
 * tab: a different tab, a renamed file, or a new on-disk version
 * (`reloadContent` bumps `version` after an external change).
 */
export function createTabReloadGate(): (tab: StructuredLoadTab | undefined) => boolean {
  let loadedKey: string | null = null;
  return (tab) => {
    const key = tab ? JSON.stringify([tab.id, tab.filePath, tab.version]) : null;
    if (key === loadedKey) return false;
    loadedKey = key;
    return true;
  };
}

export interface StructuredSaverTab {
  filePath: string;
  content: string;
  isDirty: boolean;
}

export interface StructuredTabSaverDeps {
  /** Current tab state; `undefined` once the tab is closed. */
  getTab(tabId: string): StructuredSaverTab | undefined;
  /** Writes the file; resolves `false` when the write failed. */
  write(filePath: string, content: string): Promise<boolean>;
  markSaved(tabId: string): void;
  delayMs?: number;
}

export interface StructuredTabSaver {
  /** (Re)start the debounce for one tab. */
  schedule(tabId: string): void;
  /** Write every pending tab now and wait for all writes to finish. */
  flush(): Promise<void>;
}

export const STRUCTURED_SAVE_DELAY_MS = 400;

export function createStructuredTabSaver(deps: StructuredTabSaverDeps): StructuredTabSaver {
  const delayMs = deps.delayMs ?? STRUCTURED_SAVE_DELAY_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Writes for one tab run in order so an older snapshot never lands last.
  const writes = new Map<string, Promise<void>>();

  async function writeNow(tabId: string): Promise<void> {
    const tab = deps.getTab(tabId);
    // Closed (the close prompt already decided), reloaded from disk, or
    // already saved: nothing of ours to write.
    if (!tab || !tab.filePath || !tab.isDirty) return;
    const { filePath, content } = tab;
    let ok = false;
    try {
      ok = await deps.write(filePath, content);
    } catch (e) {
      console.error('[structured-file] save failed:', e);
    }
    if (!ok) return;
    const after = deps.getTab(tabId);
    // Edits made while the write ran are not on disk yet: stay dirty.
    if (after && after.filePath === filePath && after.content === content) deps.markSaved(tabId);
  }

  function run(tabId: string): Promise<void> {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
    const previous = writes.get(tabId) ?? Promise.resolve();
    const write = () => writeNow(tabId);
    const next = previous.then(write, write);
    writes.set(tabId, next);
    void next.finally(() => {
      if (writes.get(tabId) === next) writes.delete(tabId);
    });
    return next;
  }

  return {
    schedule(tabId) {
      clearTimeout(timers.get(tabId));
      timers.set(tabId, setTimeout(() => { void run(tabId); }, delayMs));
    },
    async flush() {
      const pending = [...timers.keys()].map(run);
      await Promise.all([...pending, ...writes.values()]);
    },
  };
}
