import { test, expect } from '@playwright/test';

test('literary plugin renders CJK source text after the host opens a document', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await expect(page.getByText('正在打开文学评注章节...')).toBeVisible();

  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'render-test',
      revision: 0,
      filePath: '/mock/第一章.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '试读本', author: '作者', language: 'zh-CN' },
        chapter: {
          id: 'chapter-1',
          title: '第一章 雪夜',
          volume: '卷一',
          index: 1,
          total: 2,
          previousPath: null,
          nextPath: '学习内容/第二章.litstudy',
        },
        source: '庭前有一株梅树。\n夜雪初停。',
        sourceCursor: 0,
        insertions: [],
        stats: {
          correct: 0,
          mistakes: 0,
          pasted: 0,
          startedAt: null,
          completedAt: null,
        },
      }),
    }, '*');
  });

  await expect(page.getByRole('heading', { name: '第一章 雪夜' })).toBeVisible();
  await expect(page.getByText('试读本 / 卷一')).toBeVisible();
  await expect(page.getByText('庭前有一株梅树。')).toBeVisible();
  await expect(page.getByText('夜雪初停。')).toBeVisible();
  await expect(page.getByText('1 / 2')).toBeVisible();
});

test('literary plugin leaves no layout whitespace around the caret or IME pre-edit text', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'caret-spacing-test',
      revision: 0,
      filePath: '/mock/光标间距.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '光标间距测试', author: null, language: 'zh-CN' },
        chapter: {
          id: 'chapter-spacing', title: '光标间距', volume: null, index: 1, total: 1,
          previousPath: null, nextPath: null,
        },
        source: '北凉王府龙盘虎踞',
        sourceCursor: '北凉王府'.length,
        insertions: [],
        stats: {
          correct: 4, mistakes: 0, pasted: 0, startedAt: null, completedAt: null,
        },
      }),
    }, '*');
  });

  const article = page.locator('article');
  await expect(article).toContainText('北凉王府龙盘虎踞');
  expect(await article.evaluate((element) => element.textContent)).toBe('北凉王府龙盘虎踞');

  const idleGap = await article.evaluate((element) => {
    const caret = element.querySelector('.typing-caret')!;
    const pendingText = caret.nextElementSibling!.firstChild!;
    const range = document.createRange();
    range.setStart(pendingText, 0);
    range.setEnd(pendingText, 1);
    return range.getBoundingClientRect().left - caret.getBoundingClientRect().right;
  });
  expect(Math.abs(idleGap)).toBeLessThanOrEqual(1);

  const capture = page.locator('textarea.input-capture');
  await capture.dispatchEvent('compositionstart', { data: '' });
  await capture.evaluate((element: HTMLTextAreaElement) => {
    element.value = 'longpan';
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'longpan' }));
    element.dispatchEvent(new InputEvent('input', {
      data: 'longpan', inputType: 'insertCompositionText', isComposing: true,
    }));
  });

  expect(await article.evaluate((element) => element.textContent)).toBe('北凉王府longpan龙盘虎踞');
  const compositionGaps = await article.evaluate((element) => {
    const caret = element.querySelector('.typing-caret')!.getBoundingClientRect();
    const preedit = element.querySelector('.composition-preedit')!;
    const preeditRect = preedit.getBoundingClientRect();
    const pendingText = preedit.nextElementSibling!.firstChild!;
    const range = document.createRange();
    range.setStart(pendingText, 0);
    range.setEnd(pendingText, 1);
    return {
      before: preeditRect.left - caret.right,
      after: range.getBoundingClientRect().left - preeditRect.right,
    };
  });
  expect(Math.abs(compositionGaps.before)).toBeLessThanOrEqual(1);
  expect(Math.abs(compositionGaps.after)).toBeLessThanOrEqual(1);
});

