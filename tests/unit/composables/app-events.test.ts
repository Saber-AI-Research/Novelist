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
  const listDirectory = vi.fn();
  const pollExternalChanges = vi.fn(async () => ({ status: 'ok' as const, data: [] as any[] }));
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
    findAllByPath: vi.fn(),
    reloadContent: vi.fn(),
    markExternalDeleted: vi.fn((_id: string) => {}),
    isTabImeComposing: vi.fn((_id: string) => false),
    openTab: vi.fn(),
    updatePath: vi.fn(),
    retargetOpenPathTree: vi.fn(async (_oldPath: string, _newPath: string) => 0),
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
      listDirectory,
      pollExternalChanges,
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
    listDirectory: hoisted.listDirectory,
    pollExternalChanges: hoisted.pollExternalChanges,
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
    findAllByPath: (p: string) => hoisted.tabsState.findAllByPath(p),
    reloadContent: (...a: any[]) => hoisted.tabsState.reloadContent(...a),
    markExternalDeleted: (id: string) => hoisted.tabsState.markExternalDeleted(id),
    isTabImeComposing: (id: string) => hoisted.tabsState.isTabImeComposing(id),
    openTab: (...a: any[]) => hoisted.tabsState.openTab(...a),
    updatePath: (...a: any[]) => hoisted.tabsState.updatePath(...a),
    retargetOpenPathTree: (oldPath: string, newPath: string) =>
      hoisted.tabsState.retargetOpenPathTree(oldPath, newPath),
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
  hoisted.listDirectory.mockReset().mockResolvedValue({ status: 'ok', data: [] });
  hoisted.pollExternalChanges.mockReset().mockResolvedValue({ status: 'ok', data: [] });
  hoisted.registerOpenFile.mockReset();
  hoisted.routeSingleFileOpen.mockReset().mockResolvedValue(undefined);
  hoisted.wireFileRoutingBids.mockReset().mockResolvedValue(() => {});
  hoisted.tabsState.findByPath.mockReset();
  hoisted.tabsState.findAllByPath.mockReset().mockImplementation((path: string) => {
    const tab = hoisted.tabsState.findByPath(path);
    return tab ? [tab] : [];
  });
  hoisted.tabsState.reloadContent.mockReset();
  hoisted.tabsState.markExternalDeleted.mockReset();
  hoisted.tabsState.isTabImeComposing.mockReset().mockReturnValue(false);
  hoisted.tabsState.openTab.mockReset();
  hoisted.tabsState.updatePath.mockReset();
  hoisted.tabsState.retargetOpenPathTree.mockReset().mockResolvedValue(0);
  hoisted.projectState.enterSingleFileMode.mockClear();
  hoisted.projectState.refreshFolder.mockReset().mockResolvedValue(undefined);
  hoisted.projectState.refreshLoadedFolders.mockReset().mockResolvedValue(undefined);
  hoisted.projectState.dirPath = null;
  hoisted.projectState.isOpen = false;
  hoisted.uiState.sidebarVisible = true;
});

