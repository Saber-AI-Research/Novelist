import { test, expect, openRecentProject } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

test.describe('File Operations', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
  });

  test('open file, edit content, and save', async ({ app, appKeys, mockState }) => {
    const fileItem = app.getByTestId('sidebar-file-Chapter 1.md');
    await fileItem.click();
    await app.getByTestId('editor-container').waitFor({ state: 'visible' });

    const cmEditor = app.locator('.cm-editor');
    await cmEditor.waitFor({ state: 'visible', timeout: 5000 });
    await cmEditor.click();

    await app.keyboard.type('Hello World');
    await expect(app.locator('.dirty-dot')).toBeVisible();

    // The browser intercepts a real Meta+S, so dispatch it to the app directly.
    await appKeys.press('s', { metaKey: true });

    await expect.poll(async () => (await mockState.getWrittenFiles())[`${MOCK_PROJECT_DIR}/Chapter 1.md`] ?? '')
      .toContain('Hello World');
    await expect(app.locator('.dirty-dot')).toHaveCount(0);
  });

  test('Cmd+N creates a new file', async ({ app }) => {
    await app.keyboard.press('Meta+n');

    await expect(app.getByTestId('editor-container')).toBeVisible();

    const tabBar = app.getByTestId('tab-bar');
    await expect(tabBar).toBeVisible();
  });

  test('Cmd+W closes the current tab', async ({ app, appKeys }) => {
    const fileItem = app.getByTestId('sidebar-file-Chapter 1.md');
    await fileItem.click();
    await app.getByTestId('editor-container').waitFor({ state: 'visible' });
    await expect(app.getByTestId('tab-Chapter 1.md')).toBeVisible();

    await appKeys.press('w', { metaKey: true });

    await expect(app.getByTestId('tab-Chapter 1.md')).toHaveCount(0);
  });

  test('editing content marks tab as dirty', async ({ app }) => {
    const fileItem = app.getByTestId('sidebar-file-Chapter 2.md');
    await fileItem.click();

    const cmEditor = app.locator('.cm-editor');
    await cmEditor.waitFor({ state: 'visible', timeout: 5000 });
    await cmEditor.click();

    await app.keyboard.type('Modified');

    const dirtyDot = app.locator('.dirty-dot');
    await expect(dirtyDot).toBeVisible({ timeout: 2000 });
  });
});
