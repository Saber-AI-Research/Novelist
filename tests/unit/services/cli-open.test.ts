import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] services/cli-open — routing for the `cli-open` event from
 * tauri-plugin-single-instance.
 *
 * Rules under test (mirrors `cli-and-windows.md` after the 2026-05-19
 * single-file-open-routing refactor):
 *   1. Folders always spawn a new WebviewWindow with `#project=…` hash.
 *   2. Files always call `routeSingleFileOpen`, forwarding `force_new_window`.
 *      The cross-window router (mocked here) decides where the file lands.
 *   3. consumeWindowSeed parses the URL hash and dispatches at most one
 *      project + one file, then clears the hash.
 */

const { h } = vi.hoisted(() => {
  const ctorCalls: Array<{ label: string; opts: Record<string, unknown> }> = [];
  class FakeWebviewWindow {
    constructor(label: string, opts: Record<string, unknown>) {
      ctorCalls.push({ label, opts });
    }
    once(_evt: string, _cb: (e: unknown) => void) { /* no-op */ }
  }
  const routeCalls: Array<[string, number | null, number | null, boolean]> = [];
  const routeSingleFileOpen = (
    path: string,
    line: number | null = null,
    col: number | null = null,
    forceNew = false,
  ): Promise<void> => {
    routeCalls.push([path, line, col, forceNew]);
    return Promise.resolve();
  };
  return { h: { ctorCalls, FakeWebviewWindow, routeCalls, routeSingleFileOpen } };
});

vi.mock('$lib/services/file-route', () => ({
  routeSingleFileOpen: h.routeSingleFileOpen,
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: h.FakeWebviewWindow,
}));

beforeEach(() => {
  h.ctorCalls.length = 0;
  h.routeCalls.length = 0;
});

import { handleCliOpen, consumeWindowSeed, openProjectInThisWindow, openFileInNewWindow } from '$lib/services/cli-open';
import type { CliOpenPayload } from '$lib/ipc/commands';

function payload(overrides: Partial<CliOpenPayload> = {}): CliOpenPayload {
  // `target_label` is added to CliOpenPayload by the Rust struct; the generated
  // binding picks it up on the next codegen run. The cast keeps this helper
  // compiling both before and after that regeneration.
  return {
    files: overrides.files ?? [],
    folders: overrides.folders ?? [],
    force_new_window: overrides.force_new_window ?? false,
    target_label: (overrides as { target_label?: string }).target_label ?? 'main',
  } as CliOpenPayload;
}

function lastWindowHash(): string | null {
  const last = h.ctorCalls[h.ctorCalls.length - 1];
  if (!last) return null;
  const url = String(last.opts.url ?? '');
  const i = url.indexOf('#');
  return i < 0 ? null : url.slice(i + 1);
}

describe('handleCliOpen — folder routing', () => {
  it('spawns one window per folder, encoding the project path in the URL hash', async () => {
    await handleCliOpen(payload({ folders: ['/work/novel-a', '/work/novel-b'] }));
    expect(h.ctorCalls).toHaveLength(2);
    const hashes = h.ctorCalls.map(c => {
      const url = String(c.opts.url);
      return url.slice(url.indexOf('#') + 1);
    });
    expect(hashes[0]).toContain('project=%2Fwork%2Fnovel-a');
    expect(hashes[1]).toContain('project=%2Fwork%2Fnovel-b');
    // Folders never go through the file router.
    expect(h.routeCalls).toHaveLength(0);
  });

  it('spawns folder windows even with force_new_window=false (folders ignore the flag)', async () => {
    await handleCliOpen(payload({ folders: ['/p'], force_new_window: false }));
    expect(h.ctorCalls).toHaveLength(1);
  });
});

describe('handleCliOpen — file routing', () => {
  it('forwards every file to the cross-window router with the right args', async () => {
    await handleCliOpen(
      payload({
        files: [
          { path: '/a.md', line: null, col: null },
          { path: '/b.md', line: 12, col: 3 },
        ],
      }),
    );
    expect(h.routeCalls).toEqual([
      ['/a.md', null, null, false],
      ['/b.md', 12, 3, false],
    ]);
    expect(h.ctorCalls).toHaveLength(0);
  });

  it('forwards force_new_window=true so the router skips the bid round', async () => {
    await handleCliOpen(
      payload({
        files: [{ path: '/x/note.md', line: null, col: null }],
        force_new_window: true,
      }),
    );
    expect(h.routeCalls).toEqual([['/x/note.md', null, null, true]]);
  });

  it('combined: folder + file → folder window + file routed', async () => {
    await handleCliOpen(
      payload({
        folders: ['/proj'],
        files: [{ path: '/x/note.md', line: null, col: null }],
      }),
    );
    expect(h.ctorCalls).toHaveLength(1); // folder
    expect(h.routeCalls).toEqual([['/x/note.md', null, null, false]]);
  });
});

