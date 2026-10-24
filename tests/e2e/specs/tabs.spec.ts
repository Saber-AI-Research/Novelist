import { test, expect, openRecentProject } from '../fixtures/app-fixture';

test.describe('Tab Management', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
  });

  test('opening multiple files creates multiple tabs', async ({ app }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    await app.getByTestId('sidebar-file-Chapter 2.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    const tabBar = app.getByTestId('tab-bar');
    await expect(tabBar).toContainText('Chapter 1');
    await expect(tabBar).toContainText('Chapter 2');
  });

  test('clicking a tab switches to that file', async ({ app }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
    await app.getByTestId('sidebar-file-Chapter 2.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    const tab1 = app.locator('[data-testid^="tab-Chapter 1"]');
    await tab1.click();

    const cmContent = app.locator('.cm-content');
    await expect(cmContent).toContainText('dark and stormy night');
  });

  test('closing a tab with click on X button', async ({ app }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    const closeBtn = app.locator('[data-testid^="tab-close-Chapter 1"]');
    await closeBtn.click();

    const tabBar = app.getByTestId('tab-bar');
    await expect(tabBar).not.toContainText('Chapter 1');
  });

  test('Cmd+W closes active tab', async ({ app }) => {
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });

    await app.keyboard.press('Meta+w');

    const tabBar = app.getByTestId('tab-bar');
    await expect(tabBar).not.toContainText('Chapter 1');
  });
});
