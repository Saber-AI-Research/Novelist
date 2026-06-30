import { test, expect } from '../fixtures/app-fixture';

/**
 * Typora-style editable tables.
 *
 * The GFM table is ALWAYS rendered as a styled <table> — clicking into it
 * edits cells in place (contenteditable) and never drops to a raw
 * `| --- |` plain-text view. Edits commit back to the markdown source on
 * blur / Escape, and structural ops (Tab-append-row, context menu) rewrite
 * the source.
 */

const TABLE_DOC = `# Title

| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |

after the table
`;

/** Replace the whole document and wait for the table widget to render. */
async function loadTable(app: any) {
  await app.evaluate((doc: string) => {
    const view = (window as any).__novelist_view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  }, TABLE_DOC);
  await app.locator('table.cm-novelist-rendered-table').first().waitFor({ state: 'visible', timeout: 5000 });
}

function docText(app: any): Promise<string> {
  return app.evaluate(() => (window as any).__novelist_view.state.doc.toString());
}

test.describe('Editable tables', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
    await loadTable(app);
  });

  test('renders a styled table and never shows raw separator text', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(2);
    await expect(table.locator('tbody tr')).toHaveCount(2);

    // Click into a cell — table must stay rendered, no raw "| --- |".
    await table.locator('tbody tr').first().locator('td').first().click();
    await expect(table).toBeVisible();
    await expect(app.locator('.cm-content')).not.toContainText('| --- |');
  });

  test('editing a cell commits back to the markdown on blur', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    const cell = table.locator('tbody tr').first().locator('td').first(); // "Alice"
    await cell.click();
    await app.keyboard.press('Meta+A');
    await app.keyboard.type('Carol');

    // Blur by clicking a non-table line → commit.
    await app.locator('.cm-line', { hasText: 'after the table' }).click();

    const text = await docText(app);
    expect(text).toContain('| Carol | 30 |');
    expect(text).not.toContain('| Alice | 30 |');
  });

  test('Escape commits and returns focus to the editor', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    const cell = table.locator('tbody tr').nth(1).locator('td').first(); // "Bob"
    await cell.click();
    await app.keyboard.press('Meta+A');
    await app.keyboard.type('Bobby');
    await app.keyboard.press('Escape');

    const text = await docText(app);
    expect(text).toContain('| Bobby | 25 |');

    // CM editor should now hold focus (not a cell).
    const focusedTag = await app.evaluate(() => document.activeElement?.className ?? '');
    expect(focusedTag).not.toContain('cm-novelist-table-cell');
  });

  test('Tab past the last cell appends a row', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    const lastCell = table.locator('tbody tr').nth(1).locator('td').nth(1); // "25"
    await lastCell.click();
    await app.keyboard.press('Tab');

    await expect(table.locator('tbody tr')).toHaveCount(3);
    const text = await docText(app);
    expect(text).toContain('|  |  |');
  });

  test('accepts CJK text in a cell', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    const cell = table.locator('thead th').first(); // "Name"
    await cell.click();
    await app.keyboard.press('Meta+A');
    await app.keyboard.type('姓名');
    await app.locator('.cm-line', { hasText: 'after the table' }).click();

    const text = await docText(app);
    expect(text).toContain('| 姓名 | Age |');
  });

  test('right-click context menu deletes a row', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    await table.locator('tbody tr').first().locator('td').first().click({ button: 'right' });

    const menu = app.locator('.cm-novelist-table-menu');
    await expect(menu).toBeVisible();
    await menu.getByText('Delete row', { exact: true }).click();

    await expect(table.locator('tbody tr')).toHaveCount(1);
    const text = await docText(app);
    expect(text).not.toContain('| Alice | 30 |');
    expect(text).toContain('| Bob | 25 |');
  });

  test('hover toolbar appears when a cell is focused', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    await table.locator('tbody tr').first().locator('td').first().click();
    await expect(app.locator('.cm-novelist-table-toolbar-row')).toBeVisible();
    await expect(app.locator('.cm-novelist-table-toolbar-col')).toBeVisible();
  });
});