test('literary plugin commits IME text once and uses brackets for comments', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await expect(page.getByText('正在打开文学评注章节...')).toBeVisible();
  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'ime-test',
      revision: 0,
      filePath: '/mock/输入法.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '输入法测试', author: null, language: 'zh-CN' },
        chapter: {
          id: 'chapter-ime', title: '输入法', volume: null, index: 1, total: 1,
          previousPath: null, nextPath: null,
        },
        source: '北凉王府',
        sourceCursor: 0,
        insertions: [],
        stats: {
          correct: 0, mistakes: 0, pasted: 0, startedAt: null, completedAt: null,
        },
      }),
    }, '*');
  });

  const capture = page.locator('textarea.input-capture');
  await capture.dispatchEvent('compositionstart', { data: '' });
  await capture.evaluate((element: HTMLTextAreaElement) => {
    element.value = 'beiliang';
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'beiliang' }));
    element.dispatchEvent(new InputEvent('input', {
      data: 'beiliang', inputType: 'insertCompositionText', isComposing: true,
    }));
  });
  await expect(page.locator('.composition-preedit')).toHaveText('beiliang');
  await expect(page.locator('.mistake')).toHaveCount(0);

  const anchor = await page.locator('.typing-caret').boundingBox();
  const captureBox = await capture.boundingBox();
  expect(anchor).not.toBeNull();
  expect(captureBox).not.toBeNull();
  expect(Math.abs(captureBox!.x - anchor!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(captureBox!.y - anchor!.y)).toBeLessThanOrEqual(2);

  await capture.evaluate((element: HTMLTextAreaElement) => {
    element.value = '北凉';
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '北凉' }));
    element.dispatchEvent(new InputEvent('input', {
      data: '北凉', inputType: 'insertFromComposition', isComposing: false,
    }));
  });
  await expect(page.locator('.composition-preedit')).toHaveCount(0);
  await expect(page.locator('.chapter-stats')).toContainText('2 已抄 · 0 错字');
  await expect(page.locator('.mistake')).toHaveCount(0);

  await capture.fill('【');
  await expect(page.getByText('正在评注')).toBeVisible();
  await capture.fill('风骨凛然');
  await expect(page.locator('.comment')).toHaveText('风骨凛然');
  await capture.fill('】王府');

  await expect(page.getByText('输入【开始评注')).toBeVisible();
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 4 评注');
  await expect(page.getByRole('button', { name: '抄写' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '评注' })).toHaveCount(0);
});

test('literary plugin preserves macOS deletion and undo shortcuts', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'shortcut-test',
      revision: 0,
      filePath: '/mock/快捷键.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '快捷键测试', author: null, language: 'zh-CN' },
        chapter: {
          id: 'chapter-shortcuts', title: '快捷键', volume: null, index: 1, total: 1,
          previousPath: null, nextPath: null,
        },
        source: '第一行\n第二行',
        sourceCursor: 0,
        insertions: [],
        stats: {
          correct: 0, mistakes: 17, pasted: 0, startedAt: null, completedAt: null,
        },
      }),
    }, '*');
  });

  const capture = page.locator('textarea.input-capture');
  await capture.fill('第一行\n第二行【行尾批注】');
  await expect(page.locator('.chapter-stats')).toContainText('7 已抄 · 0 错字 · 4 评注');

  await capture.press('Meta+Backspace');
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');
  await expect(page.locator('.comment')).toHaveCount(0);

  await capture.press('Meta+z');
  await expect(page.locator('.chapter-stats')).toContainText('7 已抄 · 0 错字 · 4 评注');
  await expect(page.locator('.comment')).toHaveText('行尾批注');

  await capture.press('Meta+Shift+z');
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');

  await capture.press('F6');
  await expect(page.locator('.chapter-stats')).toContainText('5 已抄 · 0 错字 · 0 评注');
  await expect(page.getByText('F6 跟打下一字')).toBeVisible();

  // Some WKWebView/macOS combinations expose Command+Delete as key=Delete
  // even though its physical code and editing intent are backward deletion.
  await capture.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true,
    }));
  });
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');
});
