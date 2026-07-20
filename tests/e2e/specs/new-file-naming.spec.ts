import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the project-mode "new file naming" flow, exercised against
 * the production default template 第{N}章-{title} (mirrored in tauri-mock):
 *   - empty folder -> default template ("第1章-Untitled.md")
 *   - chapter-pattern folder -> inferred next chapter
 *   - H1 auto-rename on save fills the {title} slot
 *   - collision on auto-rename bumps to " 2"
 *   - manual Sidebar rename remains managed until explicit stop
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
  await app.evaluate(async () => {
    const saveFn = (window as any).__novelist_save;
    if (saveFn) await saveFn();
  });
}

async function typeInEditor(app: any, text: string) {
  const editor = app.locator('.cm-content').first();
  await editor.click();
  await app.keyboard.type(text);
  await app.keyboard.press('Enter');
}

async function replaceEditor(app: any, text: string) {
  await app.locator('.cm-content').first().click();
  await app.keyboard.press('Meta+A');
  await app.keyboard.press('Backspace');
  await app.keyboard.type(text);
}

async function renameSidebarFile(app: any, fromName: string, toName: string) {
  await app.getByTestId(`sidebar-file-${fromName}`).click({ button: 'right' });
  await app.getByTestId('context-menu-rename').click();
  const input = app.getByTestId('sidebar-input');
  await input.fill(toName);
  await input.press('Enter');
  await expect(app.getByTestId(`sidebar-file-${toName}`)).toBeVisible({ timeout: 3000 });
}

async function expectNoAutoNamingActions(app: any) {
  await expect(app.getByTestId('context-menu-stop-auto-naming')).toHaveCount(0);
  await expect(app.getByTestId('context-menu-reenable-auto-naming')).toHaveCount(0);
}

