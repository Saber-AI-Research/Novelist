import { test, expect, openRecentProject } from '../fixtures/app-fixture';

test.describe('Zen Mode', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('entering zen mode hides chrome', async ({ app }) => {
    // Use test API (browser intercepts F11 for fullscreen)
    await app.evaluate(() => (window as any).__test_api__.toggleZen());

    const zenMode = app.getByTestId('zen-mode');
    await expect(zenMode).toBeVisible({ timeout: 2000 });

    await expect(app.getByTestId('sidebar')).not.toBeVisible();
    await expect(app.getByTestId('tab-bar')).not.toBeVisible();
  });

  test('exiting zen mode restores chrome', async ({ app }) => {
    await app.evaluate(() => (window as any).__test_api__.toggleZen());
    await expect(app.getByTestId('zen-mode')).toBeVisible({ timeout: 2000 });

    // Escape exits zen mode (not intercepted by browser)
    await app.keyboard.press('Escape');
    await expect(app.getByTestId('zen-mode')).not.toBeVisible({ timeout: 2000 });

    await expect(app.getByTestId('sidebar')).toBeVisible();
  });

  test('can still edit in zen mode', async ({ app }) => {
    await app.evaluate(() => (window as any).__test_api__.toggleZen());
    await expect(app.getByTestId('zen-mode')).toBeVisible({ timeout: 2000 });

    const cmEditor = app.locator('.cm-editor');
    await cmEditor.click();
    await app.keyboard.type('Zen writing');

    const cmContent = app.locator('.cm-content');
    await expect(cmContent).toContainText('Zen writing');

    await app.keyboard.press('Escape');
  });
});
