import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

test.describe('Editor', () => {
  test.beforeEach(async ({ app }) => {
    // Open project and a file
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }

    const fileItem = app.getByTestId('sidebar-file-Chapter 1.md');
    await fileItem.click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  test('editor displays file content', async ({ app }) => {
    const cmContent = app.locator('.cm-content');
    await expect(cmContent).toContainText('Chapter 1');
    await expect(cmContent).toContainText('dark and stormy night');
  });

  test('clicking in editor reports the clicked cursor line', async ({ app }) => {
    const targetLine = app.locator('.cm-line').filter({ hasText: 'wind howled' });
    await targetLine.click();

    const cursorLine = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      if (!view) return -1;
      const pos = view.state.selection.main.head;
      return view.state.doc.lineAt(pos).number;
    });

    expect(cursorLine).toBeGreaterThan(0);
    await expect(app.getByTestId('status-cursor-pos')).toContainText(`Ln ${cursorLine}`);
  });

  test('typing inserts text at cursor position', async ({ app }) => {
    const cmEditor = app.locator('.cm-editor');
    await cmEditor.click();

    await app.keyboard.press('Meta+ArrowDown');
    await app.keyboard.press('Enter');
    await app.keyboard.type('New paragraph here');

    const cmContent = app.locator('.cm-content');
    await expect(cmContent).toContainText('New paragraph here');
  });

  test('CJK content renders correctly', async ({ app }) => {
    const fileItem = app.getByTestId('sidebar-file-Chapter 3.md');
    await fileItem.click();

    const cmContent = app.locator('.cm-content');
    await expect(cmContent).toContainText('第三章');
    await expect(cmContent).toContainText('中文测试文本');
  });

  test('external reload is deferred while IME composition is active', async ({ app, mockState }) => {
    const filePath = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
    const initialContent = await app.evaluate(() => (window as any).__novelist_view.state.doc.toString());
    const pos = await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const pos = view.state.doc.toString().indexOf('stormy') + 'stormy'.length;
      view.dispatch({ selection: { anchor: pos } });
      view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      (window as any).__ime_test_view = view;
      return pos;
    });

    const cleanExternal = '# 第一章\n\n外部合成结束版本。\n';
    await mockState.setFileContent(filePath, cleanExternal);
    await mockState.emitEvent('file-changed', { path: filePath });
    await app.waitForTimeout(150);

    const duringComposition = await app.evaluate(({ expectedPos, expectedContent }) => {
      const view = (window as any).__novelist_view;
      return {
        sameView: view === (window as any).__ime_test_view,
        head: view.state.selection.main.head,
        expectedPos,
        content: view.state.doc.toString(),
        expectedContent,
      };
    }, { expectedPos: pos, expectedContent: initialContent });

    expect(duringComposition.sameView).toBe(true);
    expect(duringComposition.head).toBe(pos);
    expect(duringComposition.content).toBe(initialContent);
    await expect(app.getByRole('dialog')).toHaveCount(0);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }));
      delete (window as any).__ime_test_view;
    });

    await expect.poll(() => app.evaluate(() => (window as any).__novelist_view.state.doc.toString()))
      .toBe(cleanExternal);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n本地未保存内容。' } });
      view.contentDOM.dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    const dirtyLocal = `${cleanExternal}\n本地未保存内容。`;
    const dirtyExternal = '# 第一章\n\n外部冲突内容。\n';
    await mockState.setFileContent(filePath, dirtyExternal);
    await mockState.emitEvent('file-changed', { path: filePath });
    await app.waitForTimeout(150);

    await expect(app.getByRole('dialog')).toHaveCount(0);
    expect(await app.evaluate(() => (window as any).__novelist_view.state.doc.toString())).toBe(dirtyLocal);

    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.contentDOM.dispatchEvent(new Event('compositionend', { bubbles: true }));
    });
    const conflict = app.getByRole('dialog');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('Chapter 1.md');
    await expect(conflict.getByRole('button', { name: 'Keep Mine' })).toBeVisible();
    await expect(conflict.getByRole('button', { name: 'Load Theirs' })).toBeVisible();
    expect(await app.evaluate(() => (window as any).__novelist_view.state.doc.toString())).toBe(dirtyLocal);
    await app.screenshot({ path: '.sisyphus/evidence/task-11-ime-conflict.png' });
  });
});