afterEach(() => {
  for (const teardown of activeTeardowns.splice(0)) teardown();
  vi.useRealTimers();
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

async function flushPromisesOnly() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it('immediately unlistens a registration that resolves after teardown', async () => {
    const lateUnlisten = vi.fn();
    const delayedFileChanged = deferred<typeof lateUnlisten>();
    hoisted.listen.mockImplementation((name: string, handler: (ev: { payload: any }) => any) => {
      hoisted.listeners.set(name, handler);
      if (name === 'file-changed') return delayedFileChanged.promise;
      return Promise.resolve(hoisted.unlisten);
    });
    hoisted.invoke.mockResolvedValue([]);
    const teardown = wireAppEvents(defaultCtx());
    teardown();

    delayedFileChanged.resolve(lateUnlisten);
    await flushPromisesOnly();

    expect(lateUnlisten).toHaveBeenCalledTimes(1);
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
  it('does not let a busy identity postpone another identity past its own deadline', async () => {
    vi.useFakeTimers();
    const pathA = '/proj/a.md';
    const pathB = '/proj/b.md';
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => [{
      id: path === pathA ? 'a' : 'b',
      filePath: path,
      isDirty: false,
    }]);
    hoisted.readFile.mockImplementation(async (path: string) => ({ status: 'ok', data: `fresh:${path}` }));
    await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { identity: '/canonical/a.md', paths: [pathA] } });
    await vi.advanceTimersByTimeAsync(1_000);
    await changed({ payload: { identity: '/canonical/b.md', paths: [pathB] } });
    await vi.advanceTimersByTimeAsync(50);
    await flushPromisesOnly();

    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('a', `fresh:${pathA}`);
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalledWith('b', expect.anything());
  });

  it('retargets a queued alias from file-renamed without requiring another change event', async () => {
    vi.useFakeTimers();
    const oldAlias = '/alias-old/chapter.md';
    const newAlias = '/alias-new/chapter.md';
    let currentPath = oldAlias;
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => path === currentPath
      ? [{ id: 'alias', filePath: currentPath, isDirty: false }]
      : []);
    hoisted.tabsState.retargetOpenPathTree.mockImplementation(async () => {
      currentPath = newAlias;
      return 1;
    });
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'renamed fresh' });
    await wire();

    await hoisted.listeners.get('file-changed')!({
      payload: { identity: '/canonical/chapter.md', paths: [oldAlias] },
    });
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: oldAlias, new_path: newAlias },
    });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledWith(newAlias);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('alias', 'renamed fresh');
  });

  it('isolates a rejected identity delivery so another due identity still reloads', async () => {
    vi.useFakeTimers();
    const pathA = '/proj/reject.md';
    const pathB = '/proj/survive.md';
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => [{
      id: path === pathA ? 'reject' : 'survive',
      filePath: path,
      isDirty: false,
    }]);
    hoisted.readFile.mockImplementation((path: string) => path === pathA
      ? Promise.reject(new Error('read rejected'))
      : Promise.resolve({ status: 'ok', data: 'survived' }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { identity: '/canonical/reject.md', paths: [pathA] } });
    await changed({ payload: { identity: '/canonical/survive.md', paths: [pathB] } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('survive', 'survived');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('delivers one canonical change to every clean and dirty alias owner without clobbering', async () => {
    vi.useFakeTimers();
    const canonical = '/private/proj/章节.md';
    const realPath = '/proj/章节.md';
    const aliasPath = '/alias/章节.md';
    const cleanTab = { id: 'clean', filePath: realPath, isDirty: false };
    const dirtyTab = { id: 'dirty', filePath: aliasPath, isDirty: true };
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => {
      if (path === realPath) return [cleanTab];
      if (path === aliasPath) return [dirtyTab];
      return [];
    });
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'external latest' });
    const { ctx } = await wire();

    await hoisted.listeners.get('file-changed')!({
      payload: { identity: canonical, paths: [realPath, aliasPath] },
    });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('clean', 'external latest');
    expect(ctx.onConflict).toHaveBeenCalledTimes(1);
    expect(ctx.onConflict).toHaveBeenCalledWith(aliasPath);
  });

  it('coalesces grouped notify and poll duplicates by canonical identity while retaining aliases', async () => {
    vi.useFakeTimers();
    const canonical = '/private/proj/chapter.md';
    const realPath = '/proj/chapter.md';
    const aliasPath = '/alias/chapter.md';
    const tabs = new Map([
      [realPath, [{ id: 'real', filePath: realPath, isDirty: false }]],
      [aliasPath, [{ id: 'alias', filePath: aliasPath, isDirty: false }]],
    ]);
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => tabs.get(path) ?? []);
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'v3' });
    await wire();

    const payload = { identity: canonical, paths: [realPath, aliasPath] };
    await hoisted.listeners.get('file-changed')!({ payload });
    hoisted.pollExternalChanges.mockResolvedValueOnce({
      status: 'ok',
      data: [{ identity: canonical, paths: [aliasPath, realPath] }],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(2);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('real', 'v3');
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('alias', 'v3');
  });

  it('defers every owner of a canonical identity until alias IME composition ends', async () => {
    vi.useFakeTimers();
    const canonical = '/private/proj/ime.md';
    const realPath = '/proj/ime.md';
    const aliasPath = '/alias/ime.md';
    const tabs = new Map([
      [realPath, [{ id: 'real', filePath: realPath, isDirty: false }]],
      [aliasPath, [{ id: 'alias', filePath: aliasPath, isDirty: false }]],
    ]);
    let composing = true;
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => tabs.get(path) ?? []);
    hoisted.tabsState.isTabImeComposing.mockImplementation((id: string) => id === 'alias' && composing);
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'after composition' });
    await wire();

    await hoisted.listeners.get('file-changed')!({
      payload: { identity: canonical, paths: [realPath, aliasPath] },
    });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.readFile).not.toHaveBeenCalled();
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();

    composing = false;
    window.dispatchEvent(new CustomEvent('novelist-composition-end', { detail: { tabId: 'alias' } }));
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(2);
  });

  it('drops a closed alias owner before delivery while reloading the remaining owner', async () => {
    vi.useFakeTimers();
    const canonical = '/private/proj/close.md';
    const realPath = '/proj/close.md';
    const aliasPath = '/alias/close.md';
    let aliasOpen = true;
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => {
      if (path === realPath) return [{ id: 'real', filePath: realPath, isDirty: false }];
      if (path === aliasPath && aliasOpen) return [{ id: 'alias', filePath: aliasPath, isDirty: false }];
      return [];
    });
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'fresh' });
    await wire();

    await hoisted.listeners.get('file-changed')!({
      payload: { identity: canonical, paths: [realPath, aliasPath] },
    });
    aliasOpen = false;
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('real', 'fresh');
  });

  it('uses the latest alias owner list when an alias path is renamed before debounce', async () => {
    vi.useFakeTimers();
    const canonical = '/private/proj/rename.md';
    const realPath = '/proj/rename.md';
    const oldAlias = '/alias-old/rename.md';
    const newAlias = '/alias-new/rename.md';
    hoisted.tabsState.findAllByPath.mockImplementation((path: string) => {
      if (path === realPath) return [{ id: 'real', filePath: realPath, isDirty: false }];
      if (path === newAlias) return [{ id: 'alias', filePath: newAlias, isDirty: false }];
      return [];
    });
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'renamed latest' });
    await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { identity: canonical, paths: [realPath, oldAlias] } });
    await changed({ payload: { identity: canonical, paths: [realPath, newAlias] } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(2);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('alias', 'renamed latest');
  });

  it('reloads content when the tab is clean', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'fresh' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/a.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('t1', 'fresh');
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('coalesces rapid notify and poll events by path and reloads only the latest disk content', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'v3' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false });
    const { ctx } = await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { path: '/proj/章节/第一章.md' } });
    await changed({ payload: { path: '/proj/章节/第一章.md' } });
    hoisted.pollExternalChanges.mockResolvedValueOnce({ status: 'ok', data: ['/proj/章节/第一章.md'] });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('t1', 'v3');
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('ignores an older overlapping read that resolves after a newer read for the same path', async () => {
    vi.useFakeTimers();
    const read1 = deferred<{ status: 'ok'; data: string }>();
    const read2 = deferred<{ status: 'ok'; data: string }>();
    hoisted.readFile
      .mockReturnValueOnce(read1.promise)
      .mockReturnValueOnce(read2.promise);
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false });
    await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { path: '/proj/race.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.readFile).toHaveBeenCalledTimes(1);

    await changed({ payload: { path: '/proj/race.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.readFile).toHaveBeenCalledTimes(2);

    read2.resolve({ status: 'ok', data: 'v3' });
    await flushPromisesOnly();
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenLastCalledWith('t1', 'v3');

    read1.resolve({ status: 'ok', data: 'v2' });
    await flushPromisesOnly();
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenLastCalledWith('t1', 'v3');
  });

  it('queues only the latest clean-tab reload while IME composition is active and flushes after composition end', async () => {
    vi.useFakeTimers();
    hoisted.tabsState.isTabImeComposing.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'v2' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false });
    await wire();

    const changed = hoisted.listeners.get('file-changed')!;
    await changed({ payload: { path: '/proj/ime.md' } });
    await vi.advanceTimersByTimeAsync(50);
    await changed({ payload: { path: '/proj/ime.md' } });
    await vi.advanceTimersByTimeAsync(50);
    window.dispatchEvent(new CustomEvent('novelist-composition-end', { detail: { tabId: 't1' } }));
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.readFile).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledTimes(1);
    expect(hoisted.tabsState.reloadContent).toHaveBeenCalledWith('t1', 'v2');
  });

  it('dispatches onConflict when the tab is dirty', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'ok', data: 'disk' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: true });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/a.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(ctx.onConflict).toHaveBeenCalledWith('/proj/a.md');
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
  });

  it('marks a clean tab as externally deleted only after parent listing confirms absence', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'not found' });
    hoisted.listDirectory.mockResolvedValue({ status: 'ok', data: [{ name: 'other.md' }] });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false, content: 'local clean copy' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/deleted.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.markExternalDeleted).toHaveBeenCalledWith('t1');
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('marks a dirty deleted tab and opens the existing conflict flow without reloading', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'not found' });
    hoisted.listDirectory.mockResolvedValue({ status: 'ok', data: [{ name: 'survivor.md' }] });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: true, content: 'unsaved local' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/deleted-dirty.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.markExternalDeleted).toHaveBeenCalledWith('t1');
    expect(ctx.onConflict).toHaveBeenCalledWith('/proj/deleted-dirty.md');
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
  });

  it('does not mark a clean tab deleted when a read failure leaves the file visible in its parent', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'permission denied' });
    hoisted.listDirectory.mockResolvedValue({ status: 'ok', data: [{ name: 'locked.md', is_dir: false }] });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false, content: 'local clean copy' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/locked.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.markExternalDeleted).not.toHaveBeenCalled();
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('does not mark a hidden clean tab deleted when hidden parent listing shows the file', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'transient read failure' });
    hoisted.listDirectory.mockResolvedValue({ status: 'ok', data: [{ name: '.hidden.md', is_dir: false }] });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false, content: 'local clean copy' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/.hidden.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.listDirectory).toHaveBeenCalledWith('/proj', true);
    expect(hoisted.tabsState.markExternalDeleted).not.toHaveBeenCalled();
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('marks a clean tab deleted when parent listing contains only a directory with the file basename', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'is a directory' });
    hoisted.listDirectory.mockResolvedValue({ status: 'ok', data: [{ name: 'chapter.md', is_dir: true }] });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: false, content: 'local clean copy' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/chapter.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.listDirectory).toHaveBeenCalledWith('/proj', true);
    expect(hoisted.tabsState.markExternalDeleted).toHaveBeenCalledWith('t1');
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
    expect(ctx.onConflict).not.toHaveBeenCalled();
  });

  it('does not mark a dirty tab deleted when parent listing cannot confirm absence', async () => {
    vi.useFakeTimers();
    hoisted.readFile.mockResolvedValue({ status: 'error', error: 'transient read failure' });
    hoisted.listDirectory.mockResolvedValue({ status: 'error', error: 'directory temporarily unavailable' });
    hoisted.tabsState.findByPath.mockReturnValue({ id: 't1', isDirty: true, content: 'unsaved local' });
    const { ctx } = await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/flaky.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();

    expect(hoisted.tabsState.markExternalDeleted).not.toHaveBeenCalled();
    expect(hoisted.tabsState.reloadContent).not.toHaveBeenCalled();
    expect(ctx.onConflict).toHaveBeenCalledWith('/proj/flaky.md');
  });

  it('refreshes the parent folder regardless of whether a tab is open', async () => {
    vi.useFakeTimers();
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: '/proj/sub/x.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
  });

  it('refreshes Windows parent folders', async () => {
    vi.useFakeTimers();
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: 'C:\\proj\\sub\\x.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('C:\\proj\\sub');
  });

  it('does not refresh when the path has no directory component', async () => {
    vi.useFakeTimers();
    hoisted.tabsState.findByPath.mockReturnValue(null);
    await wire();
    await hoisted.listeners.get('file-changed')!({ payload: { path: 'loose.md' } });
    await vi.advanceTimersByTimeAsync(1_050);
    await flushPromisesOnly();
    expect(hoisted.projectState.refreshFolder).not.toHaveBeenCalled();
  });
});

describe('[contract] file-renamed event', () => {
  it('retargets open paths and refreshes both affected parent folders', async () => {
    await wire();
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: '/proj/old/Story.md', new_path: '/proj/sub/Story.md' },
    });
    expect(hoisted.tabsState.retargetOpenPathTree).toHaveBeenCalledWith('/proj/old/Story.md', '/proj/sub/Story.md');
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/old');
    expect(hoisted.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
  });

  it('accepts legacy move broadcasts without migration metadata', async () => {
    await wire();
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: '/proj/old.md', new_path: '/proj/new.md', migration: null },
    });
    expect(hoisted.tabsState.retargetOpenPathTree).toHaveBeenCalledWith('/proj/old.md', '/proj/new.md');
  });

  it('skips the folder refresh when the new path has no parent', async () => {
    await wire();
    await hoisted.listeners.get('file-renamed')!({
      payload: { old_path: 'old', new_path: 'bare' },
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
