import { describe, it, expect, beforeEach, vi } from 'vitest';
import { projectStore, type FileNode } from '$lib/stores/project.svelte';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';

function node(name: string, isDir: boolean, path = `/proj/${name}`): FileNode {
  return { name, path, is_dir: isDir, size: 0, expanded: false, loading: false };
}

describe('projectStore tree extensions', () => {
  beforeEach(() => {
    projectStore.close();
    vi.clearAllMocks();
  });

  it('expandFolder lazily loads children on first call', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
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
    projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({ status: 'ok', data: [] });

    await projectStore.expandFolder('/proj/sub');
    projectStore.collapseFolder('/proj/sub');
    await projectStore.expandFolder('/proj/sub');

    expect(commands.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('collapseFolder preserves cached children', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
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

  it('refreshFolder re-fetches an already-loaded folder', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
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
