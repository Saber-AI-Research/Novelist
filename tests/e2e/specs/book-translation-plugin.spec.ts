import { test, expect, type Page } from '@playwright/test';
import {
  connectPluginHost,
  pluginMessages,
  postToPlugin,
  type PluginMessage,
} from '../fixtures/plugin-host';

const CHAPTER = JSON.stringify({
  schemaVersion: 1,
  book: {
    title: 'Demo Book',
    author: 'Demo Author',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
  },
  chapter: {
    id: 'chapter-0001',
    title: '第一章',
    volume: null,
    index: 1,
    total: 2,
    previousPath: null,
    nextPath: '翻译内容/0002.novtrans',
  },
  segments: [
    { id: 'segment-0001', source: 'Hello', translation: '', googleReference: null, llmReference: null },
    { id: 'segment-0002', source: '世界', translation: '', googleReference: null, llmReference: null },
  ],
});

/** Open the plugin as a top-level page and act as its host. */
async function openPlugin(page: Page, documentId: string, revision: number) {
  await page.goto('/plugins/book-translation/index.html');
  await connectPluginHost(page);
  await postToPlugin(page, {
    type: 'file-open',
    documentId,
    revision,
    filePath: '/mock/翻译内容/0001.novtrans',
    locale: 'en',
    content: CHAPTER,
  });
}

async function messagesOfType(page: Page, type: string): Promise<PluginMessage[]> {
  return (await pluginMessages(page)).filter((message) => message.type === type);
}

test.describe('Book translation plugin', () => {
  test('renders aligned source and translation segments', async ({ page }) => {
    await openPlugin(page, 'translation-render-test', 0);

    await expect(page.getByTestId('book-translation-workspace')).toBeVisible();
    await expect(page.getByTestId('book-translation-source-segment-0001')).toHaveText('Hello');
    await expect(page.getByTestId('book-translation-source-segment-0002')).toHaveText('世界');
    await expect(page.getByTestId('book-translation-translation-segment-0001')).toHaveValue('');
    await expect(page.getByTestId('book-translation-translation-segment-0002')).toHaveValue('');
    await expect(page.getByText('en → zh-CN', { exact: true })).toBeVisible();
  });

  test('ignores host messages that do not arrive on its host port', async ({ page }) => {
    await page.goto('/plugins/book-translation/index.html');
    await connectPluginHost(page);
    await expect.poll(async () => (await messagesOfType(page, 'plugin-ready')).length).toBe(1);
    // Any frame can post to the plugin's window; only the port is trusted.
    // Messages to one window dispatch in order, so the sentinel arrives only
    // after every window listener has seen the forged file-open.
    await page.evaluate((content) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      window.addEventListener('message', (event) => {
        if (event.data === 'forged-file-open-dispatched') resolve();
      });
      window.postMessage({
        type: 'file-open',
        documentId: 'forged',
        revision: 0,
        filePath: '/mock/翻译内容/0001.novtrans',
        locale: 'en',
        content,
      }, '*');
      window.postMessage('forged-file-open-dispatched', '*');
      return promise;
    }, CHAPTER);
    await expect(page.getByTestId('book-translation-workspace')).toHaveCount(0);
  });

  test('publishes a single segment edit and handles a Google reference result', async ({ page }) => {
    await openPlugin(page, 'translation-edit-test', 4);

    const firstTranslation = page.getByTestId('book-translation-translation-segment-0001');
    await firstTranslation.fill('你好');

    await expect.poll(() => messagesOfType(page, 'file-state')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        revision: expect.any(Number),
        content: expect.stringContaining('"translation": "你好"'),
      }),
    ]));
    const stateMessages = await messagesOfType(page, 'file-state');
    expect(stateMessages.some((message) => (
      typeof message.content === 'string'
      && message.content.includes('"source": "世界"')
      && message.content.includes('"translation": ""')
    ))).toBe(true);

    await page.getByTestId('book-translation-google-segment-0001').click();
    await expect.poll(() => messagesOfType(page, 'translation-reference-request')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        documentId: 'translation-edit-test',
        segmentId: 'segment-0001',
        provider: 'google',
        source: 'Hello',
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
      }),
    ]));

    const [request] = await messagesOfType(page, 'translation-reference-request');
    await postToPlugin(page, {
      type: 'translation-reference-result',
      requestId: request.requestId,
      documentId: 'translation-edit-test',
      segmentId: 'segment-0001',
      provider: 'google',
      ok: true,
      reference: '你好，世界',
    });
    await expect(page.getByTestId('book-translation-google-reference-segment-0001')).toHaveText('你好，世界');

    await page.getByRole('button', { name: 'Next chapter' }).click();
    await expect.poll(() => messagesOfType(page, 'open-project-file')).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: '翻译内容/0002.novtrans' }),
    ]));
  });
});
