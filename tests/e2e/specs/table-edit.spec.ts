import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';

const TABLE_SOURCE = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
const TABLE_DOC = `# Title\n\n${TABLE_SOURCE}\n\nafter the table\n`;

async function loadTable(app: Page, source = TABLE_DOC) {
  await app.evaluate(async (doc) => {
    await (window as any).__test_api__.setActiveEditorDocument(doc, { anchor: 0, head: 0 });
  }, source);
  await expect(app.locator('table.cm-novelist-rendered-table').first()).toBeVisible();
}

function docText(app: Page): Promise<string> {
  return app.evaluate(() => (window as any).__test_api__.getActiveEditor().view.state.doc.toString());
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

  test('renders an editable table without exposing separator source', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table').first();
    await expect(table.locator('thead th')).toHaveCount(2);
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await table.locator('tbody td').first().click();
    await expect(table).toBeVisible();
    await expect(app.locator('.cm-content')).not.toContainText('| --- |');
  });

  test('editing a cell commits Markdown and preserves neighboring cells on blur', async ({ app }) => {
    const cell = app.locator('tbody td').first();
    await cell.click();
    await app.keyboard.press('Meta+A');
    await app.keyboard.insertText('姓名 | 中文');
    await app.locator('.cm-line', { hasText: 'after the table' }).click();
    await expect.poll(() => docText(app)).toBe(TABLE_DOC.replace('Alice', '姓名 \\| 中文'));
  });

  test('Escape creates separated prose before a following heading and preserves table edits', async ({ app }) => {
    await loadTable(app, `${TABLE_SOURCE}\n\n## 后文\n`);
    const cell = app.locator('tbody tr').last().locator('td').first();
    await cell.click();
    await app.keyboard.press('Meta+A');
    await app.keyboard.insertText('小明');
    await app.keyboard.press('Escape');
    await expect(app.locator('.cm-content')).toBeFocused();
    await app.keyboard.insertText('表格后中文');
    await expect.poll(() => docText(app)).toBe(`${TABLE_SOURCE.replace('Bob', '小明')}\n\n表格后中文\n\n## 后文\n`);
    await expect(app.locator('tbody tr')).toHaveCount(2);
    await expect(app.locator('.cm-line', { hasText: '后文' })).toBeVisible();
  });

  test('Escape from a terminal table creates editable prose outside its replacement', async ({ app }) => {
    await loadTable(app, TABLE_SOURCE);
    await app.locator('tbody td').last().click();
    await app.keyboard.press('Escape');
    await app.keyboard.insertText('末尾中文');
    await expect.poll(() => docText(app)).toBe(`${TABLE_SOURCE}\n\n末尾中文`);
    await expect(app.locator('tbody tr')).toHaveCount(2);
  });

  test('Tab append restores the new cell before typing and repeated navigation', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table');
    await table.locator('tbody td').last().click();
    await app.keyboard.press('Tab');
    await expect(table.locator('tbody tr').nth(2).locator('td').first()).toBeFocused();
    await app.keyboard.insertText('新增');
    await app.keyboard.press('Tab');
    await app.keyboard.insertText('42');
    await app.keyboard.press('Tab');
    await expect(table.locator('tbody tr').nth(3).locator('td').first()).toBeFocused();
    await app.keyboard.insertText('下一行');
    await app.keyboard.press('Escape');
    await expect.poll(() => docText(app)).toBe(TABLE_DOC.replace('| Bob | 25 |\n\n', '| Bob | 25 |\n| 新增 | 42 |\n| 下一行 |  |\n\n\n\n'));
  });

  test('Enter in a header-only table appends a body row at the same column', async ({ app }) => {
    await loadTable(app, '| Name | Age |\n| --- | --- |');
    await app.locator('thead th').last().click();
    await app.keyboard.press('Enter');
    await expect(app.locator('tbody td').last()).toBeFocused();
    await app.keyboard.insertText('首行');
    await app.keyboard.press('Escape');
    await expect.poll(() => docText(app)).toBe('| Name | Age |\n| --- | --- |\n|  | 首行 |\n\n');
  });

  test('IME navigation and confirmation keys leave the cell and document untouched', async ({ app }) => {
    const cell = app.locator('tbody td').last();
    await cell.click();
    const outcomes = await cell.evaluate((target) => {
      const results: boolean[] = [];
      // Browsers can report native composition before compositionstart reaches us.
      for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        results.push(event.defaultPrevented);
      }
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const key of ['Enter', 'Tab', 'Escape']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        results.push(event.defaultPrevented);
      }
      target.textContent = '中文';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '中文', isComposing: true }));
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      const confirm = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      target.dispatchEvent(confirm);
      results.push(confirm.defaultPrevented);
      return results;
    });
    expect(outcomes).toEqual([false, false, false, false, false, false]);
    await expect(cell).toBeFocused();
    await expect(app.locator('tbody tr')).toHaveCount(2);
    expect(await docText(app)).toBe(TABLE_DOC);
    await expect(cell).toHaveText('中文');
    await app.keyboard.press('Escape');
    await app.keyboard.insertText('后续');
    await expect.poll(() => docText(app)).toBe(TABLE_DOC.replace('| Bob | 25 |\n\n', '| Bob | 中文 |\n\n后续\n\n'));
  });

  test('DOM reuse retains composition ownership and blur commits the final input', async ({ app }) => {
    const cell = app.locator('tbody td').last();
    await cell.click();
    await cell.evaluate((target) => {
      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      target.textContent = 'zhong';
      const view = (window as any).__test_api__.getActiveEditor().view;
      const from = view.state.doc.toString().indexOf('Name');
      view.dispatch({ changes: { from, to: from + 4, insert: '姓名' } });
      // Final input follows compositionend on WebKit, even after focus has left.
      view.focus();
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      target.textContent = '中文';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文', inputType: 'insertText' }));
    });
    await expect.poll(() => docText(app)).toBe(TABLE_DOC.replace('Name', '姓名').replace('| Bob | 25 |', '| Bob | 中文 |'));
    await expect(app.locator('tbody td').last()).toHaveText('中文');
  });

  test('column changes after DOM reuse retain alignment and focus the intended column', async ({ app }) => {
    await app.locator('tbody td').first().click();
    await app.getByRole('button', { name: 'Align center', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Align center', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await app.getByRole('button', { name: 'Insert column right', exact: true }).click();
    const row = app.locator('tbody tr').first();
    await expect(row.locator('td').nth(1)).toBeFocused();
    await app.keyboard.insertText('中列');
    await app.keyboard.press('Tab');
    await expect(row.locator('td').nth(2)).toBeFocused();
    await app.keyboard.press('Escape');
    await expect.poll(() => docText(app)).toBe('# Title\n\n| Name |  | Age |\n| :---: | --- | --- |\n| Alice | 中列 | 30 |\n| Bob |  | 25 |\n\n\n\nafter the table\n');
  });

  test('context-menu deletion restores neighboring cell focus', async ({ app }) => {
    const table = app.locator('table.cm-novelist-rendered-table');
    await table.locator('tbody td').first().click({ button: 'right' });
    const menu = app.locator('.cm-novelist-table-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Delete row', exact: true }).click();
    await expect(table.locator('tbody td').first()).toBeFocused();
    await app.keyboard.press('Meta+A');
    await app.keyboard.insertText('剩余');
    await app.keyboard.press('Escape');
    await expect.poll(() => docText(app)).toBe('# Title\n\n| Name | Age |\n| --- | --- |\n| 剩余 | 25 |\n\n\n\nafter the table\n');
  });

  test('structural controls are keyboard reachable with disabled header deletion', async ({ app }) => {
    await app.locator('thead th').first().click();
    await expect(app.getByRole('button', { name: 'Delete row', exact: true })).toBeDisabled();
    await app.keyboard.press('Alt+F10');
    await expect(app.getByRole('button', { name: 'Insert row above', exact: true })).toBeFocused();
    await app.keyboard.press('Escape');
    await expect(app.locator('thead th').first()).toBeFocused();
  });

  test('wide tables remain bounded with stable controls and prose at compact zoom', async ({ app }) => {
    await app.setViewportSize({ width: 900, height: 700 });
    await app.evaluate(() => {
      const root = document.documentElement;
      root.style.transform = 'scale(1.3)';
      root.style.transformOrigin = 'top left';
      root.style.width = `${100 / 1.3}%`;
      root.style.height = `${100 / 1.3}%`;
    });
    const headers = Array.from({ length: 12 }, (_, i) => `第${i + 1}列`);
    const source = `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n| ${headers.map(() => '中文内容').join(' | ')} |\n\nafter the table`;
    await loadTable(app, source);
    const after = app.locator('.cm-line', { hasText: 'after the table' });
    const beforeFocus = await after.boundingBox();
    await app.locator('tbody td').first().click();
    const afterFocus = await after.boundingBox();
    expect(afterFocus!.y).toBeCloseTo(beforeFocus!.y, 0);
    const scroller = app.locator('.cm-novelist-table-scroll');
    await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    const geometry = await app.locator('.cm-novelist-table-widget').evaluate((el) => {
      const wrapper = el.getBoundingClientRect();
      const controls = Array.from(el.querySelectorAll('.cm-novelist-table-tool-btn'), button => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, bottom: rect.bottom };
      });
      const scroll = el.querySelector('.cm-novelist-table-scroll') as HTMLElement;
      return { left: wrapper.left, right: wrapper.right, tableTop: scroll.getBoundingClientRect().top, scrollWidth: scroll.scrollWidth, clientWidth: scroll.clientWidth, controls, viewport: window.innerWidth };
    });
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
    for (const control of geometry.controls) {
      expect(control.left).toBeGreaterThanOrEqual(geometry.left - 1);
      expect(control.right).toBeLessThanOrEqual(geometry.right + 1);
      expect(control.bottom).toBeLessThanOrEqual(geometry.tableTop);
    }
  });
});
