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

/**
 * The pre-edit used to render inline, so every pinyin keystroke re-flowed the
 * grey source after the caret and the page appeared to shiver. It now floats
 * below the caret, out of the text flow. Two invariants matter: the transcript
 * must not move while composing, and the caret must still sit flush against
 * the pending text when idle.
 */
test('literary plugin keeps the transcript still while IME pre-edit text is showing', async ({ page }) => {
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

  const pendingRectBefore = await article.evaluate((element) => {
    const caret = element.querySelector('.typing-caret')!;
    const rect = (caret.nextElementSibling as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });

  const capture = page.locator('textarea.input-capture');
  await capture.dispatchEvent('compositionstart', { data: '' });
  await capture.evaluate((element: HTMLTextAreaElement) => {
    element.value = 'longpan';
    element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'longpan' }));
    element.dispatchEvent(new InputEvent('input', {
      data: 'longpan', inputType: 'insertCompositionText', isComposing: true,
    }));
  });

  await expect(page.locator('.composition-overlay')).toHaveText('longpan');
  // The pre-edit lives outside the article, so the transcript is untouched…
  expect(await article.evaluate((element) => element.textContent)).toBe('北凉王府龙盘虎踞');
  // …and the pending source has not moved by a single pixel.
  const pendingRectAfter = await article.evaluate((element) => {
    const caret = element.querySelector('.typing-caret')!;
    const rect = (caret.nextElementSibling as HTMLElement).getBoundingClientRect();
    return { x: rect.x, y: rect.y };
  });
  expect(pendingRectAfter).toEqual(pendingRectBefore);

  // The overlay is anchored under the caret so the candidate window and the
  // letters being typed stay in the reader's field of view.
  const overlayPosition = await page.evaluate(() => {
    const caret = document.querySelector('.typing-caret')!.getBoundingClientRect();
    const overlay = document.querySelector('.composition-overlay')!.getBoundingClientRect();
    return { dx: overlay.left - caret.left, below: overlay.top - caret.bottom };
  });
  expect(Math.abs(overlayPosition.dx)).toBeLessThanOrEqual(2);
  expect(overlayPosition.below).toBeGreaterThanOrEqual(0);
  expect(overlayPosition.below).toBeLessThanOrEqual(12);
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
  await expect(page.locator('.composition-overlay')).toHaveText('beiliang');
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
  await expect(page.locator('.composition-overlay')).toHaveCount(0);
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

  await capture.press('Tab');
  await expect(page.locator('.chapter-stats')).toContainText('5 已抄 · 0 错字 · 0 评注');
  await expect(page.getByText('Tab 跟打下一字')).toBeVisible();

  // F6 stays wired as the legacy alias.
  await capture.press('F6');
  await expect(page.locator('.chapter-stats')).toContainText('6 已抄 · 0 错字 · 0 评注');
  await capture.press('Meta+z');
  await expect(page.locator('.chapter-stats')).toContainText('5 已抄 · 0 错字 · 0 评注');

  // Some WKWebView/macOS combinations expose Command+Delete as key=Delete
  // even though its physical code and editing intent are backward deletion.
  await capture.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Delete', code: 'Backspace', metaKey: true, bubbles: true, cancelable: true,
    }));
  });
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');
});

/**
 * The caret used to be welded to the transcription frontier: arrow keys did
 * nothing and there was no way to go back and annotate a passage already
 * copied. These lock in the rewind behaviour — free movement over copied text,
 * commentary insertable anywhere, and the source itself still read-only.
 */
test('[regression] literary plugin lets the caret rewind into copied text to annotate it', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'rewind-test',
      revision: 0,
      filePath: '/mock/倒带.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '倒带测试', author: null, language: 'zh-CN' },
        chapter: {
          id: 'chapter-rewind', title: '倒带', volume: null, index: 1, total: 1,
          previousPath: null, nextPath: null,
        },
        source: '北凉王府龙盘虎踞',
        sourceCursor: '北凉王府'.length,
        insertions: [],
        stats: { correct: 4, mistakes: 0, pasted: 0, startedAt: null, completedAt: null },
      }),
    }, '*');
  });

  const capture = page.locator('textarea.input-capture');
  const article = page.locator('article');
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');

  // Walk back two characters — the caret changes colour to say that typing
  // here annotates rather than transcribes.
  await capture.press('ArrowLeft');
  await capture.press('ArrowLeft');
  await expect(page.locator('.typing-caret.rewound')).toHaveCount(1);
  await expect(page.locator('.progress-status')).toContainText('正在回改前文');

  // Commentary lands at the rewound position, between 北凉 and 王府.
  await capture.fill('【好】');
  await expect(page.locator('.comment')).toHaveText('好');
  expect(await article.evaluate((element) => element.textContent)).toBe('北凉好王府龙盘虎踞');
  // The transcription frontier has not moved.
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 1 评注');

  // Backspace removes the commentary, then refuses to eat the source under it.
  await capture.press('Backspace');
  await expect(page.locator('.comment')).toHaveCount(0);
  await capture.press('Backspace');
  await expect(page.locator('.chapter-stats')).toContainText('4 已抄 · 0 错字 · 0 评注');
  expect(await article.evaluate((element) => element.textContent)).toBe('北凉王府龙盘虎踞');

  // Escape returns to the frontier, where transcription resumes normally.
  await capture.press('Escape');
  await expect(page.locator('.typing-caret.rewound')).toHaveCount(0);
  await capture.press('Tab');
  await expect(page.locator('.chapter-stats')).toContainText('5 已抄 · 0 错字 · 0 评注');
});

test('[regression] Shift+Tab fills in the rest of the sentence', async ({ page }) => {
  await page.goto('/plugins/literary-commentary/index.html');
  await page.evaluate(() => {
    window.postMessage({
      type: 'file-open',
      documentId: 'sentence-test',
      revision: 0,
      filePath: '/mock/整句.litstudy',
      locale: 'zh-CN',
      content: JSON.stringify({
        schemaVersion: 1,
        book: { title: '整句测试', author: null, language: 'zh-CN' },
        chapter: {
          id: 'chapter-sentence', title: '整句', volume: null, index: 1, total: 1,
          previousPath: null, nextPath: null,
        },
        source: '庭前有梅。夜雪初停。',
        sourceCursor: 0,
        insertions: [],
        stats: { correct: 0, mistakes: 0, pasted: 0, startedAt: null, completedAt: null },
      }),
    }, '*');
  });

  const capture = page.locator('textarea.input-capture');
  await capture.press('Tab');
  await expect(page.locator('.chapter-stats')).toContainText('1 已抄');

  // Completes through the first 。 and stops there, not at the end of the file.
  await capture.press('Shift+Tab');
  await expect(page.locator('.chapter-stats')).toContainText('5 已抄 · 0 错字 · 0 评注');

  await capture.press('Shift+Tab');
  await expect(page.locator('.chapter-stats')).toContainText('10 已抄 · 0 错字 · 0 评注');
});
