import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] ViewportManager — sliding window over a Rust Rope for big
 * files. We cover the pure orchestration: loadWindow / dispatchEdit /
 * save / close and the offset helpers, mocking the IPC layer.
 */

const { ropeGetLines, ropeLineToChar, ropeApplyEdit, ropeSave, ropeClose } = vi.hoisted(() => ({
  ropeGetLines: vi.fn(),
  ropeLineToChar: vi.fn(),
  ropeApplyEdit: vi.fn(),
  ropeSave: vi.fn(),
  ropeClose: vi.fn(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: { ropeGetLines, ropeLineToChar, ropeApplyEdit, ropeSave, ropeClose },
}));

import { ViewportManager, WINDOW_SIZE, viewportReplace } from '$lib/editor/viewport';

function fakeView(doc = '') {
  const view = {
    _doc: doc,
    state: {
      get doc() {
        const d = view._doc;
        return {
          length: d.length,
          lines: d.split('\n').length,
          line(n: number) {
            const lines = d.split('\n');
            let from = 0;
            for (let i = 1; i < n; i++) from += lines[i - 1].length + 1;
            return { from };
          },
          lineAt(pos: number) {
            const before = d.slice(0, pos).split('\n');
            return { number: before.length };
          },
          toString: () => d,
        };
      },
      selection: { main: { head: 0 } },
    },
    dispatch: vi.fn((spec: any) => {
      if (spec.changes) {
        const { from, to, insert } = spec.changes;
        view._doc = view._doc.slice(0, from) + insert + view._doc.slice(to);
      }
    }),
  };
  return view;
}

beforeEach(() => {
  ropeGetLines.mockReset();
  ropeLineToChar.mockReset();
  ropeApplyEdit.mockReset();
  ropeSave.mockReset();
  ropeClose.mockReset();
});

describe('[contract] WINDOW_SIZE / viewportReplace', () => {
  it('exposes a sane non-zero WINDOW_SIZE', () => {
    expect(WINDOW_SIZE).toBeGreaterThan(0);
  });

  it('viewportReplace is a CM6 Annotation type', () => {
    const ann = viewportReplace.of(true);
    // Smoke: annotation instances have a `type` and `value`.
    expect(ann).toBeDefined();
    expect(typeof (ann as any).type).toBeDefined();
  });
});

describe('[contract] ViewportManager basics', () => {
  it('constructor remembers fileId and totalLines', () => {
    const mgr = new ViewportManager('f-1', 42);
    expect(mgr.fileId).toBe('f-1');
    expect(mgr.totalLines).toBe(42);
  });

  it('toAbsoluteLine converts 1-based local to 0-based absolute via windowStart', () => {
    const mgr = new ViewportManager('f', 100);
    mgr.windowStartLine = 10;
    expect(mgr.toAbsoluteLine(1)).toBe(10);
    expect(mgr.toAbsoluteLine(5)).toBe(14);
  });
});

describe('[contract] loadWindow', () => {
  it('fetches rope lines + char offset, updates window bookkeeping, returns text', async () => {
    const mgr = new ViewportManager('f-1', 1000);
    ropeGetLines.mockResolvedValue({
      status: 'ok',
      data: { text: 'abc', start_line: 0, end_line: WINDOW_SIZE, total_lines: 1000 },
    });
    ropeLineToChar.mockResolvedValue({ status: 'ok', data: 0 });

    const result = await mgr.loadWindow(50);
    expect(result).toEqual({ text: 'abc', startLine: 0 });
    expect(mgr.windowStartLine).toBe(0);
    expect(mgr.windowEndLine).toBe(WINDOW_SIZE);
    expect(mgr.baseCharOffset).toBe(0);
  });

  it('uses lineToChar result when the IPC returns an error (defaults to 0)', async () => {
    const mgr = new ViewportManager('f-1', 1000);
    ropeGetLines.mockResolvedValue({
      status: 'ok',
      data: { text: 'xyz', start_line: 100, end_line: 100 + WINDOW_SIZE, total_lines: 2000 },
    });
    ropeLineToChar.mockResolvedValue({ status: 'error', error: 'oops' });

    await mgr.loadWindow(500);
    expect(mgr.baseCharOffset).toBe(0);
    expect(mgr.totalLines).toBe(2000);
    expect(mgr.windowStartLine).toBe(100);
  });

  it('throws when ropeGetLines errors', async () => {
    const mgr = new ViewportManager('f', 100);
    ropeGetLines.mockResolvedValue({ status: 'error', error: 'gone' });
    await expect(mgr.loadWindow(0)).rejects.toThrow('gone');
  });
});

describe('[contract] save / close', () => {
  it('save awaits the edit queue and returns true on ok', async () => {
    const mgr = new ViewportManager('f', 10);
    ropeSave.mockResolvedValue({ status: 'ok', data: null });
    await expect(mgr.save()).resolves.toBe(true);
    expect(ropeSave).toHaveBeenCalledWith('f');
  });

  it('save returns false on error', async () => {
    const mgr = new ViewportManager('f', 10);
    ropeSave.mockResolvedValue({ status: 'error', error: 'io' });
    await expect(mgr.save()).resolves.toBe(false);
  });

  it('close calls ropeClose once, even if invoked twice', async () => {
    const mgr = new ViewportManager('f', 10);
    ropeClose.mockResolvedValue({ status: 'ok', data: null });
    await mgr.close();
    await mgr.close();
    expect(ropeClose).toHaveBeenCalledTimes(1);
  });

  it('dispatchEdit after close is a no-op (alive=false guard)', async () => {
    const mgr = new ViewportManager('f', 10);
    ropeClose.mockResolvedValue({ status: 'ok', data: null });
    await mgr.close();
    mgr.dispatchEdit(0, 0, 'x');
    // Settle any queued promise (none should have enqueued).
    await Promise.resolve();
    expect(ropeApplyEdit).not.toHaveBeenCalled();
  });
});

describe('[contract] dispatchEdit', () => {
  it('queues an apply-edit call and updates totalLines on success', async () => {
    const mgr = new ViewportManager('f', 10);
    mgr.baseCharOffset = 100;
    ropeApplyEdit.mockResolvedValue({ status: 'ok', data: 12 });
    mgr.dispatchEdit(5, 8, 'new');
    // Drain the queue.
    await (mgr as any).editQueue;
    expect(ropeApplyEdit).toHaveBeenCalledWith('f', 105, 108, 'new');
    expect(mgr.totalLines).toBe(12);
  });

  it('leaves totalLines unchanged when apply-edit errors', async () => {
    const mgr = new ViewportManager('f', 99);
    ropeApplyEdit.mockResolvedValue({ status: 'error', error: 'nope' });
    mgr.dispatchEdit(0, 0, 'x');
    await (mgr as any).editQueue;
    expect(mgr.totalLines).toBe(99);
  });
});

describe('[contract] attach + getScrollFraction + jumpToLine guards', () => {
  it('getScrollFraction returns 0 when there is no view', () => {
    const mgr = new ViewportManager('f', 100);
    expect(mgr.getScrollFraction()).toBe(0);
  });

  it('getScrollFraction returns 0 when totalLines === 0', () => {
    const mgr = new ViewportManager('f', 0);
    const v = fakeView('hi');
    mgr.attach(v as any);
    expect(mgr.getScrollFraction()).toBe(0);
  });

  it('jumpToLine inside the current window resolves without re-fetching', async () => {
    const mgr = new ViewportManager('f', 200);
    mgr.windowStartLine = 0;
    mgr.windowEndLine = 100;
    const v = fakeView('line1\nline2\nline3');
    mgr.attach(v as any);
    const pos = await mgr.jumpToLine(1);
    expect(typeof pos).toBe('number');
    expect(ropeGetLines).not.toHaveBeenCalled();
  });

  it('jumpToLine outside the window loads a new window', async () => {
    const mgr = new ViewportManager('f', 20000);
    mgr.windowStartLine = 0;
    mgr.windowEndLine = 100;
    const v = fakeView('a\nb\nc');
    mgr.attach(v as any);
    ropeGetLines.mockResolvedValue({
      status: 'ok',
      data: { text: 'a\nb\nc', start_line: 15000, end_line: 15000 + WINDOW_SIZE, total_lines: 20000 },
    });
    ropeLineToChar.mockResolvedValue({ status: 'ok', data: 99999 });
    const pos = await mgr.jumpToLine(15000);
    expect(ropeGetLines).toHaveBeenCalled();
    expect(pos).not.toBeNull();
  });
});
