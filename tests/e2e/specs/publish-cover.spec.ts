import { expect, test } from '../fixtures/app-fixture';
import type { Locator, Page } from '@playwright/test';
import { OPAQUE_RED_PNG_BYTES, SECOND_OPAQUE_RED_PNG_BYTES } from '../fixtures/image-data';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

declare const Buffer: {
  from(bytes: Uint8Array): unknown;
};

const GHOST_CHANNEL = {
  id: 'ghost-main',
  name: 'Editorial Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
};

const CHAPTER_PATH = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
const PNG_BYTES = OPAQUE_RED_PNG_BYTES;
const OTHER_PNG_BYTES = SECOND_OPAQUE_RED_PNG_BYTES;

async function openChapter(app: Page) {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible' });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible' });
}

async function openPublish(app: Page) {
  await app.locator('.share-btn').click();
  await app.getByRole('menuitem', { name: /Publish to Editorial Ghost/ }).click();
  await expect(app.getByRole('dialog')).toBeVisible();
  await expect(app.getByTestId('publish-cover-drop')).toBeVisible();
}

async function waitForPreviewPixels(app: Page) {
  const preview = app.getByTestId('publish-cover-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const pixel = await preview.evaluate((image: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return [];
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
  expect(pixel).toEqual([255, 0, 0, 255]);
}

async function dropFile(target: Locator, bytes: Uint8Array, name: string, mime: string) {
  await target.evaluate((element, input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(input.bytes)], input.name, { type: input.mime }));
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { bytes: Array.from(bytes), name, mime });
}

async function pasteFile(target: Locator, bytes: Uint8Array, name: string, mime: string) {
  return target.evaluate((element, input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(input.bytes)], input.name, { type: input.mime }));
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { bytes: Array.from(bytes), name, mime });
}

async function pasteEmpty(target: Locator) {
  await target.evaluate((element) => {
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    element.dispatchEvent(event);
  });
}

