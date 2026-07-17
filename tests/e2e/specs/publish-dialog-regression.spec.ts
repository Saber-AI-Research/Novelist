import { test, expect } from '../fixtures/app-fixture';
import type { Page } from '@playwright/test';
import { MOCK_FILE_CONTENTS, MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const GHOST_CHANNEL = {
  id: 'ghost-main',
  name: 'Editorial Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
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

test.describe('[regression] Online Publish dialog behavior', () => {
  test.beforeEach(async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await openChapter(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('restores and flushes its channel draft, stays disk-backed, and preserves progress and success', async ({ app, mockState }) => {
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

    const imageTransfer = await app.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'cover.png', { type: 'image/png' }));
      return transfer;
    });
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
        feature_image_url: 'https://ghost.example/assets/cover.png',
      },
      config: { platform: 'ghost', admin_url: 'https://ghost.example', api_key: 'mock-key' },
    });

    await app.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);
  });

  test('surfaces dispatch errors and closes through the draft flush path', async ({ app, mockState }) => {
    await mockState.setPublishError('Ghost rejected the post');
    await openGhostDialog(app);

    await app.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(app.getByText('Ghost rejected the post')).toBeVisible();
    await expect(app.getByRole('dialog')).toBeVisible();

    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);

    const calls = await mockState.getInvokeCalls();
    expect(calls.some((call) => call.command === 'write_publish_form_draft')).toBe(true);
  });
});
