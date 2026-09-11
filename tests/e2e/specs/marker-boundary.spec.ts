import { test, expect } from '../fixtures/app-fixture';

/**
 * Inline markers (`**`, `*`, `~~`, `` ` ``) collapse to zero width while the
 * cursor is off their node, so a line ending in markup paints narrower than it
 * measures. CodeMirror resolves clicks and vertical moves against the painted
 * geometry, which used to strand the caret at the near edge of a trailing
 * marker run — visually the end of the line, but typing there grew the bold
 * run instead of following it, and a single Down/Up round trip moved the caret
 * without the user touching it.
 *
 * Guards `markerBoundarySnap` in app/lib/editor/wysiwyg.ts.
 */
test.describe('[regression] inline marker caret boundaries', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
  });

  async function caret(app: import('@playwright/test').Page) {
    return app.evaluate(() => {
      const view = (window as any).__novelist_view;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { column: head - line.from, length: line.to - line.from, text: line.text };
    });
  }

  async function appendLine(app: import('@playwright/test').Page, source: string) {
    await app.locator('.cm-editor').click();
    await app.keyboard.press('Meta+ArrowDown');
    await app.keyboard.press('Enter');
    await app.keyboard.type(source);
    await app.keyboard.press('ArrowUp');
    await app.waitForTimeout(150);
  }

  const CASES = [
    { name: 'bold', source: '前面的文字**加粗**', hasText: '前面的文字', typed: '前面的文字**加粗**尾' },
    { name: 'whole-line bold', source: '**整行加粗**', hasText: '整行加粗', typed: '**整行加粗**尾' },
    { name: 'italic', source: '前面的文字*斜体*', hasText: '前面的文字', typed: '前面的文字*斜体*尾' },
    { name: 'inline code', source: '前面的文字`代码`', hasText: '前面的文字', typed: '前面的文字`代码`尾' },
    { name: 'strikethrough', source: '前面的文字~~删除~~', hasText: '前面的文字', typed: '前面的文字~~删除~~尾' },
  ];

  for (const testCase of CASES) {
    test(`clicking past a line-ending ${testCase.name} run types after it`, async ({ app }) => {
      await appendLine(app, testCase.source);
      const line = app.locator('.cm-line').filter({ hasText: testCase.hasText }).last();
      const box = (await line.boundingBox())!;
      await app.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
      await app.waitForTimeout(150);
      await app.keyboard.type('尾');
      expect((await caret(app)).text).toBe(testCase.typed);
    });
  }

  test('a Down/Up round trip leaves the caret at the end of a bold line', async ({ app }) => {
    await app.locator('.cm-editor').click();
    await app.keyboard.press('Meta+ArrowDown');
    await app.keyboard.press('Enter');
    await app.keyboard.type('前面的文字**加粗**');
    await app.keyboard.press('Enter');
    await app.keyboard.type('下一行占位');
    await app.keyboard.press('ArrowUp');
    await app.keyboard.press('End');
    await app.waitForTimeout(150);

    const start = await caret(app);
    expect(start.column).toBe(start.length);

    for (let round = 0; round < 3; round += 1) {
      await app.keyboard.press('ArrowDown');
      await app.waitForTimeout(100);
      await app.keyboard.press('ArrowUp');
      await app.waitForTimeout(100);
      const after = await caret(app);
      expect(after.column, `round ${round} moved the caret`).toBe(after.length);
    }
  });

  test('arrow keys still step through markers that are revealed on the caret line', async ({ app }) => {
    await app.locator('.cm-editor').click();
    await app.keyboard.press('Meta+ArrowDown');
    await app.keyboard.press('Enter');
    await app.keyboard.type('前面的文字**加粗**');
    await app.keyboard.press('End');
    await app.waitForTimeout(120);

    // The snap must not swallow in-line horizontal navigation: the markers are
    // visible here, and stepping into them is how they get edited.
    const columns: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await app.keyboard.press('ArrowLeft');
      await app.waitForTimeout(60);
      columns.push((await caret(app)).column);
    }
    expect(columns).toEqual([10, 9, 8]);
  });
});