describe('openProjectInThisWindow', () => {
  it('spawns a new window seeded with the project path when spawnNew=true (default)', async () => {
    await openProjectInThisWindow('/the/proj');
    expect(h.ctorCalls).toHaveLength(1);
    const hash = lastWindowHash() ?? '';
    expect(hash).toContain('project=%2Fthe%2Fproj');
  });

  it('logs a warning and is a no-op when spawnNew=false (caller should bypass)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await openProjectInThisWindow('/x', false);
    expect(h.ctorCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('openFileInNewWindow', () => {
  it('encodes file + line + col into the hash', async () => {
    await openFileInNewWindow('/x/n.md', 7, 2);
    const hash = lastWindowHash() ?? '';
    expect(hash).toContain('file=%2Fx%2Fn.md');
    expect(hash).toContain('line=7');
    expect(hash).toContain('col=2');
  });

  it('omits line/col when null', async () => {
    await openFileInNewWindow('/x/n.md', null, null);
    const hash = lastWindowHash() ?? '';
    expect(hash).toContain('file=');
    expect(hash).not.toContain('line=');
    expect(hash).not.toContain('col=');
  });
});

describe('consumeWindowSeed — URL hash parsing', () => {
  function withHash(hash: string, fn: () => Promise<void>): Promise<void> {
    const original = window.location.hash;
    Object.defineProperty(window.location, 'hash', { value: hash, writable: true, configurable: true });
    const replaceSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
    return fn().finally(() => {
      Object.defineProperty(window.location, 'hash', { value: original, writable: true, configurable: true });
      replaceSpy.mockRestore();
    });
  }

  it('does nothing when hash is empty', async () => {
    await withHash('', async () => {
      const openProject = vi.fn();
      const openFile = vi.fn();
      await consumeWindowSeed({ openProject, openFile });
      expect(openProject).not.toHaveBeenCalled();
      expect(openFile).not.toHaveBeenCalled();
    });
  });

  it('opens project when #project= is present', async () => {
    await withHash('#project=%2Fwork%2Fp', async () => {
      const openProject = vi.fn();
      const openFile = vi.fn(async () => true);
      await consumeWindowSeed({ openProject, openFile });
      expect(openProject).toHaveBeenCalledWith('/work/p');
      expect(openFile).not.toHaveBeenCalled();
    });
  });

  it('opens file when #file= is present, with line if provided', async () => {
    await withHash('#file=%2Fa.md&line=42', async () => {
      const openProject = vi.fn();
      const openFile = vi.fn(async () => true);
      await consumeWindowSeed({ openProject, openFile });
      expect(openProject).not.toHaveBeenCalled();
      expect(openFile).toHaveBeenCalledWith('/a.md', 42);
    });
  });

  it('clears the hash after dispatching', async () => {
    await withHash('#file=%2Fa.md', async () => {
      const replaceSpy = vi.spyOn(history, 'replaceState');
      await consumeWindowSeed({
        openProject: vi.fn(),
        openFile: vi.fn(async () => true),
      });
      expect(replaceSpy).toHaveBeenCalled();
    });
  });

  it('treats non-numeric or zero line/col as null', async () => {
    await withHash('#file=%2Fa.md&line=abc&col=0', async () => {
      const openFile = vi.fn(async () => true);
      await consumeWindowSeed({
        openProject: vi.fn(),
        openFile,
      });
      // line=abc → null; col=0 ignored (positive only)
      expect(openFile).toHaveBeenCalledWith('/a.md', null);
    });
  });

  it('handles hash without leading #', async () => {
    await withHash('project=%2Fp', async () => {
      const openProject = vi.fn();
      await consumeWindowSeed({
        openProject,
        openFile: vi.fn(async () => true),
      });
      expect(openProject).toHaveBeenCalledWith('/p');
    });
  });
});
