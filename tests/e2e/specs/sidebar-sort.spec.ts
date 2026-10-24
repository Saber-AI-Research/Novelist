import type { Page } from '@playwright/test';
import { test, expect, openRecentProject } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the sidebar sort dropdown.
 *
 * Covered flows:
 *   - numeric-asc default orders chapters numerically (第一章 < 第二章 < 第十章)
 *   - switching to name-asc vs numeric-asc produces divergent orderings for
 *     filenames like 1-intro / 2-rising / 10-finale
 *   - selected sort mode persists per project via localStorage; switching
 *     projects loads that project's saved mode (or the default for fresh projects)
 *
 * The sidebar renders rows via `[data-testid="sidebar-file-<name>"]`, which we
 * query via a CSS prefix selector to read DOM order.
 */

const OTHER_PROJECT_DIR = '/tmp/another-project';

async function seedProjectFiles(app: Page, dirPath: string, files: MockFileEntry[]) {
  const arg: [string, MockFileEntry[]] = [dirPath, files];
  await app.evaluate(
    ([d, f]) => (window as any).__TAURI_MOCK_STATE__.openProject(d, f),
    arg,
  );
}

async function enterMockProject(app: Page, dirPath: string, files: MockFileEntry[]) {
  await seedProjectFiles(app, dirPath, files);
  await openRecentProject(app);
}

async function navigateToRecent(app: Page, index: number) {
  const recentItem = app.getByTestId(`recent-project-${index}`);
  await expect(recentItem).toBeVisible({ timeout: 5000 });
  await recentItem.click();
  await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
}

async function openSortMenu(app: Page) {
  await app.getByTestId('sidebar-sort-button').click();
  await expect(app.getByTestId('sidebar-sort-menu')).toBeVisible();
}

async function closeSortMenu(app: Page) {
  // The svelte:window onclick in Sidebar closes the menu on any body click.
  await app.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(app.getByTestId('sidebar-sort-menu')).toHaveCount(0);
}

test.describe('Sidebar sort modes', () => {
  test('numeric-asc orders CJK chapters numerically by default', async ({ app }) => {
    await enterMockProject(app, MOCK_PROJECT_DIR, [
      { name: '第十章.md', path: `${MOCK_PROJECT_DIR}/第十章.md`, is_dir: false, size: 0 },
      { name: '第二章.md', path: `${MOCK_PROJECT_DIR}/第二章.md`, is_dir: false, size: 0 },
      { name: '第一章.md', path: `${MOCK_PROJECT_DIR}/第一章.md`, is_dir: false, size: 0 },
    ]);

    const rows = app.locator('[data-testid^="sidebar-file-"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'sidebar-file-第一章.md');
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'sidebar-file-第二章.md');
    await expect(rows.nth(2)).toHaveAttribute('data-testid', 'sidebar-file-第十章.md');
  });

  test('numeric-asc vs name-asc diverge for 1/2/10 stems', async ({ app }) => {
    await enterMockProject(app, MOCK_PROJECT_DIR, [
      { name: '10-finale.md', path: `${MOCK_PROJECT_DIR}/10-finale.md`, is_dir: false, size: 0 },
      { name: '2-rising.md', path: `${MOCK_PROJECT_DIR}/2-rising.md`, is_dir: false, size: 0 },
      { name: '1-intro.md', path: `${MOCK_PROJECT_DIR}/1-intro.md`, is_dir: false, size: 0 },
    ]);

    // Default numeric-asc: 1 < 2 < 10
    let rows = app.locator('[data-testid^="sidebar-file-"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'sidebar-file-1-intro.md');
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'sidebar-file-2-rising.md');
    await expect(rows.nth(2)).toHaveAttribute('data-testid', 'sidebar-file-10-finale.md');

    // Switch to name-asc (lexicographic): 1 < 10 < 2
    await openSortMenu(app);
    await app.getByTestId('sidebar-sort-name-asc').click();
    await expect(app.getByTestId('sidebar-sort-menu')).toHaveCount(0);

    rows = app.locator('[data-testid^="sidebar-file-"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-testid', 'sidebar-file-1-intro.md');
    await expect(rows.nth(1)).toHaveAttribute('data-testid', 'sidebar-file-10-finale.md');
    await expect(rows.nth(2)).toHaveAttribute('data-testid', 'sidebar-file-2-rising.md');
  });

  test('sort mode persists per project across project switches', async ({ app }) => {
    // Seed files for MOCK_PROJECT_DIR and navigate via recent-project-0.
    await enterMockProject(app, MOCK_PROJECT_DIR, [
      { name: 'a.md', path: `${MOCK_PROJECT_DIR}/a.md`, is_dir: false, size: 0 },
      { name: 'b.md', path: `${MOCK_PROJECT_DIR}/b.md`, is_dir: false, size: 0 },
    ]);

    // Change sort to name-desc for this project.
    await openSortMenu(app);
    await app.getByTestId('sidebar-sort-name-desc').click();
    await expect(app.getByTestId('sidebar-sort-menu')).toHaveCount(0);

    // Settings now live in the mocked per-project settings store (keyed by
    // project dir), mirroring how the real backend writes to
    // <project>/.novelist/project.toml's [view] section.
    const storedA = await app.evaluate(
      (key) => localStorage.getItem(key),
      `__novelist_mock_project_settings__:${MOCK_PROJECT_DIR}`,
    );
    expect(storedA).not.toBeNull();
    expect(JSON.parse(storedA!).view.sort_mode).toBe('name-desc');

    // Reload — in-memory state resets; mock settings survive in localStorage,
    // so reopening the project should restore name-desc.
    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });

    await seedProjectFiles(app, OTHER_PROJECT_DIR, [
      { name: 'x.md', path: `${OTHER_PROJECT_DIR}/x.md`, is_dir: false, size: 0 },
    ]);
    await navigateToRecent(app, 1);

    // Fresh project (no stored overlay) — default numeric-asc is active.
    await openSortMenu(app);
    await expect(app.getByTestId('sidebar-sort-numeric-asc')).toContainText('\u2713');
    await expect(app.getByTestId('sidebar-sort-name-desc')).not.toContainText('\u2713');
    await closeSortMenu(app);

    // Reload again, then navigate back to MOCK_PROJECT_DIR via recent-project-0.
    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await seedProjectFiles(app, MOCK_PROJECT_DIR, [
      { name: 'a.md', path: `${MOCK_PROJECT_DIR}/a.md`, is_dir: false, size: 0 },
      { name: 'b.md', path: `${MOCK_PROJECT_DIR}/b.md`, is_dir: false, size: 0 },
    ]);
    await navigateToRecent(app, 0);

    // Sort mode restored from the per-project settings overlay.
    await openSortMenu(app);
    await expect(app.getByTestId('sidebar-sort-name-desc')).toContainText('\u2713');
    await expect(app.getByTestId('sidebar-sort-numeric-asc')).not.toContainText('\u2713');
  });
});
