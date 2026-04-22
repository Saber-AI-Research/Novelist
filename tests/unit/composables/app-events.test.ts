import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] wireAppEvents — subscribes to open-file / file-changed /
 * file-renamed / recent-projects-updated / drag-drop / novelist-goto-line.
 * We capture the handlers registered with each mocked listener and fire
 * them manually to verify routing into tabsStore/projectStore/context.
 */

const { hoisted } = vi.hoisted(() => {
  const listeners = new Map<string, (ev: { payload: any }) => any>();
  const unlisten = vi.fn();
  const invoke = vi.fn();
  const listen = vi.fn(async (name: string, handler: (ev: { payload: any }) => any) => {
    listeners.set(name, handler);
    return unlisten;
  });

  const dragDropHandlers: ((ev: { payload: any }) => any)[] = [];
  const onDragDropEvent = vi.fn(async (handler: (ev: { payload: any }) => any) => {
    dragDropHandlers.push(handler);
    return unlisten;
  });
  const getCurrentWindow = vi.fn(() => ({ onDragDropEvent }));

  const readFile = vi.fn();
  const registerOpenFile = vi.fn(async () => ({ status: 'ok' }));

  const tabsState = {
    findByPath: vi.fn(),
    reloadContent: vi.fn(),
    openTab: vi.fn(),
    updatePath: vi.fn(),
  };

  const projectState = {
    isOpen: false,
    enterSingleFileMode: vi.fn(() => { projectState.isOpen = true; }),
    refreshFolder: vi.fn(async (_p: string) => {}),
  };

  const uiState = { sidebarVisible: true };

  return {
    hoisted: {
      listeners,
      dragDropHandlers,
      invoke,
      listen,
      unlisten,
      getCurrentWindow,
      readFile,
      registerOpenFile,
      tabsState,
      projectState,
      uiState,
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: hoisted.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: hoisted.listen }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: hoisted.getCurrentWindow }));

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    readFile: hoisted.readFile,
    registerOpenFile: hoisted.registerOpenFile,
  },
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    findByPath: (p: string) => hoisted.tabsState.findByPath(p),
    reloadContent: (...a: any[]) => hoisted.tabsState.reloadContent(...a),
    openTab: (...a: any[]) => hoisted.tabsState.openTab(...a),
    updatePath: (...a: any[]) => hoisted.tabsState.updatePath(...a),
  },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get isOpen() { return hoisted.projectState.isOpen; },
    enterSingleFileMode: () => hoisted.projectState.enterSingleFileMode(),
    refreshFolder: (p: string) => hoisted.projectState.refreshFolder(p),
  },
}));

vi.mock('$lib/stores/ui.svelte', () => ({
  uiStore: {
    get sidebarVisible() { return hoisted.uiState.sidebarVisible; },
    set sidebarVisible(v: boolean) { hoisted.uiState.sidebarVisible = v; },
  },
}));

import { wireAppEvents, type AppEventContext } from '$lib/composables/app-events.svelte';

beforeEach(() => {
  hoisted.listeners.clear();
  hoisted.dragDropHandlers.length = 0;
  hoisted.invoke.mockReset();
  hoisted.listen.mockClear();
  hoisted.unlisten.mockReset();
  hoisted.getCurrentWindow.mockClear();
  hoisted.readFile.mockReset();
  hoisted.registerOpenFile.mockReset();
  hoisted.tabsState.findByPath.mockReset();
  hoisted.tabsState.reloadContent.mockReset();
  hoisted.tabsState.openTab.mockReset();
  hoisted.tabsState.updatePath.mockReset();
  hoisted.projectState.enterSingleFileMode.mockClear();
  hoisted.projectState.refreshFolder.mockReset().mockResolvedValue(undefined);
  hoisted.projectState.isOpen = false;
  hoisted.uiState.sidebarVisible = true;
});

function defaultCtx(): AppEventContext {
  return {
    onConflict: vi.fn(),
    onRecentProjectsUpdated: vi.fn(),
    onGotoLine: vi.fn(),
  };
}

async function wire(ctx = defaultCtx()) {
  hoisted.invoke.mockResolvedValue([]);
  const teardown = wireAppEvents(ctx);
  // Let the pending-files drain + listen() promises resolve.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return { ctx, teardown };
}

