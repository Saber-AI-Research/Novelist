import type { Page } from '@playwright/test';
import { test, expect, openRecentProject } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * Covers the sidebar blank-area "view" context menu (show-hidden toggle,
 * new-file, new-folder) and the folder-level "New File / New Folder in
 * Folder" entries. These features have no dedicated backend command — the
 * logic lives in Sidebar.svelte, so browser-mode E2E is the primary
 * regression net.
 */

async function seedAndEnterProject(app: Page, extra: MockFileEntry[] = []) {
  const files: MockFileEntry[] = [
    { name: 'Chapter 1.md', path: `${MOCK_PROJECT_DIR}/Chapter 1.md`, is_dir: false, size: 100 },
    { name: 'Notes', path: `${MOCK_PROJECT_DIR}/Notes`, is_dir: true, size: 0 },
    { name: 'outline.md', path: `${MOCK_PROJECT_DIR}/Notes/outline.md`, is_dir: false, size: 50 },
    ...extra,
  ];
  await app.evaluate(
    ([d, f]) => (window as any).__TAURI_MOCK_STATE__.openProject(d, f),
    [MOCK_PROJECT_DIR, files] as [string, MockFileEntry[]],
  );
  await openRecentProject(app);
}

/** Reliably right-click the empty region of the files container.
 *
 * Clicks near the middle-bottom of the files container so the spawned menu
 * stays inside the viewport (the menu opens at click coordinates and gets
 * clipped if the click is near the bottom edge).
 */
async function rightClickBlankArea(app: Page) {
  const files = app.getByTestId('sidebar-files');
  const box = await files.boundingBox();
  if (!box) throw new Error('sidebar-files has no bounding box');
  // Find a row-free y. Start below all known rows but well above the
  // bottom edge so the spawned menu fits in the viewport.
  const viewport = app.viewportSize();
  const safeBottom = viewport ? viewport.height - 160 : box.y + box.height - 160;
  const y = Math.min(box.y + 200, safeBottom);
  await app.mouse.click(
    box.x + box.width / 2,
    Math.max(box.y + 120, y),
    { button: 'right' },
  );
}