async function flushUi(app: Page) {
  await app.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function coverMockState(app: Page) {
  return app.evaluate(() => {
    const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
    return Reflect.get(state, 'publishCoverState');
  });
}

test.describe('[publish-cover] durable cover and scoped paste', () => {
  test.beforeEach(async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await openChapter(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('picker persists one canonical asset, restores after close and reload, and publishes durable bytes @task23', async ({ app, mockState }, testInfo) => {
    await openPublish(app);
    const chooserPromise = app.waitForEvent('filechooser');
    await app.getByTestId('publish-cover-choose').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: '封面 image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BYTES) as never,
    });
    await waitForPreviewPixels(app);
    await app.getByTestId('publish-cover-drop').screenshot({
      path: `.sisyphus/evidence/task-23-cover-preview-${testInfo.project.name}.png`,
    });

    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'store_publish_cover').length).toBe(1);
    let calls = await mockState.getInvokeCalls();
    const store = calls.find((call) => call.command === 'store_publish_cover');
    expect(store?.args).toEqual({
      projectDir: MOCK_PROJECT_DIR,
      filePath: CHAPTER_PATH,
      channelId: GHOST_CHANNEL.id,
      bytes: Array.from(PNG_BYTES),
      declaredMime: 'image/png',
    });
    let state = await coverMockState(app) as { assets: Record<string, number[]>; refs: Record<string, unknown> };
    expect(Object.keys(state.assets)).toHaveLength(1);
    expect(Object.keys(state.refs)).toHaveLength(1);

    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openPublish(app);
    await waitForPreviewPixels(app);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.reload();
    await openChapter(app);
    await openPublish(app);
    await waitForPreviewPixels(app);

    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    calls = await mockState.getInvokeCalls();
    const upload = calls.findLast((call) => call.command === 'upload_post_image_ghost');
    expect(upload?.args).toMatchObject({
      bytes: Array.from(PNG_BYTES),
      mime: 'image/png',
    });
    expect(upload?.args.filename).toMatch(/^[0-9a-f]{64}\.png$/);
    state = await coverMockState(app) as { assets: Record<string, number[]>; refs: Record<string, unknown> };
    expect(Object.keys(state.assets)).toHaveLength(1);
    expect((await mockState.getCreatedFiles()).some((path) => path.includes('/.novelist/images'))).toBe(false);
  });

  test('direct ClipboardEvent image wins and empty event falls back to Rust clipboard bytes @task23', async ({ app, mockState }) => {
    await openPublish(app);
    await mockState.reset();
    const tile = app.getByTestId('publish-cover-drop');
    await tile.focus();
    expect(await pasteFile(tile, PNG_BYTES, 'direct.png', 'image/png')).toBe(true);
    await waitForPreviewPixels(app);
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'store_publish_cover').length).toBe(1);
    let calls = await mockState.getInvokeCalls();
    expect(calls.some((call) => call.command === 'read_clipboard_image')).toBe(false);

    await app.evaluate((image) => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setter = Reflect.get(state, 'setPublishClipboardImage') as (value: unknown) => void;
      setter(image);
    }, { bytes: Array.from(OTHER_PNG_BYTES), mime: 'image/png', width: 1, height: 1 });
    await tile.evaluate((element) => {
      const transfer = new DataTransfer();
      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      });
      element.dispatchEvent(event);
    });
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'store_publish_cover').length).toBe(2);
    calls = await mockState.getInvokeCalls();
    const readIndex = calls.findIndex((call) => call.command === 'read_clipboard_image');
    const secondStoreIndex = calls.findLastIndex((call) => call.command === 'store_publish_cover');
    expect(readIndex).toBeGreaterThanOrEqual(0);
    expect(secondStoreIndex).toBeGreaterThan(readIndex);
    expect(calls[secondStoreIndex].args.bytes).toEqual(Array.from(OTHER_PNG_BYTES));
  });

  test('Publish waits for blocked Rust clipboard fallback and uploads the released bytes', async ({ app, mockState }) => {
    await openPublish(app);
    await mockState.reset();
    await mockState.setPublishClipboardImage({
      bytes: Array.from(OTHER_PNG_BYTES),
      mime: 'image/png',
      width: 1,
      height: 1,
    });
    await mockState.setPublishClipboardReadBlocked(true);

    await pasteEmpty(app.getByTestId('publish-cover-drop'));
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'read_clipboard_image').length).toBe(1);
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await flushUi(app);
    await pasteFile(app.getByTestId('publish-cover-drop'), PNG_BYTES, 'late-direct.png', 'image/png');

    let calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'publish_to_ghost')).toHaveLength(0);

    await mockState.releaseNextPublishClipboardRead();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    calls = await mockState.getInvokeCalls();
    const store = calls.find((call) => call.command === 'store_publish_cover');
    const upload = calls.find((call) => call.command === 'upload_post_image_ghost');
    expect(store?.args.bytes).toEqual(Array.from(OTHER_PNG_BYTES));
    expect(upload?.args.bytes).toEqual(Array.from(OTHER_PNG_BYTES));
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(1);
  });

  test('Close waits for blocked Rust clipboard fallback and the released cover restores', async ({ app, mockState }) => {
    await openPublish(app);
    await mockState.reset();
    await mockState.setPublishClipboardImage({
      bytes: Array.from(PNG_BYTES),
      mime: 'image/png',
      width: 1,
      height: 1,
    });
    await mockState.setPublishClipboardReadBlocked(true);

    await pasteEmpty(app.getByTestId('publish-cover-drop'));
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'read_clipboard_image').length).toBe(1);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await flushUi(app);
    await expect(app.getByRole('dialog')).toBeVisible();
    await pasteFile(app.getByTestId('publish-cover-drop'), OTHER_PNG_BYTES, 'late-direct.png', 'image/png');

    await mockState.releaseNextPublishClipboardRead();
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await openPublish(app);
    await waitForPreviewPixels(app);
    const state = await coverMockState(app) as { assets: Record<string, number[]> };
    expect(Object.values(state.assets)).toEqual([Array.from(PNG_BYTES)]);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(1);
  });

  test('Publish waits for initial durable-cover restore before choosing upload bytes', async ({ app, mockState }) => {
    await openPublish(app);
    await dropFile(app.getByTestId('publish-cover-drop'), PNG_BYTES, 'restored.png', 'image/png');
    await waitForPreviewPixels(app);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await mockState.reset();
    await mockState.setPublishCoverLoadBlocked(true);
    await openPublish(app);
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'load_publish_cover').length).toBe(1);
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await flushUi(app);
    let calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'publish_to_ghost')).toHaveLength(0);

    await mockState.releaseNextPublishCoverLoad();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    calls = await mockState.getInvokeCalls();
    const upload = calls.find((call) => call.command === 'upload_post_image_ghost');
    expect(upload?.args.bytes).toEqual(Array.from(PNG_BYTES));
  });

  test('failed Rust clipboard fallback keeps Publish blocked without clearing the prior cover', async ({ app, mockState }) => {
    await openPublish(app);
    await dropFile(app.getByTestId('publish-cover-drop'), PNG_BYTES, 'prior.png', 'image/png');
    await waitForPreviewPixels(app);
    await mockState.reset();
    await mockState.setPublishClipboardImage({ error: 'clipboard unavailable' });

    await pasteEmpty(app.getByTestId('publish-cover-drop'));
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByTestId('publish-cover-error')).toContainText('clipboard unavailable');
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await flushUi(app);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'publish_to_ghost')).toHaveLength(0);
    await waitForPreviewPixels(app);
    const state = await coverMockState(app) as { assets: Record<string, number[]> };
    expect(Object.values(state.assets)).toEqual([Array.from(PNG_BYTES)]);
  });

  test('rename flush waits for the cover tail before retiring the old document identity', async ({ app, mockState }) => {
    await openPublish(app);
    const providerCount = await app.evaluate(async () => {
      const modulePath = '/app/lib/services/rename-coordinator.ts';
      const module = await import(/* @vite-ignore */ modulePath);
      return module.__getRenameFlushProviderCountForTests();
    });
    expect(providerCount).toBeGreaterThan(0);
    await mockState.reset();
    await mockState.setPublishClipboardImage({
      bytes: Array.from(PNG_BYTES),
      mime: 'image/png',
      width: 1,
      height: 1,
    });
    await mockState.setPublishClipboardReadBlocked(true);
    await pasteEmpty(app.getByTestId('publish-cover-drop'));
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'read_clipboard_image').length).toBe(1);

    await app.evaluate((oldPath) => {
      Reflect.set(window, '__TASK17_RENAME_FLUSH_DONE__', false);
      const modulePath = '/app/lib/services/rename-coordinator.ts';
      void import(/* @vite-ignore */ modulePath)
        .then((module) => module.flushRenameSidecars(oldPath))
        .then(() => Reflect.set(window, '__TASK17_RENAME_FLUSH_DONE__', true));
    }, CHAPTER_PATH);
    await flushUi(app);
    expect(await app.evaluate(() => Reflect.get(window, '__TASK17_RENAME_FLUSH_DONE__'))).toBe(false);
    await expect(app.getByRole('dialog')).toBeVisible();

    await mockState.releaseNextPublishClipboardRead();
    await expect.poll(() => app.evaluate(() => Reflect.get(window, '__TASK17_RENAME_FLUSH_DONE__'))).toBe(true);
    await expect(app.getByRole('dialog')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(1);
  });

  test('project switch flush waits for the cover tail before retiring the panel', async ({ app, mockState }) => {
    await openPublish(app);
    await mockState.reset();
    await mockState.setPublishClipboardImage({
      bytes: Array.from(OTHER_PNG_BYTES),
      mime: 'image/png',
      width: 1,
      height: 1,
    });
    await mockState.setPublishClipboardReadBlocked(true);
    await pasteEmpty(app.getByTestId('publish-cover-drop'));
    await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) => call.command === 'read_clipboard_image').length).toBe(1);

    await app.evaluate(([previous, next]) => {
      Reflect.set(window, '__TASK17_PROJECT_FLUSH_DONE__', false);
      const modulePath = '/app/lib/services/project-switch-coordinator.ts';
      void import(/* @vite-ignore */ modulePath)
        .then((module) => module.flushProjectSwitch(previous, next))
        .then(() => Reflect.set(window, '__TASK17_PROJECT_FLUSH_DONE__', true));
    }, [MOCK_PROJECT_DIR, '/tmp/next-project'] as const);
    await flushUi(app);
    expect(await app.evaluate(() => Reflect.get(window, '__TASK17_PROJECT_FLUSH_DONE__'))).toBe(false);
    await expect(app.getByRole('dialog')).toBeVisible();

    await mockState.releaseNextPublishClipboardRead();
    await expect.poll(() => app.evaluate(() => Reflect.get(window, '__TASK17_PROJECT_FLUSH_DONE__'))).toBe(true);
    await expect(app.getByRole('dialog')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(1);
  });

  test('text paste in title, excerpt, slug, and tags is never prevented or routed to cover IPC @task23 @task23-negative', async ({ app, mockState }) => {
    await openPublish(app);
    await mockState.reset();
    for (const selector of ['#pub-title', '#pub-excerpt', '#pub-slug', '#pub-tags']) {
      const prevented = await app.locator(selector).evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', '原生文本 paste');
        const event = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(prevented).toBe(false);
    }
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'read_clipboard_image')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(0);
  });

  test('invalid replacement retains prior pixels and URL; valid replacement and clear revoke exactly once @task23 @task23-negative', async ({ app, mockState }) => {
    await openPublish(app);
    await app.evaluate(() => {
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      const created: string[] = [];
      const revoked: string[] = [];
      Reflect.set(window, '__TASK17_CREATED_URLS__', created);
      Reflect.set(window, '__TASK17_REVOKED_URLS__', revoked);
      URL.createObjectURL = (object) => {
        const url = originalCreate(object);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(String(url));
        originalRevoke(url);
      };
    });
    const tile = app.getByTestId('publish-cover-drop');
    await dropFile(tile, PNG_BYTES, 'valid.png', 'image/png');
    await waitForPreviewPixels(app);
    const firstUrl = await app.getByTestId('publish-cover-preview').getAttribute('src');

    await dropFile(tile, PNG_BYTES, 'mismatch.jpg', 'image/jpeg');
    await expect(app.getByTestId('publish-cover-error')).toContainText('does not match');
    expect(await app.getByTestId('publish-cover-preview').getAttribute('src')).toBe(firstUrl);
    let urls = await app.evaluate(() => ({
      created: Reflect.get(window, '__TASK17_CREATED_URLS__') as string[],
      revoked: Reflect.get(window, '__TASK17_REVOKED_URLS__') as string[],
    }));
    expect(urls.created).toHaveLength(1);
    expect(urls.revoked).toHaveLength(0);
    let state = await coverMockState(app) as { assets: Record<string, number[]> };
    expect(Object.keys(state.assets)).toHaveLength(1);

    await dropFile(tile, new TextEncoder().encode('not an image'), 'invalid.png', 'image/png');
    await expect(app.getByTestId('publish-cover-error')).toContainText('supported image format');
    expect(await app.getByTestId('publish-cover-preview').getAttribute('src')).toBe(firstUrl);

    await dropFile(tile, OTHER_PNG_BYTES, 'replacement.png', 'image/png');
    await waitForPreviewPixels(app);
    const secondUrl = await app.getByTestId('publish-cover-preview').getAttribute('src');
    expect(secondUrl).not.toBe(firstUrl);
    urls = await app.evaluate(() => ({
      created: Reflect.get(window, '__TASK17_CREATED_URLS__') as string[],
      revoked: Reflect.get(window, '__TASK17_REVOKED_URLS__') as string[],
    }));
    expect(urls.revoked).toEqual([firstUrl]);
    state = await coverMockState(app) as { assets: Record<string, number[]> };
    expect(Object.keys(state.assets)).toHaveLength(1);

    await app.getByTestId('publish-cover-remove').click();
    await expect(app.getByTestId('publish-cover-preview')).toHaveCount(0);
    urls = await app.evaluate(() => ({
      created: Reflect.get(window, '__TASK17_CREATED_URLS__') as string[],
      revoked: Reflect.get(window, '__TASK17_REVOKED_URLS__') as string[],
    }));
    expect(urls.revoked).toEqual([firstUrl, secondUrl]);
    state = await coverMockState(app) as { assets: Record<string, number[]> };
    expect(Object.keys(state.assets)).toHaveLength(0);
  });

  test('cancelled picker leaves the durable cover and preview untouched', async ({ app, mockState }) => {
    await openPublish(app);
    await dropFile(app.getByTestId('publish-cover-drop'), PNG_BYTES, 'valid.png', 'image/png');
    await waitForPreviewPixels(app);
    const before = await app.getByTestId('publish-cover-preview').getAttribute('src');
    await mockState.reset();

    const chooserPromise = app.waitForEvent('filechooser');
    await app.getByTestId('publish-cover-choose').click();
    const chooser = await chooserPromise;
    await chooser.setFiles([]);

    expect(await app.getByTestId('publish-cover-preview').getAttribute('src')).toBe(before);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'store_publish_cover')).toHaveLength(0);
    expect(calls.filter((call) => call.command === 'clear_publish_cover')).toHaveLength(0);
  });
});
