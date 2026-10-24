import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

/**
 * Verifies the Welcome-screen recent-project list supports pinning (keeps the
 * pinned project above unpinned ones) and manual reordering via drag-and-drop.
 * The underlying sort lives in `core/src/commands/recent.rs::sort_projects`
 * and is mirrored in the Tauri mock so this spec exercises the full UI path.
 */
test.describe('Recent projects: pin and reorder', () => {
  test('pinning a project moves it to the top and toggles off cleanly', async ({ app }) => {
    await app.waitForSelector('[data-testid="welcome-screen"]', { timeout: 5000 });
    // Initial: third project is last (index 2). Pin it → becomes index 0.
    const thirdRow = app.getByTestId('recent-project-2');
    await expect(thirdRow).toContainText('Third Draft');

    await app.getByTestId('recent-project-pin-2').click();

    // After pinning, the Third Draft project should be first.
    await expect(app.getByTestId('recent-project-0')).toContainText('Third Draft');

    // Unpin it — should sink back below unpinned projects (by last_opened desc).
    await app.getByTestId('recent-project-pin-0').click();
    await expect(app.getByTestId('recent-project-0')).not.toContainText('Third Draft');
  });

  test('dropping a row reorders the list and persists the dropped order', async ({ app, mockState }) => {
    await expect(app.getByTestId('recent-project-2')).toContainText('Third Draft');
    await mockState.reset();

    // Dispatch the HTML5 drag sequence the row handlers listen to; mouse-driven
    // dragTo does not reliably start a native drag on every engine.
    const row0 = app.getByTestId('recent-project-0').locator('..');
    const row2 = app.getByTestId('recent-project-2').locator('..');
    const dataTransfer = await app.evaluateHandle(() => new DataTransfer());
    await row0.dispatchEvent('dragstart', { dataTransfer });
    await row2.dispatchEvent('dragover', { dataTransfer });
    await row2.dispatchEvent('drop', { dataTransfer });
    await row0.dispatchEvent('dragend', { dataTransfer });

    await expect(app.getByTestId('recent-project-0')).toContainText('Another Story');
    await expect(app.getByTestId('recent-project-1')).toContainText('Third Draft');
    await expect(app.getByTestId('recent-project-2')).toContainText('Test Novel');
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter(call => call.command === 'reorder_recent_projects')
      .map(call => call.args.orderedPaths)).toEqual([
      ['/tmp/another-project', '/tmp/third-project', MOCK_PROJECT_DIR],
    ]);
  });
});
