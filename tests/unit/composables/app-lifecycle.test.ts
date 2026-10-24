import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * [contract] useAppLifecycle — wires the auto-sync timer, the
 * onCloseRequested prompt for unsaved changes, and the beforeunload final
 * sync attempt. We capture the close-request handler and the sync-config
 * response so each branch can be driven directly.
 */

const { hoisted } = vi.hoisted(() => {
  const invoke = vi.fn();
  const confirmUnsaved = vi.fn();
  const unlisten = vi.fn();

  let closeRequestedHandler: ((ev: { preventDefault: () => void }) => Promise<void> | void) | null =
    null;
  const onCloseRequested = vi.fn(async (handler: any) => {
    closeRequestedHandler = handler;
    return unlisten;
  });

  const destroy = vi.fn();
  const getCurrentWindow = vi.fn(() => ({ onCloseRequested, destroy }));

  const tabsState = {
    dirtyTabs: [] as { id: string; fileName: string }[],
    saveAllDirty: vi.fn(async () => true),
    markSaved: vi.fn(),
  };

  return {
    hoisted: {
      invoke,
      confirmUnsaved,
      unlisten,
      getCurrentWindow,
      destroy,
      tabsState,
      getCloseHandler: () => closeRequestedHandler,
      resetCloseHandler: () => { closeRequestedHandler = null; },
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invoke }));
vi.mock('$lib/composables/unsaved-prompt.svelte', () => ({
  confirmUnsavedChanges: (opts: unknown) => hoisted.confirmUnsaved(opts),
}));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: hoisted.getCurrentWindow }));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    get dirtyTabs() { return hoisted.tabsState.dirtyTabs; },
    saveAllDirty: () => hoisted.tabsState.saveAllDirty(),
    markSaved: (id: string) => hoisted.tabsState.markSaved(id),
  },
}));

vi.mock('$lib/stores/project.svelte', async () => {
  const { projectState } = await import('./project-state.svelte');
  return {
    projectStore: {
      get dirPath() { return projectState.dirPath; },
    },
  };
});

import { useAppLifecycle } from '$lib/composables/app-lifecycle.svelte';
import { projectState } from './project-state.svelte';

function ctx(isClosingTab = false) {
  return {
    t: (k: string) => k,
    isClosingTab: () => isClosingTab,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.invoke.mockReset();
  hoisted.confirmUnsaved.mockReset();
  hoisted.unlisten.mockReset();
  hoisted.getCurrentWindow.mockClear();
  hoisted.destroy.mockReset();
  hoisted.tabsState.dirtyTabs = [];
  hoisted.tabsState.saveAllDirty.mockClear();
  hoisted.tabsState.markSaved.mockClear();
  projectState.dirPath = null;
  hoisted.resetCloseHandler();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushListeners() {
  // listen() and onCloseRequested() return promises — drain them.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('[contract] useAppLifecycle — sync timer', () => {
  it('does not start a timer when no project is open', async () => {
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    expect(hoisted.invoke).not.toHaveBeenCalledWith('get_sync_config', expect.anything());
    teardown();
  });

  it('starts a timer when sync config is enabled', async () => {
    projectState.dirPath = '/proj';
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_sync_config') return { enabled: true, interval_minutes: 5 };
      return undefined;
    });
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    expect(hoisted.invoke).toHaveBeenCalledWith('get_sync_config', { projectDir: '/proj' });
    // Advance time past the first interval and expect a sync_now invoke.
    hoisted.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(hoisted.invoke).toHaveBeenCalledWith('sync_now', { projectDir: '/proj' });
    teardown();
  });

  it('skips the timer when config.enabled is false', async () => {
    projectState.dirPath = '/proj';
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_sync_config') return { enabled: false, interval_minutes: 5 };
      return undefined;
    });
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    hoisted.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(hoisted.invoke).not.toHaveBeenCalledWith('sync_now', expect.anything());
    teardown();
  });

  it('swallows errors from get_sync_config', async () => {
    projectState.dirPath = '/proj';
    hoisted.invoke.mockRejectedValueOnce(new Error('no config'));
    // Must not throw.
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    teardown();
  });

  it('swallows sync_now failures and keeps the timer running', async () => {
    projectState.dirPath = '/proj';
    const err = new Error('sync failed');
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_sync_config') return { enabled: true, interval_minutes: 1 };
      if (cmd === 'sync_now') throw err;
      return undefined;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    await vi.advanceTimersByTimeAsync(60 * 1000); // second tick still fires
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    teardown();
  });

  it('ignores a sync config that resolves after a newer project switch', async () => {
    projectState.dirPath = '/projA';
    const configA = Promise.withResolvers<{ enabled: boolean; interval_minutes: number }>();
    const configB = Promise.withResolvers<{ enabled: boolean; interval_minutes: number }>();
    hoisted.invoke.mockImplementation(async (cmd: string, args: { projectDir: string }) => {
      if (cmd === 'get_sync_config') return args.projectDir === '/projA' ? configA.promise : configB.promise;
      return undefined;
    });
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    expect(hoisted.invoke).toHaveBeenCalledWith('get_sync_config', { projectDir: '/projA' });

    projectState.dirPath = '/projB';
    await flushListeners();
    expect(hoisted.invoke).toHaveBeenCalledWith('get_sync_config', { projectDir: '/projB' });

    configB.resolve({ enabled: true, interval_minutes: 30 });
    configA.resolve({ enabled: true, interval_minutes: 1 });
    await flushListeners();
    hoisted.invoke.mockClear();

    // Project A's 1-minute schedule must not survive the switch.
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(hoisted.invoke).not.toHaveBeenCalledWith('sync_now', expect.anything());
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(hoisted.invoke).toHaveBeenCalledTimes(1);
    expect(hoisted.invoke).toHaveBeenCalledWith('sync_now', { projectDir: '/projB' });
    teardown();
  });

  it('does not start a timer when teardown happens before the sync config resolves', async () => {
    projectState.dirPath = '/proj';
    const config = Promise.withResolvers<{ enabled: boolean; interval_minutes: number }>();
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_sync_config') return config.promise;
      return undefined;
    });
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    teardown();

    config.resolve({ enabled: true, interval_minutes: 1 });
    await flushListeners();
    hoisted.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(hoisted.invoke).not.toHaveBeenCalledWith('sync_now', expect.anything());
  });
});

