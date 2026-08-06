import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const deleteItem = vi.fn();
  const project = {
    dirPath: '/project' as string | null,
    removeWorkspacePath: vi.fn(),
    refreshFolder: vi.fn(async (_path: string) => {}),
  };
  const tabs = {
    allTabs: [] as Array<{ id: string; filePath: string }>,
    closeTab: vi.fn(async (id: string) => {
      tabs.allTabs = tabs.allTabs.filter(tab => tab.id !== id);
    }),
    findByPath: vi.fn((path: string) => tabs.allTabs.find(tab => tab.filePath === path)),
  };
  return { deleteItem, project, tabs };
});

vi.mock('$lib/ipc/commands', () => ({
  commands: { deleteItem: h.deleteItem },
}));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: h.project,
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: h.tabs,
}));

import { collapseNestedTargets, deleteEntries } from '$lib/services/file-deletion';

const t = (key: string, params?: Record<string, string | number>) => `${key}:${JSON.stringify(params)}`;

beforeEach(() => {
  h.deleteItem.mockReset().mockResolvedValue({ status: 'ok', data: null });
  h.project.dirPath = '/project';
  h.project.removeWorkspacePath.mockReset();
  h.project.refreshFolder.mockReset().mockResolvedValue(undefined);
  h.tabs.allTabs = [];
  h.tabs.closeTab.mockClear();
  h.tabs.findByPath.mockClear();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('[contract] collapseNestedTargets', () => {
  it('deduplicates paths and lets a selected folder own its descendants', () => {
    const targets = collapseNestedTargets([
      { path: '/project/章节', name: '章节', is_dir: true },
      { path: '/project/章节/第一章.md', name: '第一章.md', is_dir: false },
      { path: '/project/章节', name: '章节 duplicate', is_dir: true },
      { path: '/project/旁白.md', name: '旁白.md', is_dir: false },
    ]);

    expect(targets.map(target => target.path)).toEqual(['/project/章节', '/project/旁白.md']);
  });
});

describe('[contract] deleteEntries', () => {
  it('does not close tabs or touch disk when the shared confirmation is declined', async () => {
    vi.mocked(confirm).mockReturnValue(false);

    const result = await deleteEntries([
      { path: '/project/第一章.md', name: '第一章.md', is_dir: false },
    ], t);

    expect(result.status).toBe('cancelled');
    expect(h.tabs.closeTab).not.toHaveBeenCalled();
    expect(h.deleteItem).not.toHaveBeenCalled();
  });

  it('aborts before filesystem mutation when an affected tab refuses to close', async () => {
    h.tabs.allTabs = [{ id: 'dirty', filePath: '/project/第一章.md' }];
    h.tabs.closeTab.mockImplementationOnce(async () => {});

    const result = await deleteEntries([
      { path: '/project/第一章.md', name: '第一章.md', is_dir: false },
    ], t);

    expect(result.status).toBe('cancelled');
    expect(h.deleteItem).not.toHaveBeenCalled();
  });

  it('closes affected tabs, reports partial failure, and refreshes successful parents once', async () => {
    h.tabs.allTabs = [
      { id: 'inside-folder', filePath: '/project/章节/第一章.md' },
      { id: 'separate', filePath: '/project/旁白.md' },
      { id: 'unrelated', filePath: '/project/保留.md' },
    ];
    h.deleteItem
      .mockResolvedValueOnce({ status: 'ok', data: null })
      .mockResolvedValueOnce({ status: 'error', error: 'locked' });

    const result = await deleteEntries([
      { path: '/project/章节', name: '章节', is_dir: true },
      { path: '/project/章节/第一章.md', name: '第一章.md', is_dir: false },
      { path: '/project/旁白.md', name: '旁白.md', is_dir: false },
    ], t);

    expect(result).toEqual({
      status: 'completed',
      deletedPaths: ['/project/章节'],
      failedPaths: ['/project/旁白.md'],
    });
    expect(h.tabs.closeTab).toHaveBeenCalledTimes(2);
    expect(h.tabs.allTabs).toEqual([{ id: 'unrelated', filePath: '/project/保留.md' }]);
    expect(h.deleteItem.mock.calls.map(call => call[0])).toEqual(['/project/章节', '/project/旁白.md']);
    expect(h.project.removeWorkspacePath).toHaveBeenCalledWith('/project/章节');
    expect(h.project.removeWorkspacePath).toHaveBeenCalledTimes(1);
    expect(h.project.refreshFolder).toHaveBeenCalledWith('/project');
    expect(h.project.refreshFolder).toHaveBeenCalledTimes(1);
  });
});
