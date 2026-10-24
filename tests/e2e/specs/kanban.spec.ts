import { test, expect, openRecentProject } from '../fixtures/app-fixture';

test.describe('Kanban file-handler', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
  });

  test('sidebar lists .kanban files', async ({ app }) => {
    const file = app.getByTestId('sidebar-file-board.kanban');
    await expect(file).toBeVisible();
  });

  test('opening a .kanban file routes to the native kanban editor, not the markdown editor', async ({ app }) => {
    await app.getByTestId('sidebar-file-board.kanban').click();
    // Native KanbanFileEditor should appear; CodeMirror should not.
    await app.getByTestId('kanban-file-editor').waitFor({ state: 'attached', timeout: 5000 });
    await expect(app.locator('.cm-editor')).toHaveCount(0);
  });

  test('kanban editor renders its board shell once the impl chunk loads', async ({ app }) => {
    await app.getByTestId('sidebar-file-board.kanban').click();
    const wrapper = app.getByTestId('kanban-file-editor');
    await wrapper.waitFor({ state: 'visible', timeout: 5000 });
    // The impl is dynamic-imported; wait for the board to mount (not the
    // loading spinner). `.board` is the KanbanImpl root element.
    await expect(wrapper.locator('.board')).toBeVisible({ timeout: 5000 });
  });
});
