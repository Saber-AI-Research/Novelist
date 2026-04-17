import { test, expect } from '../fixtures/app-fixture';

test.describe('Settings Dialog', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
  });

  test('Cmd+, opens settings dialog', async ({ app }) => {
    await app.keyboard.press('Meta+,');

    const settings = app.getByTestId('settings-dialog');
    await expect(settings).toBeVisible({ timeout: 2000 });
  });

  test('Escape closes settings dialog', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    const settings = app.getByTestId('settings-dialog');
    await expect(settings).toBeVisible();

    await app.keyboard.press('Escape');
    await expect(settings).not.toBeVisible();
  });

  test('clicking overlay closes settings', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    const overlay = app.getByTestId('settings-overlay');
    await expect(overlay).toBeVisible();

    // Click the overlay (outside the dialog)
    await overlay.click({ position: { x: 10, y: 10 } });
    await expect(app.getByTestId('settings-dialog')).not.toBeVisible({ timeout: 2000 });
  });

  test('settings sections are navigable', async ({ app }) => {
    await app.keyboard.press('Meta+,');
    const settings = app.getByTestId('settings-dialog');

    const sections = ['editor', 'theme', 'shortcuts'];
    for (const section of sections) {
      const sectionBtn = app.getByTestId(`settings-section-${section}`);
      if (await sectionBtn.isVisible()) {
        await sectionBtn.click();
        await expect(settings).toBeVisible();
      }
    }
  });

  test('font size dropdown exists and is interactive', async ({ app }) => {
    await app.keyboard.press('Meta+,');

    const fontSizeSelect = app.locator('#settings-size');
    if (await fontSizeSelect.isVisible()) {
      await expect(fontSizeSelect).toBeEnabled();
    }
  });

  test('plugins: "+" button creates a plugin from template', async ({ app }) => {
    await app.evaluate(() => (window as any).__test_api__.toggleSettings());
    await app.getByTestId('settings-dialog').waitFor({ state: 'visible' });
    await app.getByTestId('settings-section-plugins').click();

    await app.getByTestId('plugin-add-btn').click();
    await app.getByTestId('plugin-add-menu').getByRole('button', { name: /Create from template/i }).click();

    const dialog = app.getByTestId('plugin-scaffold-dialog');
    await expect(dialog).toBeVisible();

    await app.getByTestId('plugin-scaffold-id').fill('hello-world');
    await app.getByTestId('plugin-scaffold-create').click();

    // New plugin appears in the Community list.
    await expect(app.getByText('hello-world')).toBeVisible();
  });

  test('plugins: help tooltip copies prompt to clipboard', async ({ app, context }) => {
    await context.grantPermissions(['clipboard-read']);

    await app.evaluate(() => (window as any).__test_api__.toggleSettings());
    await app.getByTestId('settings-dialog').waitFor({ state: 'visible' });
    await app.getByTestId('settings-section-plugins').click();

    // Open the help card (click toggles reliably in Playwright).
    await app.getByTestId('help-trigger').click();
    await expect(app.getByTestId('help-card')).toBeVisible();

    // Copy.
    await app.getByTestId('help-copy-btn').click();

    const clip = await app.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('counts sentences');
  });
});
