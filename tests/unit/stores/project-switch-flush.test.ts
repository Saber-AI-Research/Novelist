import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
  },
}));

vi.mock('$lib/stores/settings.svelte', () => ({
  settingsStore: {
    effective: {
      view: {
        sort_mode: 'numeric-asc',
        show_hidden_files: false,
        wrap_file_names: false,
        sidebar_font_size: 14,
      },
      new_file: {
        template: '',
        detect_from_folder: true,
        auto_rename_from_h1: true,
        default_dir: null,
        last_used_dir: null,
      },
      plugins: { enabled: {} },
      is_project_scoped: false,
    },
    load: vi.fn().mockResolvedValue(undefined),
    writeView: vi.fn().mockResolvedValue(undefined),
  },
}));

import { projectStore } from '$lib/stores/project.svelte';
import {
  __resetProjectSwitchFlushProvidersForTests,
  registerProjectSwitchFlushProvider,
} from '$lib/services/project-switch-coordinator';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('projectStore <> project-switch-coordinator wiring', () => {
  beforeEach(async () => {
    __resetProjectSwitchFlushProvidersForTests();
    await projectStore.close();
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetProjectSwitchFlushProvidersForTests();
  });

  it('setProject(A -> B) invokes providers with (A, B) BEFORE mutating dirPath', async () => {
    await projectStore.setProject('/A', null, []);
    const events: Array<{
      previous: string | null;
      next: string | null;
      seenDirPath: string | null;
    }> = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      events.push({ previous, next, seenDirPath: projectStore.dirPath });
    });

    await projectStore.setProject('/B', null, []);
    expect(events).toEqual([{ previous: '/A', next: '/B', seenDirPath: '/A' }]);
    expect(projectStore.dirPath).toBe('/B');
  });

  it('close from A -> null invokes providers with (A, null)', async () => {
    await projectStore.setProject('/A', null, []);
    const events: Array<{ previous: string | null; next: string | null }> = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      events.push({ previous, next });
    });

    await projectStore.close();
    expect(events).toEqual([{ previous: '/A', next: null }]);
    expect(projectStore.dirPath).toBeNull();
  });

  it('close from single-file mode invokes providers with (null, null)', async () => {
    await projectStore.enterSingleFileMode();
    expect(projectStore.singleFileMode).toBe(true);
    const events: Array<{ previous: string | null; next: string | null }> = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      events.push({ previous, next });
    });

    await projectStore.close();
    expect(events).toEqual([{ previous: null, next: null }]);
    expect(projectStore.singleFileMode).toBe(false);
  });

  it('setProject to the same project does not invoke providers', async () => {
    await projectStore.setProject('/A', null, []);
    const called = vi.fn();
    registerProjectSwitchFlushProvider(called);

    await projectStore.setProject('/A', null, []);
    expect(called).not.toHaveBeenCalled();
  });

  it('rejects a late project commit after a newer same-path generation wins', async () => {
    const initialGeneration = projectStore.generation;
    await projectStore.setProject('/A', null, [], initialGeneration + 1);
    const bFlush = deferred();
    registerProjectSwitchFlushProvider(async (_previous, next) => {
      if (next === '/B') await bFlush.promise;
    });

    const staleB = projectStore.setProject('/B', null, [{
      name: 'B.md', path: '/B/B.md', is_dir: false, size: 1, mtime: null, ctime: null,
    }], initialGeneration + 2);
    await Promise.resolve();
    await projectStore.setProject('/A', null, [], initialGeneration + 3);
    bFlush.resolve();
    expect(await staleB).toBe(false);

    expect(projectStore.dirPath).toBe('/A');
    expect(projectStore.generation).toBe(initialGeneration + 3);
    expect(projectStore.files).toEqual([]);
  });

  it('a provider rejection blocks the project transition', async () => {
    await projectStore.setProject('/A', null, []);
    registerProjectSwitchFlushProvider(async () => {
      throw new Error('flush failed');
    });

    await expect(projectStore.setProject('/B', null, [])).rejects.toThrow('flush failed');
    expect(projectStore.dirPath).toBe('/A');
  });

  it('enterSingleFileMode invokes providers with (previous, null)', async () => {
    await projectStore.setProject('/A', null, []);
    const events: Array<{ previous: string | null; next: string | null }> = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      events.push({ previous, next });
    });

    await projectStore.enterSingleFileMode();
    expect(events).toEqual([{ previous: '/A', next: null }]);
    expect(projectStore.singleFileMode).toBe(true);
    expect(projectStore.dirPath).toBeNull();
  });
});
