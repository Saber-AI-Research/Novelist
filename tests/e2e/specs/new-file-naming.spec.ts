import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the project-mode "new file naming" flow:
 *   - empty folder -> default template ("Untitled 1.md")
 *   - chapter-pattern folder -> inferred next chapter
 *   - H1 auto-rename on save promotes placeholder name
 *   - collision on auto-rename bumps to " 2"
 *   - manual rename breaks placeholder status (no further auto-rename)
 *
 * The project is swapped into the mock via `mockState.openProject` before the
 * Welcome screen navigates in via `recent-project-0`. The `__test_api__.newFile`
 * bridge triggers `handleNewFile` directly (Cmd+N is intercepted by Chromium).
 */

async function enterProject(app: any, dirPath: string, files: MockFileEntry[]) {
  // Swap mock project files/dir BEFORE navigating so list_directory returns them.
  await app.evaluate(
    ([d, f]: [string, MockFileEntry[]]) =>
      (window as any).__TAURI_MOCK_STATE__.openProject(d, f),
    [dirPath, files] as const,
  );

  // Recent-project-0 maps to MOCK_PROJECT_DIR; only click if the welcome screen is up.
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
}

async function triggerNewFile(app: any) {
  await app.evaluate(() => (window as any).__test_api__.newFile());
}

async function triggerSave(app: any) {
  await app.evaluate(() => {
    const saveFn = (window as any).__novelist_save;
    if (saveFn) saveFn();
  });
}

test.describe('New file naming in project mode', () => {
  test('empty folder -> Untitled 1.md', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);

    // Tab bar should gain an Untitled 1.md tab.
    await expect(app.getByTestId('tab-Untitled 1.md')).toBeVisible({ timeout: 3000 });
    // Sidebar should list it too.
    await expect(app.getByTestId('sidebar-file-Untitled 1.md')).toBeVisible();
  });

  test('folder with chapter pattern -> next chapter', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, [
      { name: '第一章.md', path: `${MOCK_PROJECT_DIR}/第一章.md`, is_dir: false, size: 0 },
      { name: '第二章.md', path: `${MOCK_PROJECT_DIR}/第二章.md`, is_dir: false, size: 0 },
    ]);
    await triggerNewFile(app);

    await expect(app.getByTestId('tab-第三章.md')).toBeVisible({ timeout: 3000 });
    await expect(app.getByTestId('sidebar-file-第三章.md')).toBeVisible();
  });

  test('H1 + save renames placeholder', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);
    await expect(app.getByTestId('tab-Untitled 1.md')).toBeVisible({ timeout: 3000 });

    const editor = app.locator('.cm-content').first();
    await editor.click();
    // Fresh placeholder file has empty content; typing H1 marks tab dirty.
    await app.keyboard.type('# 开篇');
    await app.keyboard.press('Enter');

    await triggerSave(app);

    // After save, the placeholder tab should be renamed to match the H1.
    // (Sidebar refresh on auto-rename is driven by file-watcher events in prod;
    // the mock does not emit them, so we only assert the tab update here.)
    await expect(app.getByTestId('tab-开篇.md')).toBeVisible({ timeout: 3000 });
    await expect(app.getByTestId('tab-Untitled 1.md')).toHaveCount(0);
  });

  test('collision on rename bumps to " 2"', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, [
      { name: '开篇.md', path: `${MOCK_PROJECT_DIR}/开篇.md`, is_dir: false, size: 0 },
    ]);
    await triggerNewFile(app);
    // Initial placeholder for non-matching folder = Untitled 1.md.
    await expect(app.getByTestId('tab-Untitled 1.md')).toBeVisible({ timeout: 3000 });

    const editor = app.locator('.cm-content').first();
    await editor.click();
    await app.keyboard.type('# 开篇');
    await app.keyboard.press('Enter');

    await triggerSave(app);

    // Collision bumps to "开篇 2.md" on the active tab.
    // (Sidebar refresh on auto-rename is driven by file-watcher events in prod.)
    await expect(app.getByTestId('tab-开篇 2.md')).toBeVisible({ timeout: 3000 });
    // Original "开篇.md" is still in the sidebar, untouched.
    await expect(app.getByTestId('sidebar-file-开篇.md')).toBeVisible();
  });

  // Skipped: the "manual rename breaks placeholder -> no further auto-rename"
  // flow depends on Tauri's `listen()` event plumbing. The browser mock stores
  // handler callback *IDs* (Tauri v2 transforms handler functions into integers
  // before `plugin:event|listen`), so `mockState.emitEvent('file-renamed', …)`
  // cannot actually invoke the registered handler in the same window. Without
  // that round-trip we cannot update the tab's filePath to `manual.md` via the
  // normal code path, so the negative E2E assertion is not reachable here.
  //
  // The underlying isPlaceholder gating is covered by unit tests:
  //   - tests/unit/utils/placeholder.test.ts     (isPlaceholder on non-placeholder names)
  //   - tests/unit/stores/tabs-update-path.test.ts (path updates after rename)
  test.skip('manual rename then H1 does not auto-rename again (covered by unit tests)', () => {});
});
