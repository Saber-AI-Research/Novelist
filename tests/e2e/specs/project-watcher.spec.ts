import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

test.describe('project watcher ownership', () => {
  test('watcher start failure keeps the current workspace uncommitted and reports the failure', async ({
    app,
    mockState,
  }) => {
    const blockedProject = '/mock/watcher-blocked';

    await app.evaluate((projectDir) => {
      const state = (window as any).__TAURI_MOCK_STATE__;
      state.setWatcherStartError(projectDir, 'native watcher unavailable');
      return (window as any).__test_api__.openProject(projectDir);
    }, blockedProject);

    await expect(app.getByTestId('operation-error')).toContainText(
      'external-change monitoring is unavailable',
    );
    await expect(app.getByTestId('app-layout')).toHaveCount(0);
    await expect(app.getByTestId('welcome-screen')).toBeVisible();

    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'start_file_watcher')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'add_recent_project')).toHaveLength(0);
  });

  test('watcher start failure restores single-file tracking', async ({ app, mockState }) => {
    const filePath = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
    const blockedProject = '/mock/watcher-blocked-after-single-file';

    await app.evaluate((path) => (window as any).__test_api__.openFile(path), filePath);
    await expect(app.getByTestId('editor-container')).toBeVisible();

    await app.evaluate((projectDir) => {
      const state = (window as any).__TAURI_MOCK_STATE__;
      state.setWatcherStartError(projectDir, 'native watcher unavailable');
      return (window as any).__test_api__.openProject(projectDir);
    }, blockedProject);

    await expect(app.getByTestId('operation-error')).toContainText(
      'external-change monitoring is unavailable',
    );
    await expect(app.getByTestId('editor-container')).toBeVisible();
    const calls = await mockState.getInvokeCalls();
    const registrations = calls.filter(
      call => call.command === 'register_open_file' && call.args.path === filePath,
    );
    expect(registrations).toHaveLength(2);
    expect(calls.filter(call => call.command === 'stop_file_watcher')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'add_recent_project')).toHaveLength(0);
  });
});
