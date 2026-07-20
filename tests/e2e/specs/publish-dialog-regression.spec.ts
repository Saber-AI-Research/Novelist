import { test, expect } from '../fixtures/app-fixture';
import type { Page } from '@playwright/test';
import { OPAQUE_RED_PNG_BYTES } from '../fixtures/image-data';
import { MOCK_FILE_CONTENTS, MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const GHOST_CHANNEL = {
  id: 'ghost-main',
  name: 'Editorial Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
};

const WORDPRESS_CHANNEL = {
  id: 'wordpress-main',
  name: 'Editorial WordPress',
  platform: 'wordpress_self_hosted' as const,
  site_url: 'https://wordpress.example',
  username: 'mock-editor',
  app_password: 'mock-app-password',
};

async function openChapter(app: Page) {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
}

async function openGhostDialog(app: Page) {
  await app.locator('.share-btn').click();
  await app.getByRole('menuitem', { name: /Publish to Editorial Ghost/ }).click();
  await expect(app.getByRole('dialog')).toBeVisible();
}

async function openChannelDialog(app: Page, channelName: string) {
  await app.locator('.share-btn').click();
  await app.getByRole('menuitem', { name: `Publish to ${channelName}` }).click();
  await expect(app.getByRole('dialog')).toBeVisible();
}

test.describe('[regression] Online Publish dialog behavior', () => {
  test.beforeEach(async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await openChapter(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('restores and flushes its channel draft, stays disk-backed, and preserves progress and success @task23', async ({ app, mockState }) => {
    await mockState.setPublishDrafts({
      [GHOST_CHANNEL.id]: {
        title: 'Restored title',
        tags: ['restored'],
        excerpt: 'Restored excerpt',
        slug: 'restored-title',
        status: 'published',
      },
    });
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nUNSAVED ONLINE MARKER' } });
    });

    await openGhostDialog(app);

    await expect(app.locator('#pub-title')).toHaveValue('Restored title');
    await expect(app.locator('#pub-excerpt')).toHaveValue('Restored excerpt');
    await expect(app.locator('#pub-slug')).toHaveValue('restored-title');
    await expect(app.locator('#pub-status')).toHaveValue('published');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: 'restored' })).toBeVisible();

    await app.locator('#pub-title').fill('');
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Title is required.')).toBeVisible();

    await app.locator('#pub-title').fill('Final title');
    await app.locator('#pub-excerpt').fill('Final excerpt');
    await app.locator('#pub-slug').fill('final-title');
    await app.locator('#pub-status').selectOption('published');
    await app.locator('#pub-tags').fill('release');
    await app.locator('#pub-tags').press('Enter');

    const textTransfer = await app.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['not an image'], 'cover.txt', { type: 'text/plain' }));
      return transfer;
    });
    await app.locator('.cover-drop').dispatchEvent('drop', { dataTransfer: textTransfer });
    await expect(app.locator('.cover-drop img')).toHaveCount(0);

    const imageTransfer = await app.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'cover.png', { type: 'image/png' }));
      return transfer;
    }, Array.from(OPAQUE_RED_PNG_BYTES));
    await app.locator('.cover-drop').dispatchEvent('drop', { dataTransfer: imageTransfer });
    await expect(app.locator('.cover-drop img')).toBeVisible();

    await mockState.setPublishBlocked(true);
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Publishing…' })).toBeDisabled();
    await expect(app.getByTestId('publish-mode-styled')).toBeDisabled();
    await app.locator('.modal-backdrop').click({ position: { x: 8, y: 8 } });
    await expect(app.getByRole('dialog')).toBeVisible();
    await mockState.setPublishBlocked(false);

    await expect(app.getByText('Published successfully.')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Open in browser' })).toBeVisible();

    const calls = await mockState.getInvokeCalls();
    const commandNames = calls.map((call) => call.command);
    const convertIndex = commandNames.lastIndexOf('convert_markdown_to_html');
    const publishIndex = commandNames.lastIndexOf('publish_to_ghost');
    const draftIndices = commandNames.flatMap((command, index) => (
      command === 'write_publish_form_draft' ? [index] : []
    ));
    expect(draftIndices.some((index) => index < convertIndex)).toBe(true);
    expect(publishIndex).toBeGreaterThan(convertIndex);
    expect(draftIndices.some((index) => index > publishIndex)).toBe(true);

    const convertCall = calls[convertIndex];
    expect(convertCall.args.markdown).toBe(MOCK_FILE_CONTENTS[`${MOCK_PROJECT_DIR}/Chapter 1.md`]);
    expect(String(convertCall.args.markdown)).not.toContain('UNSAVED ONLINE MARKER');

    const publishCall = calls[publishIndex];
    expect(publishCall.args).toMatchObject({
      input: {
        title: 'Final title',
        tags: ['restored', 'release'],
        excerpt: 'Final excerpt',
        slug: 'final-title',
        status: 'published',
        body_format: 'html',
      },
      config: { platform: 'ghost', admin_url: 'https://ghost.example', api_key: 'mock-key' },
    });
    expect((publishCall.args.input as { feature_image_url: string }).feature_image_url).toMatch(
      /^https:\/\/ghost\.example\/assets\/[0-9a-f]{64}\.png$/,
    );

    await app.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);
  });

  test('surfaces dispatch errors and closes through the draft flush path', async ({ app, mockState }) => {
    await mockState.setPublishError('Ghost rejected the post');
    await openGhostDialog(app);

    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Publish failed.')).toBeVisible();
    await expect(app.getByRole('dialog')).toBeVisible();

    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);

    const calls = await mockState.getInvokeCalls();
    expect(calls.some((call) => call.command === 'write_publish_form_draft')).toBe(true);
  });

  test('surfaces a post-success form flush failure and retries it on Close @task23 @task23-negative', async ({ app, mockState }) => {
    await openGhostDialog(app);
    await mockState.setPublishBlocked(true);
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Publishing…' })).toBeDisabled();

    await mockState.setPublishDraftWriteError('disk unavailable');
    await mockState.setPublishBlocked(false);
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await expect(app.getByTestId('publish-cover-error')).toContainText('disk unavailable');

    await mockState.setPublishDraftWriteError(null);
    await app.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'write_publish_form_draft').length).toBeGreaterThan(1);
  });

  test('restores channel-specific CJK forms through successful publish and restart', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL, WORDPRESS_CHANNEL]);

    await openGhostDialog(app);
    await app.locator('#pub-title').fill('幽灵标题');
    await app.locator('#pub-excerpt').fill('幽灵摘要');
    await app.locator('#pub-slug').fill('ghost-title');
    await app.locator('#pub-status').selectOption('published');
    await app.locator('#pub-tags').fill('中文标签');
    await app.locator('#pub-tags').press('Enter');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await app.locator('#pub-title').fill('词章标题');
    await app.locator('#pub-excerpt').fill('词章摘要');
    await app.locator('#pub-slug').fill('wordpress-title');
    await app.locator('#pub-status').selectOption('draft');
    await app.locator('#pub-tags').fill('章节标签');
    await app.locator('#pub-tags').press('Enter');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await openChapter(app);
    await openGhostDialog(app);
    await expect(app.locator('#pub-title')).toHaveValue('幽灵标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('幽灵摘要');
    await expect(app.locator('#pub-slug')).toHaveValue('ghost-title');
    await expect(app.locator('#pub-status')).toHaveValue('published');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: '中文标签' })).toBeVisible();
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openGhostDialog(app);
    await expect(app.locator('#pub-title')).toHaveValue('幽灵标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('幽灵摘要');
    await expect(app.locator('#pub-slug')).toHaveValue('ghost-title');
    await expect(app.locator('#pub-status')).toHaveValue('published');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: '中文标签' })).toBeVisible();
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await expect(app.locator('#pub-title')).toHaveValue('词章标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('词章摘要');
    await expect(app.locator('#pub-slug')).toHaveValue('wordpress-title');
    await expect(app.locator('#pub-status')).toHaveValue('draft');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: '章节标签' })).toBeVisible();
    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await expect(app.locator('#pub-title')).toHaveValue('词章标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('词章摘要');
    await expect(app.locator('#pub-slug')).toHaveValue('wordpress-title');
    await expect(app.locator('#pub-status')).toHaveValue('draft');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: '章节标签' })).toBeVisible();
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openGhostDialog(app);
    await expect(app.locator('#pub-title')).toHaveValue('幽灵标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('幽灵摘要');
    await expect(app.locator('#pub-slug')).toHaveValue('ghost-title');
    await expect(app.locator('#pub-status')).toHaveValue('published');
    await expect(app.locator('.tag-pill-selected').filter({ hasText: '中文标签' })).toBeVisible();
    await app.screenshot({ path: '.sisyphus/evidence/task-14-form-restore.png' });
  });

  test('keeps an explicitly cleared slug empty across document, channel, restart, create, and update boundaries @task14', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL, WORDPRESS_CHANNEL]);
    await mockState.setFileContent(
      `${MOCK_PROJECT_DIR}/Chapter 1.md`,
      '# 中文章节\n\n正文。\n',
    );
    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await openChapter(app);

    await openGhostDialog(app);
    await expect(app.locator('#pub-title')).toHaveValue('中文章节');
    await expect(app.locator('#pub-slug')).toHaveValue('post');
    await app.locator('#pub-slug').fill('');
    await app.locator('#pub-title').fill('改题后仍保持空链接');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await expect(app.locator('#pub-slug')).toHaveValue('post');
    await app.locator('#pub-slug').fill('wordpress-owned');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.getByTestId('sidebar-file-Chapter 2.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible' });
    await openGhostDialog(app);
    await expect(app.locator('#pub-slug')).toHaveValue('chapter-2');
    await app.locator('#pub-slug').fill('chapter-two-owned');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.getByTestId('sidebar-file-Chapter 1.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible' });
    await openGhostDialog(app);
    await expect(app.locator('#pub-slug')).toHaveValue('');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });
    await openChapter(app);
    await openGhostDialog(app);
    await expect(app.locator('#pub-slug')).toHaveValue('');

    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openGhostDialog(app);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await expect(app.locator('#pub-slug')).toHaveValue('');
    await app.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openGhostDialog(app);
    await expect(app.locator('#pub-slug')).toHaveValue('');
    await app.screenshot({ path: '.sisyphus/evidence/task-14-cleared-slug.png' });
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await expect(app.locator('#pub-slug')).toHaveValue('wordpress-owned');
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await app.getByTestId('sidebar-file-Chapter 2.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible' });
    await openGhostDialog(app);
    await expect(app.locator('#pub-slug')).toHaveValue('chapter-two-owned');
  });

  test('isolates a corrupt channel draft from a valid sibling channel', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL, WORDPRESS_CHANNEL]);
    await mockState.setPublishDrafts({
      [GHOST_CHANNEL.id]: {
        title: '有效幽灵标题',
        tags: ['安全标签'],
        excerpt: '有效摘要',
        slug: 'valid-ghost',
        status: 'draft',
      },
    });
    await mockState.setPublishDraftInvalidChannelIds([WORDPRESS_CHANNEL.id]);

    await openGhostDialog(app);
    await expect(app.locator('#pub-title')).toHaveValue('有效幽灵标题');
    await expect(app.locator('#pub-excerpt')).toHaveValue('有效摘要');
    await expect(app.getByTestId('publish-draft-recovered')).toHaveCount(0);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();

    await openChannelDialog(app, WORDPRESS_CHANNEL.name);
    await expect(app.locator('#pub-title')).toHaveValue('Chapter 1');
    await expect(app.getByTestId('publish-draft-recovered')).toBeVisible();
    await expect(app.getByRole('dialog')).not.toContainText(WORDPRESS_CHANNEL.app_password);
    await app.screenshot({ path: '.sisyphus/evidence/task-14-corrupt-form.png' });
  });
});