async function clearMockPersistence(app: any) {
  await app.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('__novelist_mock_files__')
        || key.startsWith('__novelist_mock_contents__')
        || key.startsWith('__novelist_mock_naming__:')) {
        localStorage.removeItem(key);
      }
    }
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

  test('H1 + save fills the {title} slot of the placeholder @task23', async ({ app }) => {
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

  test('ordinary file and folder menus do not show auto-naming actions', async ({ app }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, [
      { name: 'ordinary.md', path: `${MOCK_PROJECT_DIR}/ordinary.md`, is_dir: false, size: 0 },
      { name: 'Drafts', path: `${MOCK_PROJECT_DIR}/Drafts`, is_dir: true, size: 0 },
    ]);

    await app.getByTestId('sidebar-file-ordinary.md').click({ button: 'right' });
    await expectNoAutoNamingActions(app);
    await app.keyboard.press('Escape');

    await app.getByTestId('sidebar-folder-Drafts').click({ button: 'right' });
    await expectNoAutoNamingActions(app);
  });

  test('managed file survives Sidebar rename and restart', async ({ app, mockState }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });

    await typeInEditor(app, '# 开篇');
    await triggerSave(app);
    await expect(app.getByTestId('tab-第1章-开篇.md')).toBeVisible({ timeout: 3000 });
    await mockState.emitEvent('file-renamed', {
      old_path: `${MOCK_PROJECT_DIR}/第1章-Untitled.md`,
      new_path: `${MOCK_PROJECT_DIR}/第1章-开篇.md`,
    });
    await expect(app.getByTestId('sidebar-file-第1章-开篇.md')).toBeVisible({ timeout: 3000 });

    await renameSidebarFile(app, '第1章-开篇.md', 'chapter.md');
    await expect(app.getByTestId('tab-chapter.md')).toBeVisible({ timeout: 3000 });

    await replaceEditor(app, '# 序幕');
    await triggerSave(app);
    await expect(app.getByTestId('tab-序幕.md')).toBeVisible({ timeout: 3000 });

    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await enterProject(app, MOCK_PROJECT_DIR, await mockState.getFiles());
    await expect(app.getByTestId('sidebar-file-序幕.md')).toBeVisible({ timeout: 3000 });
    await app.getByTestId('sidebar-file-序幕.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-stop-auto-naming')).toBeVisible({ timeout: 3000 });
    await app.screenshot({ path: '.sisyphus/evidence/task-9-managed-rename.png' });
    await app.keyboard.press('Escape');

    await app.getByTestId('sidebar-file-序幕.md').click();
    await replaceEditor(app, '# 尾声');
    await triggerSave(app);
    await expect(app.getByTestId('tab-尾声.md')).toBeVisible({ timeout: 3000 });
  });

  test('sidebar header + button enrolls managed naming from the {title} template', async ({ app }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);

    await app.getByTestId('sidebar-new-file').click();
    const input = app.getByTestId('sidebar-input');
    await input.fill('chapter.md');
    await input.press('Enter');
    await expect(app.getByTestId('sidebar-file-chapter.md')).toBeVisible({ timeout: 3000 });

    await app.getByTestId('sidebar-file-chapter.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-stop-auto-naming')).toBeVisible({ timeout: 3000 });
    await app.keyboard.press('Escape');

    await app.getByTestId('sidebar-file-chapter.md').click();
    await app.locator('.cm-content').first().click();
    await app.keyboard.type('# 开篇');
    await app.keyboard.press('Enter');
    await triggerSave(app);
    await replaceEditor(app, '# 序幕');
    await triggerSave(app);
    await expect(app.getByTestId('tab-序幕.md')).toBeVisible({ timeout: 3000 });
  });

  test('sidebar createFileAt enrolls before the immediate inline rename', async ({ app }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);

    const files = app.getByTestId('sidebar-files');
    const box = await files.boundingBox();
    if (!box) throw new Error('sidebar-files has no bounding box');
    const viewport = app.viewportSize();
    const safeBottom = viewport ? viewport.height - 160 : box.y + box.height - 160;
    const y = Math.min(box.y + 200, safeBottom);
    await app.mouse.click(
      box.x + box.width / 2,
      Math.max(box.y + 120, y),
      { button: 'right' },
    );
    await app.getByTestId('sidebar-view-new-file').click();

    const input = app.getByTestId('sidebar-input');
    await expect(input).toBeVisible({ timeout: 3000 });
    await input.fill('chapter.md');
    await input.press('Enter');
    await expect(app.getByTestId('sidebar-file-chapter.md')).toBeVisible({ timeout: 3000 });

    await app.getByTestId('sidebar-file-chapter.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-stop-auto-naming')).toBeVisible({ timeout: 3000 });
    await app.keyboard.press('Escape');
  });

  test('sidebar createFileAt awaits committed enrollment before immediate inline rename', async ({ app, mockState }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await mockState.setManagedNameWritesBlocked(true);

    const files = app.getByTestId('sidebar-files');
    const box = await files.boundingBox();
    if (!box) throw new Error('sidebar-files has no bounding box');
    await app.mouse.click(box.x + box.width / 2, box.y + Math.min(200, box.height - 20), { button: 'right' });
    await app.getByTestId('sidebar-view-new-file').click();

    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_managed_name_state').length).toBe(1);
    await expect(app.getByTestId('sidebar-input')).toHaveCount(0);
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'rename_item')).toHaveLength(0);

    await mockState.releaseNextManagedNameWrite();
    const input = app.getByTestId('sidebar-input');
    await expect(input).toBeVisible({ timeout: 3000 });
    await input.fill('chapter.md');
    await input.press('Enter');
    await expect(app.getByTestId('sidebar-file-chapter.md')).toBeVisible({ timeout: 3000 });

    const commands = (await mockState.getInvokeCalls()).map((call) => call.command);
    const writeIndex = commands.indexOf('write_managed_name_state');
    const readIndex = commands.indexOf('read_managed_name_state', writeIndex + 1);
    const renameIndex = commands.indexOf('rename_item');
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(writeIndex);
    expect(renameIndex).toBeGreaterThan(readIndex);
    await mockState.setManagedNameWritesBlocked(false);
  });

  test('plugin-created non-Markdown files are not enrolled in managed naming', async ({ app, mockState }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);

    const files = app.getByTestId('sidebar-files');
    const box = await files.boundingBox();
    if (!box) throw new Error('sidebar-files has no bounding box');
    await app.mouse.click(box.x + box.width / 2, box.y + Math.min(200, box.height - 20), { button: 'right' });
    await app.getByTestId('sidebar-view-new-kanban').click();

    const input = app.getByTestId('sidebar-input');
    await expect(input).toBeVisible({ timeout: 3000 });
    await input.fill('board.kanban');
    await input.press('Enter');
    await expect(app.getByTestId('sidebar-file-board.kanban')).toBeVisible({ timeout: 3000 });

    expect((await mockState.getInvokeCalls())
      .filter((call) => call.command === 'write_managed_name_state')).toHaveLength(0);
    await app.getByTestId('sidebar-file-board.kanban').click({ button: 'right' });
    await expectNoAutoNamingActions(app);
  });

  test('re-enable reconciles a manually renamed file when the H1 is unchanged', async ({ app, mockState }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);
    await typeInEditor(app, '# 开篇');
    await triggerSave(app);
    await expect(app.getByTestId('tab-第1章-开篇.md')).toBeVisible({ timeout: 3000 });
    await mockState.emitEvent('file-renamed', {
      old_path: `${MOCK_PROJECT_DIR}/第1章-Untitled.md`,
      new_path: `${MOCK_PROJECT_DIR}/第1章-开篇.md`,
    });
    await expect(app.getByTestId('sidebar-file-第1章-开篇.md')).toBeVisible({ timeout: 3000 });

    await app.getByTestId('sidebar-file-第1章-开篇.md').click({ button: 'right' });
    await app.getByTestId('context-menu-stop-auto-naming').click();
    await renameSidebarFile(app, '第1章-开篇.md', 'chapter.md');
    await mockState.reset();

    await app.getByTestId('sidebar-file-chapter.md').click({ button: 'right' });
    await app.getByTestId('context-menu-reenable-auto-naming').click();
    await expect(app.getByTestId('tab-开篇.md')).toBeVisible({ timeout: 3000 });
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'rename_item')).toHaveLength(1);
  });

  test('sidebar header + does not enroll ordinary templates without {title}', async ({ app }) => {
    await clearMockPersistence(app);
    await app.evaluate(([d]: readonly [string]) => {
      localStorage.setItem(
        '__novelist_mock_project_settings__:' + d,
        JSON.stringify({ view: {}, new_file: { template: 'Chapter {N}' }, plugins: { enabled: {} } }),
      );
    }, [MOCK_PROJECT_DIR] as const);
    await enterProject(app, MOCK_PROJECT_DIR, []);

    await app.getByTestId('sidebar-new-file').click();
    const input = app.getByTestId('sidebar-input');
    await input.fill('notes.md');
    await input.press('Enter');
    await expect(app.getByTestId('sidebar-file-notes.md')).toBeVisible({ timeout: 3000 });

    await app.getByTestId('sidebar-file-notes.md').click({ button: 'right' });
    await expectNoAutoNamingActions(app);
  });

  test('explicit stop survives restart and re-enable resumes safely @task23 @task23-negative', async ({ app, mockState }) => {
    await clearMockPersistence(app);
    await enterProject(app, MOCK_PROJECT_DIR, []);
    await triggerNewFile(app);
    await expect(app.getByTestId('sidebar-file-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });

    await app.getByTestId('sidebar-file-第1章-Untitled.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-stop-auto-naming')).toBeVisible({ timeout: 3000 });
    await app.getByTestId('context-menu-stop-auto-naming').click();

    await mockState.reset();
    await typeInEditor(app, '# 开篇');
    await triggerSave(app);
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'rename_item')).toHaveLength(0);
    expect((await mockState.getFiles()).some((file) => file.name === '第1章-Untitled.md')).toBe(true);

    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await enterProject(app, MOCK_PROJECT_DIR, await mockState.getFiles());
    await app.getByTestId('sidebar-file-第1章-Untitled.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-reenable-auto-naming')).toBeVisible({ timeout: 3000 });
    await expect(app.getByTestId('context-menu-stop-auto-naming')).toHaveCount(0);
    await app.screenshot({ path: '.sisyphus/evidence/task-9-detach.png' });
    await app.keyboard.press('Escape');

    await app.getByTestId('sidebar-file-第1章-Untitled.md').click();
    await mockState.reset();
    await replaceEditor(app, '# 序幕');
    await triggerSave(app);
    await expect(app.getByTestId('tab-第1章-Untitled.md')).toBeVisible({ timeout: 3000 });
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'rename_item')).toHaveLength(0);
    expect((await mockState.getFiles()).some((file) => file.name === '第1章-Untitled.md')).toBe(true);

    await app.getByTestId('sidebar-file-第1章-Untitled.md').click({ button: 'right' });
    await expect(app.getByTestId('context-menu-reenable-auto-naming')).toBeVisible({ timeout: 3000 });
    await app.getByTestId('context-menu-reenable-auto-naming').click();
    await expect(app.getByTestId('tab-第1章-序幕.md')).toBeVisible({ timeout: 3000 });
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'rename_item').length).toBe(1);
  });
});
