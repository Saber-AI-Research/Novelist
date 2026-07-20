import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';

/**
 * [contract] createEditorContextMenu — snapshot-based cut/copy/paste and
 * runCommand that restores the snapshotted range before dispatching a
 * registered command (works around WKWebView's right-click mousedown
 * collapsing the live selection).
 */

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('$lib/stores/commands.svelte', () => ({
  commandRegistry: { execute },
}));

import { createEditorContextMenu } from '$lib/composables/editor-context-menu.svelte';

type Dispatch = ReturnType<typeof vi.fn>;
type View = {
  state: {
    sliceDoc: ReturnType<typeof vi.fn>;
    selection: { main: { from: number; to: number } };
    doc: { length: number };
  };
  dispatch: Dispatch;
  focus: ReturnType<typeof vi.fn>;
};

function fakeView(doc = 'hello world'): View {
  return {
    state: {
      sliceDoc: vi.fn((from: number, to: number) => doc.slice(from, to)),
      selection: { main: { from: 0, to: 0 } },
      doc: { length: doc.length },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

const writeText = vi.fn();
const readText = vi.fn();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  execute.mockReset();
  writeText.mockReset();
  readText.mockReset();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText, readText },
  });
});

type Menu = ReturnType<typeof createEditorContextMenu> & { view: View | null };

function menu(view: View | null = fakeView()): Menu {
  const api = createEditorContextMenu(() => view as any);
  return new Proxy(api as Menu, {
    get(_t, key) {
      if (key === 'view') return view;
      return (api as any)[key];
    },
    set(_t, key, value) {
      if (key === 'view') { view = value; return true; }
      (api as any)[key] = value;
      return true;
    },
  });
}

describe('[contract] createEditorContextMenu — state management', () => {
  it('starts with null state and returns null through the getter', () => {
    const m = menu();
    expect(m.state).toBeNull();
  });

  it('setter and close() flip the snapshot on/off', () => {
    const m = menu();
    m.state = { x: 1, y: 2, hasSelection: true, from: 3, to: 7 };
    expect(m.state).toEqual({ x: 1, y: 2, hasSelection: true, from: 3, to: 7 });
    m.close();
    expect(m.state).toBeNull();
  });
});

describe('[contract] cut', () => {
  it('dispatches one deletion from the captured CJK range before clipboard completion', async () => {
    const clipboardWrite = deferred<void>();
    writeText.mockReturnValue(clipboardWrite.promise);
    const m = menu(fakeView('序章\n你好世界\n尾声'));
    m.state = { x: 0, y: 0, hasSelection: true, from: 3, to: 7 };

    const cut = m.cut();
    m.close();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('你好世界');
    expect(m.view!.dispatch).toHaveBeenCalledTimes(2);
    expect(m.view!.dispatch.mock.calls[0]?.[0]).toEqual({
      selection: { anchor: 3, head: 7 },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(m.view!.dispatch.mock.calls[1]?.[0]).toEqual({
      changes: { from: 3, to: 7, insert: '' },
      selection: { anchor: 3 },
      annotations: isolateHistory.of('full'),
    });
    expect(m.view!.focus).toHaveBeenCalledOnce();

    clipboardWrite.resolve();
    await expect(cut).resolves.toBeUndefined();
  });

  it('no-ops when state is null (no snapshot)', async () => {
    const m = menu();
    await m.cut();
    expect(m.view!.dispatch).not.toHaveBeenCalled();
  });

  it('no-ops when the snapshot range is empty (from === to)', async () => {
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: false, from: 3, to: 3 };
    await m.cut();
    expect(m.view!.dispatch).not.toHaveBeenCalled();
  });

  it('keeps the single deletion and handles clipboard rejection', async () => {
    writeText.mockRejectedValue(new Error('denied: token=secret'));
    const m = menu(fakeView('plain 文本 tail'));
    m.state = { x: 0, y: 0, hasSelection: true, from: 6, to: 8 };

    await expect(m.cut()).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith('文本');
    expect(m.view!.dispatch).toHaveBeenCalledTimes(2);
    expect(m.view!.dispatch.mock.calls[0]?.[0]).toEqual({
      selection: { anchor: 6, head: 8 },
      annotations: Transaction.addToHistory.of(false),
    });
    expect(m.view!.dispatch.mock.calls[1]?.[0]).toEqual({
      changes: { from: 6, to: 8, insert: '' },
      selection: { anchor: 6 },
      annotations: isolateHistory.of('full'),
    });
    expect(m.view!.focus).toHaveBeenCalledOnce();
  });

  it('no-ops when getView returns null', async () => {
    const api = createEditorContextMenu(() => null as any);
    api.state = { x: 0, y: 0, hasSelection: true, from: 0, to: 5 };
    await api.cut();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('[contract] copy', () => {
  it('writes selection text to clipboard without mutating the doc', async () => {
    writeText.mockResolvedValue(undefined);
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: true, from: 0, to: 5 };
    await m.copy();
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(m.view!.dispatch).not.toHaveBeenCalled();
  });

  it('no-ops when from === to', async () => {
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: false, from: 4, to: 4 };
    await m.copy();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('[contract] paste', () => {
  it('inserts clipboard text at the snapshot range and restores focus', async () => {
    readText.mockResolvedValue('XYZ');
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: true, from: 2, to: 5 };
    await m.paste();
    expect(m.view!.dispatch).toHaveBeenCalledWith({
      changes: { from: 2, to: 5, insert: 'XYZ' },
      selection: { anchor: 2 + 3 },
    });
    expect(m.view!.focus).toHaveBeenCalled();
  });

  it('falls back to the live selection when no snapshot exists', async () => {
    readText.mockResolvedValue('HI');
    const m = menu();
    m.view!.state.selection.main = { from: 4, to: 7 };
    await m.paste();
    expect(m.view!.dispatch).toHaveBeenCalledWith({
      changes: { from: 4, to: 7, insert: 'HI' },
      selection: { anchor: 4 + 2 },
    });
  });

  it('no-ops when the clipboard is empty', async () => {
    readText.mockResolvedValue('');
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: true, from: 0, to: 5 };
    await m.paste();
    expect(m.view!.dispatch).not.toHaveBeenCalled();
  });

  it('no-ops when clipboard.readText rejects', async () => {
    readText.mockRejectedValue(new Error('denied'));
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: true, from: 0, to: 5 };
    await m.paste();
    expect(m.view!.dispatch).not.toHaveBeenCalled();
  });
});

describe('[contract] selectAll', () => {
  it('dispatches a selection covering the whole doc', () => {
    const m = menu();
    m.selectAll();
    expect(m.view!.dispatch).toHaveBeenCalledWith({
      selection: { anchor: 0, head: m.view!.state.doc.length },
    });
    expect(m.view!.focus).toHaveBeenCalled();
  });
});

describe('[contract] runCommand', () => {
  it('restores the snapshot range before dispatching the registered command', () => {
    const m = menu();
    m.state = { x: 0, y: 0, hasSelection: true, from: 2, to: 5 };
    m.runCommand('editor-block-quote');
    expect(m.view!.dispatch).toHaveBeenCalledWith({ selection: { anchor: 2, head: 5 } });
    expect(execute).toHaveBeenCalledWith('editor-block-quote');
    expect(m.view!.focus).toHaveBeenCalledOnce();
    expect(m.view!.dispatch.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(m.view!.focus.mock.invocationCallOrder[0]);
  });

  it('executes the command even with no view or snapshot (no restore needed)', () => {
    const api = createEditorContextMenu(() => null as any);
    api.runCommand('anything');
    expect(execute).toHaveBeenCalledWith('anything');
  });
});
