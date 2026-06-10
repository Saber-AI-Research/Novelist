import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  const getCurrentWindow = vi.fn(() => ({ onDragDropEvent, label: 'main' }));

  const readFile = vi.fn();
  const registerOpenFile = vi.fn(async () => ({ status: 'ok' }));
  const routeSingleFileOpen = vi.fn(async (
    _path: string,
    _line: number | null = null,
    _col: number | null = null,
    _forceNew = false,
  ) => {});
  const wireFileRoutingBids = vi.fn(async () => () => {});

  const tabsState = {
    findByPath: vi.fn(),
    reloadContent: vi.fn(),
    openTab: vi.fn(),
    updatePath: vi.fn(),
  };

  const projectState = {
    dirPath: null as string | null,
    isOpen: false,
    enterSingleFileMode: vi.fn(() => { projectState.isOpen = true; }),
    refreshFolder: vi.fn(async (_p: string) => {}),
    refreshLoadedFolders: vi.fn(async () => {}),
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
      routeSingleFileOpen,
      wireFileRoutingBids,
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

vi.mock('$lib/services/file-route', () => ({
  routeSingleFileOpen: hoisted.routeSingleFileOpen,
  wireFileRoutingBids: hoisted.wireFileRoutingBids,
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
    get dirPath() { return hoisted.projectState.dirPath; },
    enterSingleFileMode: () => hoisted.projectState.enterSingleFileMode(),
    refreshFolder: (p: string) => hoisted.projectState.refreshFolder(p),
    refreshLoadedFolders: () => hoisted.projectState.refreshLoadedFolders(),
  },
}));

vi.mock('$lib/stores/ui.svelte', () => ({
  uiStore: {
    get sidebarVisible() { return hoisted.uiState.sidebarVisible; },
    set sidebarVisible(v: boolean) { hoisted.uiState.sidebarVisible = v; },
  },
}));

import { wireAppEvents, type AppEventContext } from '$lib/composables/app-events.svelte';

const activeTeardowns: Array<() => void> = [];

beforeEach(() => {
  hoisted.listeners.clear();
  hoisted.dragDropHandlers.length = 0;
  hoisted.invoke.mockReset();
  hoisted.listen.mockClear();
  hoisted.unlisten.mockReset();
  hoisted.getCurrentWindow.mockClear();
  hoisted.readFile.mockReset();
  hoisted.registerOpenFile.mockReset();
  hoisted.routeSingleFileOpen.mockReset().mockResolvedValue(undefined);
  hoisted.wireFileRoutingBids.mockReset().mockResolvedValue(() => {});
  hoisted.tabsState.findByPath.mockReset();
  hoisted.tabsState.reloadContent.mockReset();
  hoisted.tabsState.openTab.mockReset();
  hoisted.tabsState.updatePath.mockReset();
  hoisted.projectState.enterSingleFileMode.mockClear();
  hoisted.projectState.refreshFolder.mockReset().mockResolvedValue(undefined);
  hoisted.projectState.refreshLoadedFolders.mockReset().mockResolvedValue(undefined);
  hoisted.projectState.dirPath = null;
  hoisted.projectState.isOpen = false;
  hoisted.uiState.sidebarVisible = true;
});

afterEach(() => {
  for (const teardown of activeTeardowns.splice(0)) teardown();
});

function defaultCtx(): AppEventContext {
  return {
    onConflict: vi.fn(),
    onRecentProjectsUpdated: vi.fn(),
    onGotoLine: vi.fn(),
    onOpenProjectInThisWindow: vi.fn(async () => {}),
  };
}

async function wire(ctx = defaultCtx()) {
  hoisted.invoke.mockResolvedValue([]);
  const teardown = wireAppEvents(ctx);
  activeTeardowns.push(teardown);
  // Let the pending-files drain + listen() promises resolve.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return { ctx, teardown };
}

