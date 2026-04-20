import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR, type MockFileEntry } from '../fixtures/mock-data';

/**
 * E2E coverage for the Cmd+M move-file palette.
 *
 * The palette lives in `MoveFilePalette.svelte`. Opening routes through the
 * command handler registered in App.svelte (`move-file` command). Selecting
 * a directory calls `commands.moveItem`, which the tauri-mock mutates in
 * memory.
 */

async function seedAndOpen(app: Page, files: MockFileEntry[]) {
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

async function openFileInEditor(app: Page, fileName: string) {
  await app.getByTestId(`sidebar-file-${fileName}`).click();
  await app.getByTestId('editor-container').waitFor({ state: 'visible' });
}

test.describe('Cmd+M move-file palette', () => {
  test('palette lists folders and moves the active file into the chosen one', async ({ app }) => {
    await seedAndOpen(app, [
      { name: 'Chapter 1.md', path: `${MOCK_PROJECT_DIR}/Chapter 1.md`, is_dir: false, size: 100 },
      { name: 'Drafts', path: `${MOCK_PROJECT_DIR}/Drafts`, is_dir: true, size: 0 },
    ]);
    await openFileInEditor(app, 'Chapter 1.md');

    // Open the palette via the registered command (browsers intercept Cmd+M,
    // so we invoke the command directly through the registry).
    await app.evaluate(() => {
      // Reach into the already-mounted commandRegistry via the move-file
      // command. Fallback: exposed via the palette's handler map.
      const handler = (window as any).__novelist_command_handlers__?.['move-file'];
      if (handler) return handler();
      // Command registry isn't globally exposed — use command palette UI.
      const ev = new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true });
      window.dispatchEvent(ev);
    });

    // Fallback path: if the direct handler isn't there, fish the palette via
    // the command palette UI. The move command is still reachable by name.
    if (!(await app.getByTestId('move-palette').isVisible().catch(() => false))) {
      await app.getByTestId('palette-input').fill('Move');
      await app.getByTestId('palette-result-0').click();
    }

    await expect(app.getByTestId('move-palette')).toBeVisible();

    // "Drafts" shows up in the results.
    const row = app.locator('[data-testid^="move-palette-result-"]').filter({ hasText: 'Drafts' });
    await expect(row).toBeVisible();
    await row.click();

    // Palette closed after selection.
    await expect(app.getByTestId('move-palette')).toHaveCount(0);

    // Mock filesystem reflects the move.
    const paths = await app.evaluate(() =>
      (window as any).__TAURI_MOCK_STATE__.files.map((f: any) => f.path),
    );
    expect(
      paths.includes(`${MOCK_PROJECT_DIR}/Drafts/Chapter 1.md`),
      'file must be at /Drafts/Chapter 1.md; got: ' + JSON.stringify(paths),
    ).toBe(true);
  });

  test('palette hides the file\'s current parent folder from the list', async ({ app }) => {
    await seedAndOpen(app, [
      { name: 'Ideas', path: `${MOCK_PROJECT_DIR}/Ideas`, is_dir: true, size: 0 },
      { name: 'note.md', path: `${MOCK_PROJECT_DIR}/Ideas/note.md`, is_dir: false, size: 50 },
      { name: 'Elsewhere', path: `${MOCK_PROJECT_DIR}/Elsewhere`, is_dir: true, size: 0 },
    ]);

    // Expand Ideas so we can click its child file.
    const folder = app.getByTestId('sidebar-folder-Ideas');
    await folder.getByRole('button', { name: /Expand|Collapse/i }).click();
    await app.getByTestId('sidebar-file-note.md').waitFor({ state: 'visible' });
    await openFileInEditor(app, 'note.md');

    // Open via command palette (same fallback as the first test).
    await app.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true })));
    await app.getByTestId('palette-input').fill('Move');
    await app.getByTestId('palette-result-0').click();
    await expect(app.getByTestId('move-palette')).toBeVisible();

    // "Ideas" is the file's current parent — should NOT be in the list.
    const ideasRow = app.locator('[data-testid^="move-palette-result-"]').filter({ hasText: /^Ideas$/ });
    await expect(ideasRow).toHaveCount(0);

    // Other directories are still present.
    const elsewhereRow = app.locator('[data-testid^="move-palette-result-"]').filter({ hasText: 'Elsewhere' });
    await expect(elsewhereRow).toBeVisible();
  });

  test('palette closes on Escape without moving the file', async ({ app }) => {
    await seedAndOpen(app, [
      { name: 'Chapter 1.md', path: `${MOCK_PROJECT_DIR}/Chapter 1.md`, is_dir: false, size: 100 },
      { name: 'Drafts', path: `${MOCK_PROJECT_DIR}/Drafts`, is_dir: true, size: 0 },
    ]);
    await openFileInEditor(app, 'Chapter 1.md');

    await app.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true })));
    await app.getByTestId('palette-input').fill('Move');
    await app.getByTestId('palette-result-0').click();
    await expect(app.getByTestId('move-palette')).toBeVisible();

    await app.keyboard.press('Escape');
    await expect(app.getByTestId('move-palette')).toHaveCount(0);

    // File still at its original location.
    const paths = await app.evaluate(() =>
      (window as any).__TAURI_MOCK_STATE__.files.map((f: any) => f.path),
    );
    expect(paths).toContain(`${MOCK_PROJECT_DIR}/Chapter 1.md`);
  });
});
