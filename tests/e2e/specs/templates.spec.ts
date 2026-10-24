import { test, expect, openRecentProject } from '../fixtures/app-fixture';

test.describe('Template Panel', () => {
  test.beforeEach(async ({ app }) => {
    await openRecentProject(app);
  });

  async function openTemplatePanel(app: any) {
    await app.getByTestId('toggle-template').click();
    await expect(app.getByTestId('template-panel')).toBeVisible();
  }

  test('panel opens and shows the four bundled templates', async ({ app }) => {
    await openTemplatePanel(app);
    await expect(app.getByTestId('template-row-bundled-outline')).toBeVisible();
    await expect(app.getByTestId('template-row-bundled-characters')).toBeVisible();
    await expect(app.getByTestId('template-row-bundled-worldbuilding')).toBeVisible();
    await expect(app.getByTestId('template-row-bundled-chapter-skeleton')).toBeVisible();
  });

  test('insert-mode bundled template inserts body into active editor', async ({ app }) => {
    // Open a file first so there's an active editor.
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await expect(app.getByTestId('editor-container')).toBeVisible();

    await openTemplatePanel(app);
    await app.getByTestId('template-row-bundled-chapter-skeleton').click();

    // The editor content now includes the inserted skeleton.
    const content = await app.evaluate(() => {
      const firstEditor = document.querySelector('.cm-content') as HTMLElement | null;
      return firstEditor?.textContent ?? '';
    });
    expect(content).toMatch(/场景/);
    expect(content).toMatch(/冲突/);
    expect(content).toMatch(/转折/);
    // Caret anchor `$|$` must have been stripped.
    expect(content).not.toMatch(/\$\|\$/);
  });

  test('new-file-mode bundled template creates a file and opens it', async ({ app, mockState }) => {
    await openTemplatePanel(app);
    await app.getByTestId('template-row-bundled-outline').click();

    // A tab for "大纲.md" opened.
    await expect(app.getByTestId('tab-bar')).toContainText('大纲', { timeout: 3000 });
    const created = await mockState.getCreatedFiles();
    expect(created.some(p => p.endsWith('/大纲.md'))).toBe(true);
  });

  test('Save current file as template adds a row under Project', async ({ app }) => {
    // Open a chapter so there's an active editor.
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await expect(app.getByTestId('editor-container')).toBeVisible();

    // Use the command palette
    await app.keyboard.press('Meta+Shift+p');
    await expect(app.getByTestId('command-palette')).toBeVisible();
    await app.getByTestId('palette-input').fill('save current');
    const firstResult = app.locator('[data-testid="palette-result-0"]');
    await expect(firstResult).toBeVisible();
    await firstResult.click();

    // Template panel auto-opens + dialog is up.
    await expect(app.getByTestId('template-panel')).toBeVisible();
    await expect(app.getByTestId('template-dialog')).toBeVisible();

    // Fill a distinct name and save.
    await app.getByTestId('template-dialog-name').fill('my-custom-snippet');
    // Default mode is insert — no defaultFilename needed.
    await app.getByTestId('template-dialog-save').click();

    // Row appears in the Project group.
    await expect(app.getByTestId('template-row-project-my-custom-snippet')).toBeVisible({ timeout: 2000 });
  });

  test('right-click on a project row shows Edit/Rename/Delete; bundled row does not', async ({ app }) => {
    // First, seed a project template by saving the current file.
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await openTemplatePanel(app);
    await app.getByTestId('template-new').click();
    await app.getByTestId('template-dialog-name').fill('seeded');
    await app.getByTestId('template-dialog-save').click();
    const projectRow = app.getByTestId('template-row-project-seeded');
    await expect(projectRow).toBeVisible();

    // Right-click: project row has Delete.
    await projectRow.click({ button: 'right' });
    await expect(app.getByTestId('template-ctx-menu')).toBeVisible();
    await expect(app.getByTestId('template-ctx-delete')).toBeVisible();
    await expect(app.getByTestId('template-ctx-edit')).toBeVisible();
    // Close.
    await app.keyboard.press('Escape');
    // The window.onclick handler closes on any click; open it again and move on.

    // Right-click a bundled row: Delete absent, Duplicate-to-project present.
    await app.getByTestId('template-row-bundled-outline').click({ button: 'right' });
    await expect(app.getByTestId('template-ctx-menu')).toBeVisible();
    await expect(app.getByTestId('template-ctx-duplicate')).toBeVisible();
    await expect(app.getByTestId('template-ctx-delete')).toHaveCount(0);
  });

  test('deleting a project template removes it from the panel', async ({ app }) => {
    // Seed via dialog.
    await openTemplatePanel(app);
    await app.getByTestId('template-new').click();
    await app.getByTestId('template-dialog-name').fill('to-delete');
    await app.getByTestId('template-dialog-save').click();

    const row = app.getByTestId('template-row-project-to-delete');
    await expect(row).toBeVisible();

    // Stub confirm so delete proceeds without UI interaction.
    await app.evaluate(() => {
      (window as any).confirm = () => true;
    });

    await row.click({ button: 'right' });
    await app.getByTestId('template-ctx-delete').click();

    await expect(row).toHaveCount(0, { timeout: 2000 });
  });
});