async function flushAsyncWork() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('[contract] wireAppEvents — listener setup', () => {
  it('subscribes to the expected events', async () => {
    await wire();
    const names = hoisted.listen.mock.calls.map((c: any) => c[0]).sort();
    expect(names).toEqual([
      'cli-open',
      'directory-changed',
      'file-changed',
      'file-renamed',
      'open-file',
      'open-file-deliver',
      'recent-projects-updated',
    ]);
  });

  it('registers a drag-drop handler on the current window', async () => {
    await wire();
    expect(hoisted.getCurrentWindow).toHaveBeenCalled();
    expect(hoisted.dragDropHandlers.length).toBe(1);
  });

  it('wires the cross-window file routing bid listener', async () => {
    await wire();
    expect(hoisted.wireFileRoutingBids).toHaveBeenCalled();
  });

  it('returns a teardown that unlistens + removes the goto-line listener', async () => {
    const { teardown } = await wire();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    teardown();
    // One unlisten per: open-file, open-file-deliver, file-open-bid-request
    // (returned by wireFileRoutingBids), cli-open, file-changed,
    // directory-changed, file-renamed, recent-projects-updated, drag-drop.
    expect(hoisted.unlisten).toHaveBeenCalledTimes(8);
    expect(removeSpy).toHaveBeenCalledWith('novelist-goto-line', expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe('[contract] pending-files drain', () => {
  it('forwards each pending file to the cross-window router', async () => {
    hoisted.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_pending_open_projects') return Promise.resolve([]);
      if (cmd === 'get_pending_open_files') return Promise.resolve([
        { path: '/proj/a.md', line: null, col: null },
        { path: '/tmp/x.txt', line: 4, col: 2 },
      ]);
      return Promise.resolve(undefined);
    });
    activeTeardowns.push(wireAppEvents(defaultCtx()));
    await flushAsyncWork();
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledTimes(2);
    expect(hoisted.routeSingleFileOpen).toHaveBeenNthCalledWith(1, '/proj/a.md', null, null);
    expect(hoisted.routeSingleFileOpen).toHaveBeenNthCalledWith(2, '/tmp/x.txt', 4, 2);
  });

  it('drains pending projects via the context callback', async () => {
    hoisted.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_pending_open_projects') return Promise.resolve(['/work/novel']);
      if (cmd === 'get_pending_open_files') return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const ctx = defaultCtx();
    activeTeardowns.push(wireAppEvents(ctx));
    await flushAsyncWork();
    expect(ctx.onOpenProjectInThisWindow).toHaveBeenCalledWith('/work/novel');
  });

  it('swallows errors from the get_pending_* commands', async () => {
    hoisted.invoke.mockRejectedValue(new Error('unknown command'));
    // Must not throw.
    expect(() => activeTeardowns.push(wireAppEvents(defaultCtx()))).not.toThrow();
    await flushAsyncWork();
  });
});

describe('[contract] open-file event → cross-window routing', () => {
  it('forwards macOS Finder Open-With events to the router', async () => {
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: { path: '/tmp/x.md', target_label: 'main' } });
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledWith('/tmp/x.md');
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });

  // On Windows `emit_to` broadcasts to every webview; only the stamped window
  // may start a routing round, or every window routes the same file.
  it('ignores open-file events addressed to a different window', async () => {
    await wire(); // mock current window label is 'main'
    await hoisted.listeners.get('open-file')!({
      payload: { path: '/tmp/x.md', target_label: 'novelist-7' },
    });
    expect(hoisted.routeSingleFileOpen).not.toHaveBeenCalled();
  });

  it('still routes legacy payloads without target_label', async () => {
    await wire();
    await hoisted.listeners.get('open-file')!({ payload: { path: '/tmp/x.md' } });
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledWith('/tmp/x.md');
  });
});

describe('[contract] cli-open event → coordinator filtering', () => {
  const cliPayload = (target_label?: string) => ({
    files: [{ path: '/a.md', line: null, col: null }],
    folders: [],
    force_new_window: false,
    ...(target_label === undefined ? {} : { target_label }),
  });

  it('runs the routing round when addressed to this window', async () => {
    await wire();
    await hoisted.listeners.get('cli-open')!({ payload: cliPayload('main') });
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledWith('/a.md', null, null, false);
  });

  // The v0.2.8 Windows bug: `emit_to` broadcasts, every window ran its own
  // routing round, and one CLI invocation opened the file in every window.
  it('ignores cli-open addressed to a different window', async () => {
    await wire(); // mock current window label is 'main'
    await hoisted.listeners.get('cli-open')!({ payload: cliPayload('novelist-7') });
    expect(hoisted.routeSingleFileOpen).not.toHaveBeenCalled();
  });

  it('still handles legacy payloads without target_label', async () => {
    await wire();
    await hoisted.listeners.get('cli-open')!({ payload: cliPayload(undefined) });
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledWith('/a.md', null, null, false);
  });
});

describe('[contract] open-file-deliver event (router→winner)', () => {
  it('opens markdown files locally', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'body' });
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/proj/story.md', line: null, col: null },
    });
    expect(hoisted.readFile).toHaveBeenCalledWith('/proj/story.md');
    expect(hoisted.tabsState.openTab).toHaveBeenCalledWith('/proj/story.md', 'body');
    expect(hoisted.registerOpenFile).toHaveBeenCalledWith('/proj/story.md');
  });

  it('skips non-text extensions', async () => {
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/proj/image.png', line: null, col: null },
    });
    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });

  it('enters single-file mode + hides sidebar when no project is open', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'x' });
    hoisted.projectState.isOpen = false;
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/tmp/x.md', line: null, col: null },
    });
    expect(hoisted.projectState.enterSingleFileMode).toHaveBeenCalled();
    expect(hoisted.uiState.sidebarVisible).toBe(false);
  });

  it('does NOT enter single-file mode when a project is already open', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'x' });
    hoisted.projectState.isOpen = true;
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/tmp/x.md', line: null, col: null },
    });
    expect(hoisted.projectState.enterSingleFileMode).not.toHaveBeenCalled();
  });

  it('does not openTab when readFile errors', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'denied' });
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/tmp/x.md', line: null, col: null },
    });
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });

  // On Windows `emit_to` broadcasts to every webview; the target_label guard
  // keeps the file from opening in windows it was not addressed to.
  it('ignores delivery addressed to a different window', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'body' });
    await wire(); // mock current window label is 'main'
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/proj/story.md', line: null, col: null, target_label: 'novelist-99' },
    });
    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(hoisted.tabsState.openTab).not.toHaveBeenCalled();
  });

  it('opens when delivery is addressed to this window', async () => {
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'body' });
    await wire();
    await hoisted.listeners.get('open-file-deliver')!({
      payload: { path: '/proj/story.md', line: null, col: null, target_label: 'main' },
    });
    expect(hoisted.tabsState.openTab).toHaveBeenCalledWith('/proj/story.md', 'body');
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

  it('refreshes Windows parent folders', async () => {
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: 'C:\\proj\\sub\\x.md' } });
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('C:\\proj\\sub');
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

describe('[contract] directory-changed event', () => {
  it('refreshes the changed directory payload', async () => {
    await wire();
    await hoisted.listeners.get('directory-changed')!({ payload: { path: '/proj/sub' } });
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
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
  it('forwards each dropped path to the cross-window router', async () => {
    await wire();
    const handler = hoisted.dragDropHandlers[0];
    await handler({ payload: { type: 'drop', paths: ['/a.md', '/b.md'] } });
    expect(hoisted.routeSingleFileOpen).toHaveBeenCalledTimes(2);
    expect(hoisted.routeSingleFileOpen).toHaveBeenNthCalledWith(1, '/a.md');
    expect(hoisted.routeSingleFileOpen).toHaveBeenNthCalledWith(2, '/b.md');
  });

  it('ignores non-drop events (hover/leave)', async () => {
    await wire();
    const handler = hoisted.dragDropHandlers[0];
    await handler({ payload: { type: 'enter', paths: ['/a.md'] } });
    expect(hoisted.routeSingleFileOpen).not.toHaveBeenCalled();
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