describe('[contract] useAppLifecycle — onCloseRequested', () => {
  it('registers a handler with the current window', async () => {
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    expect(hoisted.getCurrentWindow).toHaveBeenCalled();
    expect(hoisted.getCloseHandler()).toBeTruthy();
    teardown();
  });

  it('swallows close-listener registration failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const win = hoisted.getCurrentWindow();
    win.onCloseRequested.mockRejectedValueOnce(new Error('listener unavailable'));
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    expect(errorSpy).toHaveBeenCalledWith(
      '[lifecycle] failed to register close handler:',
      expect.any(Error),
    );
    teardown();
    errorSpy.mockRestore();
  });

  it('preventDefaults and returns early when tab-close is in flight', async () => {
    const teardown = useAppLifecycle(ctx(/* isClosingTab */ true));
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(hoisted.confirmUnsaved).not.toHaveBeenCalled();
    teardown();
  });

  it('keeps close handler errors local to the handler', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockRejectedValueOnce(new Error('dialog failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await expect(hoisted.getCloseHandler()!({ preventDefault: vi.fn() })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      '[lifecycle] close-request handling failed:',
      expect.any(Error),
    );
    expect(hoisted.destroy).not.toHaveBeenCalled();
    teardown();
    errorSpy.mockRestore();
  });

  it('passes through silently when no dirty tabs', async () => {
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hoisted.confirmUnsaved).not.toHaveBeenCalled();
    teardown();
  });

  it('prompts to save and destroys when all dirty tabs save successfully', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('save');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(hoisted.confirmUnsaved).toHaveBeenCalled();
    expect(hoisted.tabsState.saveAllDirty).toHaveBeenCalled();
    expect(hoisted.destroy).toHaveBeenCalled();
    teardown();
  });

  it('keeps the window open when saveAllDirty reports a save failure', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('save');
    hoisted.tabsState.saveAllDirty.mockResolvedValueOnce(false);
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(hoisted.tabsState.saveAllDirty).toHaveBeenCalled();
    expect(hoisted.destroy).not.toHaveBeenCalled();
    teardown();
  });

  it('skips saveAllDirty but still destroys when user says "dont save"', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('discard');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    expect(hoisted.tabsState.saveAllDirty).not.toHaveBeenCalled();
    expect(hoisted.destroy).toHaveBeenCalled();
    teardown();
  });

  it('does NOT destroy and does NOT save when user cancels', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('cancel');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(hoisted.confirmUnsaved).toHaveBeenCalled();
    expect(hoisted.tabsState.saveAllDirty).not.toHaveBeenCalled();
    expect(hoisted.tabsState.markSaved).not.toHaveBeenCalled();
    expect(hoisted.destroy).not.toHaveBeenCalled();
    teardown();
  });

  it('does NOT latch closeConfirmed after cancel — subsequent close re-prompts', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValueOnce('cancel');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    // Second close attempt: helper must be called again (not latched).
    hoisted.confirmUnsaved.mockResolvedValueOnce('discard');
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    expect(hoisted.confirmUnsaved).toHaveBeenCalledTimes(2);
    expect(hoisted.destroy).toHaveBeenCalledTimes(1); // only the discard call destroyed
    teardown();
  });

  it('latches after confirm — second close request does not re-prompt', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('save');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    // Second invocation: confirmUnsaved must NOT be called again.
    hoisted.confirmUnsaved.mockClear();
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    expect(hoisted.confirmUnsaved).not.toHaveBeenCalled();
    teardown();
  });
});

describe('[contract] useAppLifecycle — beforeunload', () => {
  it('fires sync_now when a project is open', async () => {
    projectState.dirPath = '/proj';
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    hoisted.invoke.mockClear();
    hoisted.invoke.mockResolvedValue(undefined);
    window.dispatchEvent(new Event('beforeunload'));
    expect(hoisted.invoke).toHaveBeenCalledWith('sync_now', { projectDir: '/proj' });
    teardown();
  });

  it('does nothing when no project is open', async () => {
    projectState.dirPath = null;
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    hoisted.invoke.mockClear();
    window.dispatchEvent(new Event('beforeunload'));
    expect(hoisted.invoke).not.toHaveBeenCalled();
    teardown();
  });
});

describe('[contract] useAppLifecycle — teardown', () => {
  it('unlistens close-requested, clears the sync interval, and removes beforeunload', async () => {
    projectState.dirPath = '/proj';
    hoisted.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_sync_config') return { enabled: true, interval_minutes: 1 };
      return undefined;
    });
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    teardown();
    expect(hoisted.unlisten).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    removeSpy.mockRestore();
    // After teardown, interval no longer fires sync_now.
    hoisted.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(hoisted.invoke).not.toHaveBeenCalled();
  });
});
