import { test, expect } from '../fixtures/app-fixture';

/**
 * Right-clicking inside the editor (.cm-content) should open a styled
 * custom menu that matches the app theme instead of the native WKWebView
 * "Reload / Inspect Element" menu or the OS text menu.
 *
 * Menu items depend on whether there is a selection:
 *   - no selection  → Paste, Select All
 *   - has selection → Cut, Copy, Copy as Rich / Plain Text, Paste, Select All
 */
test.describe('Editor context menu', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('right-click with no selection shows paste + select-all only', async ({ app }) => {
    // Make sure there is no selection.
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: 0, head: 0 } });
    });

    await app.locator('.cm-content').click({ button: 'right' });

    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await expect(app.getByTestId('editor-ctx-paste')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-select-all')).toBeVisible();
    // Selection-only items must be hidden.
    await expect(app.getByTestId('editor-ctx-cut')).toHaveCount(0);
    await expect(app.getByTestId('editor-ctx-copy')).toHaveCount(0);

    await app.keyboard.press('Escape');
  });

  test('right-click with a selection adds cut + copy items', async ({ app }) => {
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      // Select "Chapter" on the first line.
      view.dispatch({ selection: { anchor: 2, head: 9 } });
    });

    await app.locator('.cm-content').click({ button: 'right' });

    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await expect(app.getByTestId('editor-ctx-cut')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-copy')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-paste')).toBeVisible();
    await expect(app.getByTestId('editor-ctx-select-all')).toBeVisible();

    await app.keyboard.press('Escape');
  });

  test('Escape closes the menu', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    await app.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('clicking outside the menu closes it', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    const menu = app.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();

    // Click somewhere outside the menu.
    await app.getByTestId('status-word-count').click();
    await expect(menu).toHaveCount(0);
  });

  test('select all via menu selects the whole document', async ({ app }) => {
    await app.locator('.cm-content').click({ button: 'right' });
    await app.getByTestId('editor-ctx-select-all').click();

    const { anchor, head, len } = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const sel = view.state.selection.main;
      return { anchor: sel.anchor, head: sel.head, len: view.state.doc.length };
    });
    expect(anchor).toBe(0);
    expect(head).toBe(len);
    expect(len).toBeGreaterThan(0);
  });

  test('cut via menu removes selected text from the document', async ({ app }) => {
    // Select "Chapter 1" on line 1.
    const before = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: 2, head: 11 } });
      return view.state.doc.toString();
    });
    expect(before).toContain('# Chapter 1');

    await app.locator('.cm-content').click({ button: 'right' });
    await app.getByTestId('editor-ctx-cut').click();

    const after = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      return view.state.doc.toString();
    });
    // Cut removes the selected range regardless of whether the clipboard
    // write succeeds in the test environment.
    expect(after).not.toContain('Chapter 1');
    expect(after.startsWith('# \n')).toBe(true);
  });

  test('native context menu is suppressed on non-editable chrome', async ({ app }) => {
    // Right-clicking outside the editor must NOT show the editor context menu.
    const sidebar = app.getByTestId('sidebar-region');
    await sidebar.click({ button: 'right' });
    await expect(app.getByTestId('editor-context-menu')).toHaveCount(0);
  });
});
