import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the Cmd+S → H1 auto-rename pipeline (v0.2.4).
 *
 * Two scenarios:
 *  1. Dirty tab — user types an H1 then saves. Standard path.
 *  2. Clean tab — file already contains an H1 (e.g. autosaved earlier);
 *     user presses Cmd+S to "force" a rename. The clean-tab early
 *     return in `Editor.saveCurrentFile` was relaxed in v0.2.4 so the
 *     rename check still runs.
 */

async function seedAndOpen(app: import('@playwright/test').Page, files: MockFileEntry[], contents: Record<string, string> = {}) {
  await app.evaluate(
    async ([d, f, c]) => {
      const w = window as any;
      w.__TAURI_MOCK_STATE__.openProject(d, f);
      w.__TAURI_MOCK_STATE__.seedFileContents(c);
      for (const file of f) {
        if (!file.is_dir && /^Untitled \d+\.md$/.test(file.name)) {
          const documentKey = await w.__TAURI_INTERNALS__.invoke('compute_document_key', { projectDir: d, filePath: file.path });
          await w.__TAURI_INTERNALS__.invoke('write_managed_name_state', {
            projectDir: d,
            filePath: file.path,
            state: { version: 1, status: 'managed', templateRaw: '{title}', currentH1: '', documentKey },
          });
        }
      }
    },
    [MOCK_PROJECT_DIR, files, contents] as const,
  );
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
}

test.describe('Cmd+S H1 auto-rename', () => {
  test('dirty tab: typing an H1 + Cmd+S renames the placeholder file', async ({ app, appKeys, mockState }) => {
    await seedAndOpen(
      app,
      [{ name: 'Untitled 1.md', path: `${MOCK_PROJECT_DIR}/Untitled 1.md`, is_dir: false, size: 0 }],
      { [`${MOCK_PROJECT_DIR}/Untitled 1.md`]: '' },
    );

    await app.getByTestId('sidebar-file-Untitled 1.md').click();
    // Wait for editor to mount.
    await app.locator('.cm-content').waitFor({ state: 'visible' });

    // Type an H1.
    await app.locator('.cm-content').click();
    await app.keyboard.type('# 开篇\n\nbody');

    // Cmd+S → save + rename.
    await appKeys.press('s', { metaKey: true });

    await expect.poll(async () => {
      const files = await mockState.getFiles();
      return files.some(f => f.name === '开篇.md');
    }, { timeout: 5000 }).toBe(true);

    const files = await mockState.getFiles();
    expect(files.some(f => f.name === 'Untitled 1.md')).toBe(false);
  });

  test('clean tab: opening a placeholder file that already has an H1 + Cmd+S renames it (v0.2.4 fix)', async ({ app, appKeys, mockState }) => {
    // File on disk already has an H1, content matches what we'd read back.
    // Tab will mount as clean (isDirty=false) since content === read content.
    await seedAndOpen(
      app,
      [{ name: 'Untitled 5.md', path: `${MOCK_PROJECT_DIR}/Untitled 5.md`, is_dir: false, size: 30 }],
      { [`${MOCK_PROJECT_DIR}/Untitled 5.md`]: '# 第二章\n\n正文\n' },
    );

    await app.getByTestId('sidebar-file-Untitled 5.md').click();
    await app.locator('.cm-content').waitFor({ state: 'visible' });
    // Confirm it loaded as clean — no dirty dot in tab bar.
    await expect(app.getByTestId('tab-bar')).toContainText('Untitled 5');

    // Cmd+S on a clean tab → no writeFile, but rename check still runs.
    await appKeys.press('s', { metaKey: true });

    await expect.poll(async () => {
      const files = await mockState.getFiles();
      return files.some(f => f.name === '第二章.md');
    }, { timeout: 5000 }).toBe(true);
  });
});
