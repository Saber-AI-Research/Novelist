import { test, expect, openRecentProject } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

test.describe('Split View', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('toggling split view shows second pane', async ({ app }) => {
    // Before split: only one tab bar
    const tabBars = app.getByTestId('tab-bar');
    await expect(tabBars).toHaveCount(1);

    // Enable split view
    await app.evaluate(() => (window as any).__test_api__.toggleSplit());

    // After split: two tab bars (one per pane)
    await expect(app.getByTestId('tab-bar')).toHaveCount(2, { timeout: 2000 });

    // Disable split view
    await app.evaluate(() => (window as any).__test_api__.toggleSplit());

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
    await expect(app.locator('.pane-drop-right.pane-drop-active')).toBeVisible();
    await app.mouse.up();

    // A second column appeared with its own tab bar.
    await expect(app.getByTestId('tab-bar')).toHaveCount(2, { timeout: 2000 });
    await expect(app.getByTestId('tab-Chapter 2.md')).toBeVisible();
  });

  test('[regression] saving the right-pane copy of a split file writes the right-pane text', async ({ app, mockState }) => {
    const filePath = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
    await app.evaluate(() => (window as any).__test_api__.toggleSplit());
    await app.getByText('Open a file in this pane').click();
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await expect(app.getByTestId('tab-Chapter 1.md')).toHaveCount(2);
    await expect.poll(() => app.evaluate(() => (window as any).__test_api__.getActiveEditor()?.filePath ?? null))
      .toBe(filePath);

    // Type into the right pane's editor; the left tab of the same file stays
    // behind with the disk text in its store copy.
    await app.evaluate(() => {
      const { view } = (window as any).__test_api__.getActiveEditor();
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
    });
    await app.keyboard.type(' 右栏修改');
    const rightText = await app.evaluate(() => (window as any).__test_api__.getActiveEditor().view.state.doc.toString());
    expect(rightText).toContain('右栏修改');

    const rightBar = app.getByTestId('tab-bar').nth(1);
    await rightBar.getByTestId('tab-Chapter 1.md').hover();
    await rightBar.getByTestId('tab-close-Chapter 1.md').click();
    await expect(app.getByTestId('unsaved-changes-dialog')).toBeVisible();
    await app.getByTestId('unsaved-save').click();

    await expect.poll(async () => (await mockState.getWrittenFiles())[filePath]).toBe(rightText);
    await expect(app.getByTestId('tab-Chapter 1.md')).toHaveCount(1);
    await expect(app.locator('.dirty-dot')).toHaveCount(0);
  });
});
