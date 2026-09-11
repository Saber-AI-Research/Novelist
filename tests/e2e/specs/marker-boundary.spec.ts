import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';
import type { Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// The app exposes this in-process API only in the browser fixture.
type EditorTestWindow = typeof window & {
  __test_api__: {
    getActiveEditor(): { view: EditorView; filePath: string } | null;
    setActiveEditorDocument(doc: string, selection: { anchor: number; head: number }): Promise<void>;
  };
};

async function caret(app: Page) {
  return app.evaluate(() => {
    const active = (window as EditorTestWindow).__test_api__.getActiveEditor();
    if (!active) throw new Error('Active editor is not ready');
    const { view } = active;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    return { column: head - line.from, length: line.to - line.from, text: line.text };
  });
}

async function setDocument(app: Page, doc: string, cursor: number) {
  await app.evaluate(async ({ doc, cursor }) => {
    await (window as EditorTestWindow).__test_api__.setActiveEditorDocument(doc, { anchor: cursor, head: cursor });
  }, { doc, cursor });
  await expect.poll(() => app.evaluate(() =>
    (window as EditorTestWindow).__test_api__.getActiveEditor()?.view.state.doc.toString()
  )).toBe(doc);
}

test.describe('[regression] inline marker caret boundaries', () => {
  test.beforeEach(async ({ app }) => {
    const recentItem = app.getByTestId('recent-project-0');
    if (await recentItem.isVisible().catch(() => false)) {
      await recentItem.click();
      await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
    }
    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await expect.poll(() => app.evaluate(() =>
      (window as EditorTestWindow).__test_api__.getActiveEditor()?.filePath ?? null
    )).toBe(`${MOCK_PROJECT_DIR}/Chapter 1.md`);
  });

  const CASES = [
    { name: 'bold', source: '前面的文字**加粗**', hasText: '前面的文字' },
    { name: 'whole-line bold', source: '**整行加粗**', hasText: '整行加粗' },
    { name: 'nested bold italic', source: '前文***嵌套***', hasText: '前文' },
    { name: 'italic', source: '前面的文字*斜体*', hasText: '前面的文字' },
    { name: 'inline code', source: '前面的文字`代码`', hasText: '前面的文字' },
    { name: 'strikethrough', source: '前面的文字~~删除~~', hasText: '前面的文字' },
  ];

  for (const testCase of CASES) {
    test(`clicking past a line-ending ${testCase.name} run types after it`, async ({ app }) => {
      await setDocument(app, `占位\n\n${testCase.source}`, 0);
      const line = app.locator('.cm-line').filter({ hasText: testCase.hasText }).last();
      const box = (await line.boundingBox())!;
      await app.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
      await expect.poll(async () => (await caret(app)).column).toBe(testCase.source.length);
      await app.keyboard.insertText('尾');
      await expect.poll(async () => (await caret(app)).text).toBe(`${testCase.source}尾`);
    });
  }

  test('a Down/Up round trip leaves the caret at the end of a bold line', async ({ app }) => {
    const first = '前面的文字**加粗**';
    await setDocument(app, `${first}\n下一行占位文字足够长`, first.length);
    for (let round = 0; round < 3; round += 1) {
      await app.keyboard.press('ArrowDown');
      await expect.poll(async () => (await caret(app)).text).toBe('下一行占位文字足够长');
      await app.keyboard.press('ArrowUp');
      await expect.poll(() => caret(app)).toEqual({ column: first.length, length: first.length, text: first });
    }
  });

  test('arrow keys still step through markers that are revealed on the caret line', async ({ app }) => {
    const source = '前面的文字**加粗**';
    await setDocument(app, source, source.length);
    const columns: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await app.keyboard.press('ArrowLeft');
      columns.push((await caret(app)).column);
    }
    expect(columns).toEqual([10, 9, 8]);
  });

  test('editing ordinary prose around multiple inline bold spans keeps wrapped caret geometry stable', async ({ app }) => {
    const source = `${'这是普通前文，'.repeat(16)}**局部加粗**${'这里仍是普通正文，'.repeat(16)}**另一个重点**${'这是普通后文，'.repeat(16)}`;
    const positions = [
      2, source.indexOf('**') - 1,
      source.indexOf('这里'), source.indexOf('这里') + 2,
      source.lastIndexOf('**') + 2, source.lastIndexOf('这是') + 2,
    ];
    for (const position of positions) {
      await setDocument(app, `${source}\n\n下一段`, source.indexOf('局部') + 1);
      await app.evaluate((position) => {
        const { view } = (window as EditorTestWindow).__test_api__.getActiveEditor()!;
        view.dispatch({ selection: { anchor: position, head: position + 1 }, scrollIntoView: true });
      }, position);
      const line = app.locator('.cm-line').first();
      const before = await app.evaluate((position) => {
        const { view } = (window as EditorTestWindow).__test_api__.getActiveEditor()!;
        const point = view.coordsAtPos(position + 1);
        if (!point) throw new Error('Selected prose position is not rendered');
        return { x: point.left, y: point.top, height: view.contentDOM.querySelector('.cm-line')!.getBoundingClientRect().height };
      }, position);
      await app.keyboard.insertText('中');
      const expected = `${source.slice(0, position)}中${source.slice(position + 1)}`;
      await expect(line).toHaveText(expected);
      const after = await app.evaluate(() => {
        const { view } = (window as EditorTestWindow).__test_api__.getActiveEditor()!;
        const point = view.coordsAtPos(view.state.selection.main.head);
        if (!point) throw new Error('Edited prose caret is not rendered');
        return { x: point.left, y: point.top, height: view.contentDOM.querySelector('.cm-line')!.getBoundingClientRect().height };
      });
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      expect(after.height).toBeCloseTo(before.height, 1);
      await expect.poll(async () => (await caret(app)).column).toBe(position + 1);
    }
  });

  test('the first Chinese character after an empty heading keeps its source and caret', async ({ app }) => {
    await setDocument(app, '## \n\n正文', 3);
    await app.keyboard.insertText('中');
    await expect.poll(() => caret(app)).toEqual({ column: 4, length: 4, text: '## 中' });
    await app.keyboard.insertText('文');
    await expect.poll(() => caret(app)).toEqual({ column: 5, length: 5, text: '## 中文' });
    await app.keyboard.press('ArrowDown');
    await expect(app.locator('.cm-line').first()).toHaveText('中文');
  });
});