test.describe('Sidebar view context menu', () => {
  test('blank-area right-click reveals view menu with show-hidden toggle', async ({ app }) => {
    await seedAndEnterProject(app);

    await rightClickBlankArea(app);
    await expect(app.getByTestId('sidebar-view-menu')).toBeVisible();

    const toggle = app.getByTestId('sidebar-view-toggle-hidden');
    await expect(toggle).toHaveAttribute('role', 'menuitem');
    await expect(toggle).toHaveText('Show hidden files');

    // Esc-equivalent — clicking outside should dismiss.
    await app.mouse.click(20, 20);
    await expect(app.getByTestId('sidebar-view-menu')).toHaveCount(0);
  });

  test('toggling show-hidden surfaces .novelist in the tree', async ({ app }) => {
    await seedAndEnterProject(app, [
      { name: '.novelist', path: `${MOCK_PROJECT_DIR}/.novelist`, is_dir: true, size: 0 },
    ]);

    const hiddenFolder = app.locator('[data-testid="sidebar-folder-.novelist"]');

    // Hidden by default.
    await expect(hiddenFolder).toHaveCount(0);

    await rightClickBlankArea(app);
    const toggle = app.getByTestId('sidebar-view-toggle-hidden');
    await expect(toggle).toHaveText('Show hidden files');
    await toggle.click();

    // Diagnostic: capture what the mock returns for list_directory with the
    // hidden flag on. If this is wrong the whole chain breaks.
    const mockListing = await app.evaluate(() => {
      const mock = (window as any).__TAURI_MOCK_STATE__;
      return mock.files.map((f: any) => f.name);
    });
    expect(mockListing, 'mock must still know about .novelist').toContain('.novelist');

    // Poll the tree until .novelist shows up. `refreshFolder` races the
    // reactive derivation in the Sidebar; the WebKit scheduler sometimes
    // holds the render frame a beat longer, so a poll is more reliable
    // than a single toBeVisible.
    await expect.poll(
      async () => app.locator('[data-testid="sidebar-folder-.novelist"]').count(),
      { timeout: 5000 },
    ).toBeGreaterThan(0);

    await rightClickBlankArea(app);
    await expect(app.getByTestId('sidebar-view-toggle-hidden')).toHaveText('Hide hidden files');
  });

  test('view menu "New File" creates file at root and opens rename input', async ({ app }) => {
    await seedAndEnterProject(app);

    await rightClickBlankArea(app);
    await app.getByTestId('sidebar-view-new-file').click();

    // Inline rename input opens for the newly created file.
    await expect(app.getByTestId('sidebar-input')).toBeVisible();
  });

  test('folder right-click exposes "New File in Folder" that creates inside', async ({ app, mockState }) => {
    await seedAndEnterProject(app);

    const folder = app.getByTestId('sidebar-folder-Notes');
    await folder.click({ button: 'right' });

    const menu = app.getByTestId('context-menu');
    await expect(menu).toBeVisible();

    const newFileItem = app.getByTestId('context-menu-new-file');
    await expect(newFileItem).toBeVisible();
    await newFileItem.click();

    // Backend recorded a create under the Notes subdirectory. The inline
    // rename input only renders for root-level rows (Sidebar.svelte's each
    // loop), so we assert on the backing filesystem, not the UI.
    await expect.poll(async () => {
      const created = await mockState.getCreatedFiles();
      return created.some(p => p.startsWith(`${MOCK_PROJECT_DIR}/Notes/`));
    }).toBe(true);
  });

  test('double-clicking a file row enters rename mode (v0.2.4)', async ({ app }) => {
    await seedAndEnterProject(app);

    const file = app.getByTestId('sidebar-file-Chapter 1.md');
    await file.dblclick();

    await expect(app.getByTestId('sidebar-input')).toBeVisible();
  });

  test('double-clicking a folder row enters rename mode; single-click toggles (v0.2.4)', async ({ app }) => {
    await seedAndEnterProject(app);

    const folder = app.getByTestId('sidebar-folder-Notes');

    // Single click toggles expansion. The child file becomes visible.
    await folder.click();
    await expect(app.getByTestId('sidebar-file-outline.md')).toBeVisible();

    // Collapse again so the rename target stays the folder row, not its children.
    await folder.click();
    await expect(app.getByTestId('sidebar-file-outline.md')).toHaveCount(0);

    // Double click on the folder row → rename input.
    await folder.dblclick();
    await expect(app.getByTestId('sidebar-input')).toBeVisible();
  });

  test('settings toggle wraps long sidebar file names instead of ellipsizing', async ({ app }) => {
    const longName = 'this-is-a-very-long-sidebar-file-name-that-should-wrap-across-lines.md';
    await seedAndEnterProject(app, [
      { name: longName, path: `${MOCK_PROJECT_DIR}/${longName}`, is_dir: false, size: 0 },
    ]);

    const row = app.getByTestId(`sidebar-file-${longName}`);
    const name = row.locator('.tree-name');
    await expect(row).toBeVisible();

    await expect(name).toHaveCSS('white-space', 'nowrap');
    const singleLineHeight = await row.evaluate((el) => el.getBoundingClientRect().height);

    await app.evaluate(() => (window as any).__test_api__.toggleSettings());
    await app.getByTestId('settings-dialog').waitFor({ state: 'visible' });
    await app.getByTestId('settings-section-editor').click();
    await app.getByTestId('settings-sidebar-wrap-filenames').click();
    await app.keyboard.press('Escape');

    await expect(name).toHaveCSS('white-space', 'normal');
    await expect(row).toHaveClass(/tree-row-wrap/);
    await expect.poll(
      async () => row.evaluate((el) => el.getBoundingClientRect().height),
      { timeout: 3000 },
    ).toBeGreaterThan(singleLineHeight);

    const stored = await app.evaluate(
      (key) => localStorage.getItem(key),
      `__novelist_mock_project_settings__:${MOCK_PROJECT_DIR}`,
    );
    expect(JSON.parse(stored!).view.wrap_file_names).toBe(true);
  });

  test('settings control changes sidebar file font size', async ({ app }) => {
    await seedAndEnterProject(app, [
      { name: 'Readable Chapter.md', path: `${MOCK_PROJECT_DIR}/Readable Chapter.md`, is_dir: false, size: 0 },
    ]);

    const row = app.getByTestId('sidebar-file-Readable Chapter.md');
    await expect(row).toBeVisible();
    await expect(row).toHaveCSS('font-size', '14px');

    await app.evaluate(() => (window as any).__test_api__.toggleSettings());
    await app.getByTestId('settings-dialog').waitFor({ state: 'visible' });
    await app.getByTestId('settings-section-editor').click();
    await app.getByTestId('settings-sidebar-font-size').fill('16');
    await app.keyboard.press('Escape');

    await expect(row).toHaveCSS('font-size', '16px');

    const stored = await app.evaluate(
      (key) => localStorage.getItem(key),
      `__novelist_mock_project_settings__:${MOCK_PROJECT_DIR}`,
    );
    expect(JSON.parse(stored!).view.sidebar_font_size).toBe(16);
  });
});
