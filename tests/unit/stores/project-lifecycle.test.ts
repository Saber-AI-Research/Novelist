import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * [contract] projectStore — lifecycle + tree ops not covered by the
 * sort / tree suites. Exercises setProject, updateFiles, close,
 * enterSingleFileMode, and the listDirectory error branches inside
 * expandFolder / refreshFolder.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
  },
}));

vi.mock('$lib/stores/settings.svelte', () => ({
  settingsStore: {
    effective: {
      view: { sort_mode: 'numeric-asc', show_hidden_files: false },
      new_file: { template: '', detect_from_folder: true, auto_rename_from_h1: true, default_dir: null, last_used_dir: null },
      plugins: { enabled: {} },
      is_project_scoped: false,
    },
    load: vi.fn().mockResolvedValue(undefined),
    writeView: vi.fn().mockResolvedValue(undefined),
  },
}));

import { projectStore } from '$lib/stores/project.svelte';
import { commands } from '$lib/ipc/commands';

function entry(name: string, isDir: boolean, path = `/proj/${name}`) {
  return { name, path, is_dir: isDir, size: 0, mtime: 0 };
}

beforeEach(() => {
  projectStore.close();
  vi.clearAllMocks();
});

describe('[contract] projectStore.setProject / close / enterSingleFileMode', () => {
  it('setProject populates dirPath, files, and clears loading', () => {
    projectStore.setProject('/proj', null, [entry('a.md', false), entry('sub', true)]);
    expect(projectStore.dirPath).toBe('/proj');
    expect(projectStore.files).toHaveLength(2);
    expect(projectStore.isLoading).toBe(false);
    expect(projectStore.singleFileMode).toBe(false);
    expect(projectStore.isOpen).toBe(true);
  });

  it('close resets every field and drops back to global settings', () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    projectStore.close();
    expect(projectStore.dirPath).toBeNull();
    expect(projectStore.files).toEqual([]);
    expect(projectStore.singleFileMode).toBe(false);
    expect(projectStore.isOpen).toBe(false);
  });

  it('enterSingleFileMode sets the flag and clears project state', () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    projectStore.enterSingleFileMode();
    expect(projectStore.singleFileMode).toBe(true);
    expect(projectStore.dirPath).toBeNull();
    expect(projectStore.files).toEqual([]);
    // isOpen is true in single-file mode (even without a dirPath).
    expect(projectStore.isOpen).toBe(true);
  });

  it('name falls back to the dir basename when no config provides one', () => {
    projectStore.setProject('/Users/x/NovelProject', null, []);
    expect(projectStore.name).toBe('NovelProject');
  });

  it('name returns "No Project" when closed', () => {
    projectStore.close();
    expect(projectStore.name).toBe('No Project');
  });

  it('name uses config.project.name when present', () => {
    const config = { project: { name: 'My Novel' } } as any;
    projectStore.setProject('/Users/x/dir', config, []);
    expect(projectStore.name).toBe('My Novel');
  });

  it('name returns "Untitled" when dirPath ends with a trailing slash (empty basename)', () => {
    projectStore.setProject('/', null, []);
    expect(projectStore.name).toBe('Untitled');
  });
});

describe('[contract] projectStore.updateFiles', () => {
  it('preserves expansion state of still-present folders', async () => {
    projectStore.setProject('/proj', null, [entry('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [entry('x.md', false, '/proj/sub/x.md')],
    });
    await projectStore.expandFolder('/proj/sub');

    projectStore.updateFiles([entry('sub', true), entry('new.md', false)]);

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.expanded).toBe(true);
    expect(sub.children).toHaveLength(1);
    // The new file is present too.
    expect(projectStore.files.map(f => f.name)).toContain('new.md');
  });

  it('resets when a folder path disappears from the new list', () => {
    projectStore.setProject('/proj', null, [entry('a', true), entry('b.md', false)]);
    projectStore.updateFiles([entry('c.md', false)]);
    expect(projectStore.files.map(f => f.name)).toEqual(['c.md']);
  });
});

describe('[contract] projectStore.findFolder', () => {
  it('returns undefined for a file node (not a folder)', () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    expect(projectStore.findFolder('/proj/a.md')).toBeUndefined();
  });

  it('returns undefined for a missing path', () => {
    projectStore.setProject('/proj', null, [entry('sub', true)]);
    expect(projectStore.findFolder('/proj/ghost')).toBeUndefined();
  });
});

describe('[contract] projectStore.expandFolder — listDirectory error branch', () => {
  it('sets children=[] when listDirectory errors (so "loaded but empty")', async () => {
    projectStore.setProject('/proj', null, [entry('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({ status: 'error', error: 'denied' });

    await projectStore.expandFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.children).toEqual([]);
    expect(sub.expanded).toBe(true);
    expect(sub.loading).toBe(false);
  });

  it('is a no-op when the folder path is not in the tree', async () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    await projectStore.expandFolder('/proj/ghost');
    expect(commands.listDirectory).not.toHaveBeenCalled();
  });
});

describe('[contract] projectStore.refreshFolder', () => {
  it('refreshes the project root when path equals dirPath', async () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [entry('a.md', false), entry('b.md', false)],
    });

    await projectStore.refreshFolder('/proj');

    expect(projectStore.files.map(f => f.name)).toEqual(['a.md', 'b.md']);
  });

  it('silently no-ops when the root-refresh listDirectory errors', async () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    (commands.listDirectory as any).mockResolvedValue({ status: 'error', error: 'io' });

    await projectStore.refreshFolder('/proj');

    // Unchanged from original.
    expect(projectStore.files).toHaveLength(1);
    expect(projectStore.files[0].name).toBe('a.md');
  });

  it('no-ops when the target folder was never expanded (undefined children)', async () => {
    projectStore.setProject('/proj', null, [entry('sub', true)]);

    await projectStore.refreshFolder('/proj/sub');

    expect(commands.listDirectory).not.toHaveBeenCalled();
  });

  it('no-ops on unknown path (not in tree)', async () => {
    projectStore.setProject('/proj', null, [entry('a.md', false)]);
    await projectStore.refreshFolder('/proj/ghost');
    expect(commands.listDirectory).not.toHaveBeenCalled();
  });

  it('silently returns when listDirectory errors after a prior expand', async () => {
    projectStore.setProject('/proj', null, [entry('sub', true)]);
    (commands.listDirectory as any).mockResolvedValueOnce({ status: 'ok', data: [] });
    await projectStore.expandFolder('/proj/sub');

    (commands.listDirectory as any).mockResolvedValueOnce({ status: 'error', error: 'io' });
    await projectStore.refreshFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.children).toEqual([]); // unchanged
  });
});
