import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';
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
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
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
});
