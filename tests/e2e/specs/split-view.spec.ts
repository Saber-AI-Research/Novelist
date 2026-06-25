import { test, expect } from '../fixtures/app-fixture';

test.describe('Split View', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('toggling split view shows second pane', async ({ app }) => {
    // Before split: only one tab bar
    const tabBars = app.getByTestId('tab-bar');
    await expect(tabBars).toHaveCount(1);

    // Enable split view
    await app.evaluate(() => (window as any).__test_api__.toggleSplit());
    await app.waitForTimeout(300);

    // After split: two tab bars (one per pane)
    await expect(app.getByTestId('tab-bar')).toHaveCount(2, { timeout: 2000 });

    // Disable split view
    await app.evaluate(() => (window as any).__test_api__.toggleSplit());
    await app.waitForTimeout(300);

    // Back to one tab bar
    await expect(app.getByTestId('tab-bar')).toHaveCount(1, { timeout: 2000 });
  });

  test('dragging a sidebar file to a pane edge splits into a new column', async ({ app }) => {
    await expect(app.getByTestId('tab-bar')).toHaveCount(1);

    // Low-level mouse drag: a real mousedown+move fires native dragstart (which
    // reveals the edge drop zones), then we drop on the right edge of the
    // editor region. dragTo() can't target a zone that only exists mid-drag.
    const src = app.getByTestId('sidebar-file-Chapter 2.md');
    const box = (await src.boundingBox())!;
    const region = (await app.getByTestId('editor-region').boundingBox())!;

    await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.mouse.down();
    await app.mouse.move(box.x + 20, box.y + 20, { steps: 3 });
    await app.mouse.move(region.x + region.width - 20, region.y + region.height / 2, { steps: 8 });
    await app.waitForTimeout(150);
    await app.mouse.up();

    // A second column appeared with its own tab bar.
    await expect(app.getByTestId('tab-bar')).toHaveCount(2, { timeout: 2000 });
    await expect(app.getByTestId('tab-Chapter 2.md')).toBeVisible();
  });
});
