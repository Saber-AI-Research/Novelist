import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the project-mode "new file naming" flow, exercised against
 * the production default template 第{N}章-{title} (mirrored in tauri-mock):
 *   - empty folder -> default template ("第1章-Untitled.md")
 *   - chapter-pattern folder -> inferred next chapter
 *   - H1 auto-rename on save fills the {title} slot
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
  test('empty folder -> 第1章-Untitled.md (default template at N=1)', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);

    // Tab bar should gain a 第1章-Untitled.md tab.
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });
    // Sidebar should list it too.
    await expect(app.getByTestId('sidebar-file-第1章-Untitled.md')).toBeVisible();
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

  test('H1 + save fills the {title} slot of the placeholder', async ({ app }) => {
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });

    const editor = app.locator('.cm-content').first();
    await editor.click();
    // Fresh placeholder file has empty content; typing H1 marks tab dirty.
    await app.keyboard.type('# 开篇');
    await app.keyboard.press('Enter');

    await triggerSave(app);

    // After save, the Untitled fill should be swapped for the H1 text.
    // (Sidebar refresh on auto-rename is driven by file-watcher events in prod;
    // the mock does not emit them, so we only assert the tab update here.)
    await expect(app.getByTestId('tab-第1章-开篇.md')).toBeVisible({ timeout: 3000 });
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toHaveCount(0);
  });

  test('collision on rename bumps to " 2"', async ({ app }) => {
    // Under the default 第{N}章-{title} template a post-rename collision
    // cannot be pre-seeded (any same-family sibling advances {N} past it),
    // so this case uses a title-only project template: new file renders
    // "Untitled.md" and the H1 rename targets "开篇.md", which we seed.
    await app.evaluate(([d]: readonly [string]) => {
      localStorage.setItem(
        '__novelist_mock_project_settings__:' + d,
        JSON.stringify({ view: {}, new_file: { template: '{title}' }, plugins: { enabled: {} } }),
      );
    }, [MOCK_PROJECT_DIR] as const);
    await enterProject(app, MOCK_PROJECT_DIR, [
      { name: '开篇.md', path: `${MOCK_PROJECT_DIR}/开篇.md`, is_dir: false, size: 0 },
    ]);
    await triggerNewFile(app);
    await expect(app.getByTestId('tab-Untitled.md')).toBeVisible({ timeout: 3000 });

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
