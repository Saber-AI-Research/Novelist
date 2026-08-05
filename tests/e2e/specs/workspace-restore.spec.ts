import { test, expect } from '../fixtures/app-fixture';
import type { ProjectConfig } from '../../../app/lib/ipc/commands';

const PROJECT_DIR = '/mock/workspace-restore';
const VOLUME_DIR = `${PROJECT_DIR}/第一卷`;
const CHAPTER_PATH = `${VOLUME_DIR}/第一章.md`;

const PROJECT_CONFIG: ProjectConfig = {
  project: { name: 'Workspace Restore', type: 'novel', version: '1.0' },
  outline: { order: [] },
  writing: { daily_goal: 0, auto_save_minutes: 1 },
  plugins: { enabled: {} },
};

test.describe('Project workspace restoration', () => {
  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('restores expanded folders and the last active file on reopen', async ({
    app,
    mockState,
  }) => {
    await mockState.openProject(PROJECT_DIR, [
      { name: '第一卷', path: VOLUME_DIR, is_dir: true, size: 0 },
      { name: '第一章.md', path: CHAPTER_PATH, is_dir: false, size: 24 },
    ]);
    await mockState.setProjectConfig(PROJECT_CONFIG);
    await mockState.setFileContent(CHAPTER_PATH, '# 第一章\n\n正文');

    await app.evaluate(path => (window as any).__test_api__.openProject(path), PROJECT_DIR);
    const folder = app.getByTestId('sidebar-folder-第一卷');
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await app.getByTestId('sidebar-file-第一章.md').click();
    await expect(app.getByTestId('tab-第一章.md')).toBeVisible();

    await app.evaluate(path => (window as any).__test_api__.openProject(path), PROJECT_DIR);

    await expect(app.getByTestId('sidebar-folder-第一卷')).toHaveAttribute('aria-expanded', 'true');
    await expect(app.getByTestId('sidebar-file-第一章.md')).toBeVisible();
    await expect(app.getByTestId('tab-第一章.md')).toBeVisible();
  });
});
