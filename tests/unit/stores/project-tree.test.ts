import { describe, it, expect, beforeEach, vi } from 'vitest';
import { projectStore, type FileNode } from '$lib/stores/project.svelte';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';

function node(name: string, isDir: boolean, path = `/proj/${name}`): FileNode {
  return { name, path, is_dir: isDir, size: 0, mtime: null, ctime: null, expanded: false, loading: false };
}

describe('projectStore tree extensions', () => {
  beforeEach(async () => {
    localStorage.clear();
    await projectStore.close();
    vi.clearAllMocks();
  });

  it('expandFolder lazily loads children on first call', async () => {
    await projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.expanded).toBe(true);
    expect(sub.children).toHaveLength(1);
    expect(sub.children![0].name).toBe('a.md');
    expect(commands.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('expandFolder does not re-fetch when children already loaded', async () => {
    await projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({ status: 'ok', data: [] });

    await projectStore.expandFolder('/proj/sub');
    projectStore.collapseFolder('/proj/sub');
    await projectStore.expandFolder('/proj/sub');

    expect(commands.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('collapseFolder preserves cached children', async () => {
    await projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');
    projectStore.collapseFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.expanded).toBe(false);
    expect(sub.children).toHaveLength(1);
  });

  it('expandFolderRecursive expands the subtree and lazily loads each level', async () => {
    // Root: a/ b/   a/: a1/   a/a1/: leaf.md
    await projectStore.setProject('/proj', null, [node('a', true, '/proj/a'), node('b', true, '/proj/b')]);

    (commands.listDirectory as any).mockImplementation((p: string) => {
      if (p === '/proj/a') return Promise.resolve({ status: 'ok', data: [{ name: 'a1', path: '/proj/a/a1', is_dir: true, size: 0 }] });
      if (p === '/proj/a/a1') return Promise.resolve({ status: 'ok', data: [{ name: 'leaf.md', path: '/proj/a/a1/leaf.md', is_dir: false, size: 0 }] });
      if (p === '/proj/b') return Promise.resolve({ status: 'ok', data: [] });
      return Promise.resolve({ status: 'ok', data: [] });
    });

    await projectStore.expandFolderRecursive('/proj');

    const a = projectStore.files.find(f => f.path === '/proj/a')!;
    const b = projectStore.files.find(f => f.path === '/proj/b')!;
    expect(a.expanded).toBe(true);
    expect(b.expanded).toBe(true);
    const a1 = a.children!.find(f => f.path === '/proj/a/a1')!;
    expect(a1.expanded).toBe(true);
    expect(a1.children).toHaveLength(1);
  });

  it('collapseFolderRecursive collapses every descendant without unloading children', async () => {
    await projectStore.setProject('/proj', null, [node('a', true, '/proj/a')]);
    (commands.listDirectory as any).mockImplementation((p: string) => {
      if (p === '/proj/a') return Promise.resolve({ status: 'ok', data: [{ name: 'a1', path: '/proj/a/a1', is_dir: true, size: 0 }] });
      if (p === '/proj/a/a1') return Promise.resolve({ status: 'ok', data: [{ name: 'leaf.md', path: '/proj/a/a1/leaf.md', is_dir: false, size: 0 }] });
      return Promise.resolve({ status: 'ok', data: [] });
    });
    await projectStore.expandFolderRecursive('/proj');

    projectStore.collapseFolderRecursive('/proj');

    const a = projectStore.files.find(f => f.path === '/proj/a')!;
    const a1 = a.children!.find(f => f.path === '/proj/a/a1')!;
    expect(a.expanded).toBe(false);
    expect(a1.expanded).toBe(false);
    // Cached children survive — re-expansion is instant.
    expect(a1.children).toHaveLength(1);
  });

  it('refreshFolder re-fetches an already-loaded folder', async () => {
    await projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValueOnce({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');

    (commands.listDirectory as any).mockResolvedValueOnce({
      status: 'ok',
      data: [
        { name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 },
        { name: 'b.md', path: '/proj/sub/b.md', is_dir: false, size: 0 },
      ],
    });

    await projectStore.refreshFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.children).toHaveLength(2);
    expect(sub.expanded).toBe(true);
  });
});
