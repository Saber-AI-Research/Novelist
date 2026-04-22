import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] ai-talk/host — bridge wrappers for IPC and Tauri event streams
 * used by the AI Talk panel. Pure functions (no reactive state), straight
 * glue around `commands` and `listen`.
 */

const { aiFetchStreamStart, aiFetchStreamCancel, listen, tabsState, editorViewMap } = vi.hoisted(() => {
  const editorViewMap = new Map<string, any>();
  return {
    aiFetchStreamStart: vi.fn(),
    aiFetchStreamCancel: vi.fn(),
    listen: vi.fn(),
    tabsState: {
      activeTab: null as null | { id: string; filePath: string | null; content: string; cursorPosition: number },
      updateContent: vi.fn(),
    },
    editorViewMap,
  };
});

vi.mock('$lib/ipc/commands', () => ({
  commands: { aiFetchStreamStart, aiFetchStreamCancel },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen }));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    get activeTab() { return tabsState.activeTab; },
    updateContent: tabsState.updateContent,
  },
  getEditorView: (id: string) => editorViewMap.get(id) ?? null,
}));

import {
  getEditorSnapshot,
  replaceEditorRange,
  startAiStream,
  cancelAiStream,
  aiStream,
} from '$lib/components/ai-talk/host';

beforeEach(() => {
  aiFetchStreamStart.mockReset();
  aiFetchStreamCancel.mockReset();
  listen.mockReset();
  tabsState.activeTab = null;
  tabsState.updateContent.mockClear();
  editorViewMap.clear();
});

function fakeView(doc: string, from = 0, to = 0) {
  const view = {
    state: {
      doc: { toString: () => doc },
      selection: { main: { from, to } },
    },
    dispatch: vi.fn((spec: any) => {
      if (spec.changes) {
        const { from: f, to: t, insert } = spec.changes;
        const next = doc.slice(0, f) + insert + doc.slice(t);
        view.state.doc.toString = () => next;
      }
    }),
  };
  return view;
}

describe('[contract] getEditorSnapshot', () => {
  it('returns null when there is no active tab', () => {
    expect(getEditorSnapshot()).toBeNull();
  });

  it('reads from the live editor view when one exists', () => {
    tabsState.activeTab = { id: 't1', filePath: '/p', content: 'stale', cursorPosition: 0 };
    editorViewMap.set('t1', fakeView('hello world', 6, 11));
    const snap = getEditorSnapshot()!;
    expect(snap.fullDoc).toBe('hello world');
    expect(snap.from).toBe(6);
    expect(snap.to).toBe(11);
    expect(snap.text).toBe('world');
    expect(snap.filePath).toBe('/p');
    expect(snap.tabId).toBe('t1');
  });

  it('falls back to tab content and cursor when no editor view is attached', () => {
    tabsState.activeTab = { id: 't2', filePath: null, content: 'cached', cursorPosition: 3 };
    const snap = getEditorSnapshot()!;
    expect(snap.fullDoc).toBe('cached');
    expect(snap.from).toBe(3);
    expect(snap.to).toBe(3);
    expect(snap.text).toBe('');
  });
});

describe('[contract] replaceEditorRange', () => {
  it('dispatches a CM6 change and broadcasts the new content to the tab store', () => {
    tabsState.activeTab = { id: 't1', filePath: '/p', content: 'hello world', cursorPosition: 0 };
    const view = fakeView('hello world');
    editorViewMap.set('t1', view);
    replaceEditorRange(6, 11, 'svelte');
    expect(view.dispatch).toHaveBeenCalledWith({ changes: { from: 6, to: 11, insert: 'svelte' } });
    expect(tabsState.updateContent).toHaveBeenCalledWith('t1', 'hello svelte');
  });

  it('no-ops when there is no active tab', () => {
    replaceEditorRange(0, 0, 'x');
    expect(tabsState.updateContent).not.toHaveBeenCalled();
  });

  it('no-ops when the active tab has no editor view yet', () => {
    tabsState.activeTab = { id: 't3', filePath: null, content: '', cursorPosition: 0 };
    replaceEditorRange(0, 0, 'x');
    expect(tabsState.updateContent).not.toHaveBeenCalled();
  });
});

describe('[contract] startAiStream / cancelAiStream', () => {
  it('startAiStream returns the Rust-side stream id on ok', async () => {
    aiFetchStreamStart.mockResolvedValue({ status: 'ok', data: 'stream-42' });
    const id = await startAiStream({ url: 'https://x', headers: [], body: '{}', sse: true });
    expect(id).toBe('stream-42');
    expect(aiFetchStreamStart).toHaveBeenCalledWith({ url: 'https://x', headers: [], body: '{}', sse: true });
  });

  it('startAiStream throws on error', async () => {
    aiFetchStreamStart.mockResolvedValue({ status: 'error', error: 'timeout' });
    await expect(startAiStream({ url: '', headers: [], body: '', sse: false })).rejects.toThrow('timeout');
  });

  it('cancelAiStream resolves on ok, throws on error', async () => {
    aiFetchStreamCancel.mockResolvedValue({ status: 'ok', data: null });
    await expect(cancelAiStream('s1')).resolves.toBeUndefined();
    aiFetchStreamCancel.mockResolvedValue({ status: 'error', error: 'no such stream' });
    await expect(cancelAiStream('s1')).rejects.toThrow('no such stream');
  });
});

describe('[contract] aiStream async generator', () => {
  it('yields payloads in order and stops after `done`', async () => {
    let captured: ((e: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    listen.mockImplementation(async (_ch: string, cb: any) => { captured = cb; return unlisten; });

    const iter = aiStream('s1');
    const collected: unknown[] = [];

    // Emit two chunks then done.
    const pump = (async () => {
      for await (const ev of iter) {
        collected.push(ev);
      }
    })();

    // Wait for the listen() subscription to be installed.
    await new Promise((r) => setTimeout(r, 0));
    captured!({ payload: { kind: 'chunk', data: 'Hello' } });
    captured!({ payload: { kind: 'chunk', data: 'World' } });
    captured!({ payload: { kind: 'done' } });

    await pump;

    expect(listen).toHaveBeenCalledWith('ai-stream://s1', expect.any(Function));
    expect(collected).toEqual([
      { kind: 'chunk', data: 'Hello' },
      { kind: 'chunk', data: 'World' },
      { kind: 'done' },
    ]);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('stops after `error` too', async () => {
    let captured: ((e: { payload: unknown }) => void) | null = null;
    const unlisten = vi.fn();
    listen.mockImplementation(async (_ch: string, cb: any) => { captured = cb; return unlisten; });

    const iter = aiStream('s2');
    const collected: unknown[] = [];
    const pump = (async () => {
      for await (const ev of iter) collected.push(ev);
    })();

    await new Promise((r) => setTimeout(r, 0));
    captured!({ payload: { kind: 'error', message: 'boom' } });
    await pump;

    expect(collected).toEqual([{ kind: 'error', message: 'boom' }]);
    expect(unlisten).toHaveBeenCalled();
  });
});