describe('[contract] wireAppEvents — listener setup', () => {
  it('subscribes to the expected events', async () => {
    await wire();
    const names = hoisted.listen.mock.calls.map((c: any) => c[0]).sort();
    expect(names).toEqual(['file-changed', 'file-renamed', 'open-file', 'recent-projects-updated']);
  });

  it('registers a drag-drop handler on the current window', async () => {
    await wire();
    expect(hoisted.getCurrentWindow).toHaveBeenCalled();
    expect(hoisted.dragDropHandlers.length).toBe(1);
  });

  it('returns a teardown that unlistens + removes the goto-line listener', async () => {
    const { teardown } = await wire();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    teardown();
    // Five listen()s succeeded (open-file, file-changed, file-renamed,
    // recent-projects-updated, onDragDropEvent) — unlisten was called for
    // each except the pending-files drain (which uses invoke).
    expect(hoisted.unlisten).toHaveBeenCalledTimes(5);
    expect(removeSpy).toHaveBeenCalledWith('novelist-goto-line', expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe('[contract] pending-files drain', () => {
  it('opens each pending text file', async () => {
    hoisted.invoke.mockResolvedValue(['/proj/a.md', '/tmp/x.txt']);
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'content' });
    wireAppEvents(defaultCtx());
    await new Promise((r) => setTimeout(r, 0));
    expect(hoisted.tabsState.openTab).toHaveBeenCalledTimes(2);
    expect(hoisted.tabsState.openTab).toHaveBeenCalledWith('/proj/a.md', 'content');
    expect(hoisted.tabsState.openTab).toHaveBeenCalledWith('/tmp/x.txt', 'content');
  });

  it('swallows errors from the get_pending_open_files command', async () => {
    hoisted.invoke.mockRejectedValue(new Error('unknown command'));
    // Must not throw.
    expect(() => wireAppEvents(defaultCtx())).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('[contract] openFileByPath via open-file event', () => {
  it('opens markdown files', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'body' });
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: '/proj/story.md' });
    expect(hoisted.readFile).toHaveBeenCalledWith('/proj/story.md');
    expect(hoisted.tabsState.openTab).toHaveBeenCalledWith('/proj/story.md', 'body');
    expect(hoisted.registerOpenFile).toHaveBeenCalledWith('/proj/story.md');
  });

  it('skips non-text extensions', async () => {
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: '/proj/image.png' });
    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });

  it('enters single-file mode + hides sidebar when no project is open', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'x' });
    hoisted.projectState.isOpen = false;
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: '/tmp/x.md' });
    expect(hoisted.projectState.enterSingleFileMode).toHaveBeenCalled();
    expect(hoisted.uiState.sidebarVisible).toBe(false);
  });

  it('does NOT enter single-file mode when a project is already open', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'x' });
    hoisted.projectState.isOpen = true;
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: '/tmp/x.md' });
    expect(hoisted.projectState.enterSingleFileMode).not.toHaveBeenCalled();
  });

  it('does not openTab when readFile errors', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'denied' });
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: '/tmp/x.md' });
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });
});

describe('[contract] file-changed event', () => {
  it('reloads content when the tab is clean', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'fresh' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/a.md' } });
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('t1', 'fresh');
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('dispatches onConflict when the tab is dirty', async () => {
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: true });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/a.md' } });
    expect(ctx.onConflict).toHaveBeenCalledWith('/proj/a.md');
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
  });

  it('refreshes the parent folder regardless of whether a tab is open', async () => {
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/sub/x.md' } });
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
  });

  it('does not refresh when the path has no directory component', async () => {
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: 'loose.md' } });
    expect(hoisted.projectState.refreshFolder).not.toHaveBeenCalled();
  });
});

describe('[contract] file-renamed event', () => {
  it('updates tab paths and refreshes the new parent folder', async () => {
    await wire();
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: '/proj/old.md', new_path: '/proj/sub/new.md' },
    });
    expect(hoisted.tabsState.updatePath).toHaveBeenCalledWith('/proj/old.md', '/proj/sub/new.md');
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
  });

  it('skips the folder refresh when the new path has no parent', async () => {
    await wire();
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: '/a', new_path: 'bare' },
    });
    expect(hoisted.projectState.refreshFolder).not.toHaveBeenCalled();
  });
});

describe('[contract] recent-projects-updated event', () => {
  it('forwards the payload into ctx.onRecentProjectsUpdated', async () => {
    const { ctx } = await wire();
    const list = [{ path: '/a', name: 'A', last_opened: 1 }] as any;
    await hoisted.listeners.get('recent-projects-updated')!({ payload: list });
    expect(ctx.onRecentProjectsUpdated).toHaveBeenCalledWith(list);
  });
});

describe('[contract] drag-drop', () => {
  it('opens each dropped text file', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'drop-body' });
    await wire();
    const handler = hoisted.dragDropHandlers[0];
    await handler({ payload: { type: 'drop', paths: ['/a.md', '/b.md'] } });
    expect(hoisted.tabsState.openTab).toHaveBeenCalledTimes(2);
  });

  it('ignores non-drop events (hover/leave)', async () => {
    await wire();
    const handler = hoisted.dragDropHandlers[0];
    await handler({ payload: { type: 'enter', paths: ['/a.md'] } });
    expect(hoisted.readFile).not.toHaveBeenCalled();
  });
});

describe('[contract] novelist-goto-line CustomEvent', () => {
  it('forwards the detail.line into ctx.onGotoLine', async () => {
    const { ctx } = await wire();
    window.dispatchEvent(new CustomEvent('novelist-goto-line', { detail: { line: 42 } }));
    expect(ctx.onGotoLine).toHaveBeenCalledWith(42);
  });

  it('ignores events with no detail.line', async () => {
    const { ctx } = await wire();
    window.dispatchEvent(new CustomEvent('novelist-goto-line', { detail: {} }));
    expect(ctx.onGotoLine).not.toHaveBeenCalled();
  });
});
