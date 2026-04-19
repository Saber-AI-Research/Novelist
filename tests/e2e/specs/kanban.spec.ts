import { test, expect } from '../fixtures/app-fixture';

test.describe('Kanban file-handler plugin', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
  });

  test('sidebar lists .kanban files', async ({ app }) => {
    const file = app.getByTestId('sidebar-file-board.kanban');
    await expect(file).toBeVisible();
  });

  test('opening a .kanban file routes to the plugin file editor, not the markdown editor', async ({ app }) => {
    await app.getByTestId('sidebar-file-board.kanban').click();
    // Plugin-served iframe should appear; CodeMirror editor should not.
    await app.locator('.plugin-file-editor iframe').waitFor({ state: 'attached', timeout: 5000 });
    await expect(app.locator('.plugin-file-editor iframe')).toHaveAttribute('title', 'Kanban');
    await expect(app.locator('.cm-editor')).toHaveCount(0);
  });

  test('iframe source is resolved through the plugin entry url', async ({ app }) => {
    await app.getByTestId('sidebar-file-board.kanban').click();
    const src = await app.locator('.plugin-file-editor iframe').getAttribute('src');
    // Mock convertFileSrc keeps the raw path; just confirm entry html is targeted.
    expect(src).toMatch(/index\.html$/);
  });
});
