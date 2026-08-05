import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadProjectWorkspaceState,
  removeProjectWorkspacePath,
  resolveProjectWorkspacePath,
  retargetProjectWorkspaceState,
  saveProjectWorkspaceState,
  toProjectRelativePath,
} from '$lib/services/project-workspace-state';

describe('[contract] project workspace state', () => {
  beforeEach(() => localStorage.clear());

  it('stores only safe project-relative paths and restores CJK paths', () => {
    const project = '/写作/雪中悍刀行';
    const saved = saveProjectWorkspaceState(project, {
      version: 1,
      expandedPaths: ['学习内容', '学习内容/01 白马出凉州', '../越界'],
      lastOpenPath: '学习内容/01 白马出凉州/0004 小二上酒.litstudy',
    });

    expect(saved.expandedPaths).toEqual(['学习内容', '学习内容/01 白马出凉州']);
    expect(loadProjectWorkspaceState(project)).toEqual(saved);
    expect(resolveProjectWorkspacePath(project, saved.lastOpenPath!)).toBe(
      '/写作/雪中悍刀行/学习内容/01 白马出凉州/0004 小二上酒.litstudy',
    );
  });

  it('normalizes Windows paths case-insensitively', () => {
    expect(toProjectRelativePath(
      'C:\\Writing\\Novel',
      'c:\\writing\\novel\\第一卷\\第一章.md',
    )).toBe('第一卷/第一章.md');
    expect(resolveProjectWorkspacePath(
      'C:\\Writing\\Novel',
      '第一卷/第一章.md',
    )).toBe('C:\\Writing\\Novel\\第一卷\\第一章.md');
  });

  it('retargets folder descendants and the last-open file after rename', () => {
    const project = '/project';
    const state = saveProjectWorkspaceState(project, {
      version: 1,
      expandedPaths: ['旧卷', '旧卷/子目录'],
      lastOpenPath: '旧卷/第一章.md',
    });

    const retargeted = retargetProjectWorkspaceState(
      project,
      state,
      '/project/旧卷',
      '/project/新卷',
    );

    expect(retargeted.expandedPaths).toEqual(['新卷', '新卷/子目录']);
    expect(retargeted.lastOpenPath).toBe('新卷/第一章.md');
  });

  it('removes deleted branches without disturbing sibling state', () => {
    const project = '/project';
    const state = saveProjectWorkspaceState(project, {
      version: 1,
      expandedPaths: ['删除我', '删除我/子目录', '保留'],
      lastOpenPath: '删除我/第一章.md',
    });

    const pruned = removeProjectWorkspacePath(project, state, '/project/删除我');

    expect(pruned.expandedPaths).toEqual(['保留']);
    expect(pruned.lastOpenPath).toBeNull();
  });
});
