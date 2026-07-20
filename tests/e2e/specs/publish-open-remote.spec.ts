import { expect, test, type MockInvokeCall } from '../fixtures/app-fixture';
import type { Page } from '@playwright/test';
import type { ChannelConfig, ProviderRevision, RemoteIdentity } from '../../../app/lib/ipc/commands';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const FILE_PATH = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
const GHOST_CHANNEL = {
  id: 'ghost-open-remote',
  name: 'Open Remote Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
};
const WORDPRESS_CHANNEL = {
  id: 'wordpress-open-remote',
  name: 'Open Remote WordPress',
  platform: 'wordpress_self_hosted' as const,
  site_url: 'http://wordpress.local',
  username: 'author',
  app_password: 'mock-password',
};
const WORDPRESS_COM_CHANNEL = {
  id: 'wordpress-com-open-remote',
  name: 'Open Remote WordPress.com',
  platform: 'wordpress_com' as const,
  site_id_or_domain: 'author.wordpress.com',
  access_token: 'mock-token',
};

async function openChapter(app: Page): Promise<void> {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible' });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible' });
}

async function openChannel(app: Page, channelName: string): Promise<void> {
  const menu = app.getByRole('menu');
  const channelItem = menu.getByRole('menuitem', { name: `Publish to ${channelName}` });
  await app.getByTestId('share-menu-pane-1').click();
  await expect(menu).toBeVisible();
  await expect(channelItem).toBeVisible();
  await channelItem.click();
  await expect(app.getByRole('dialog')).toBeVisible();
  await expect(app.getByTestId('publish-state')).toBeVisible();
}

function revisionFor(channel: ChannelConfig): ProviderRevision {
  return channel.platform === 'ghost'
    ? { provider: 'ghost', updated_at: 'revision-1' }
    : { provider: 'wordpress', modified: 'revision-1', modified_gmt: null };
}

function trackedRemote(channel: ChannelConfig, url: string): RemoteIdentity {
  return {
    post_id: 'remote-42',
    url,
    provider_revision: revisionFor(channel),
    capability: { kind: 'updatable' },
  };
}

function shellOpenCalls(calls: MockInvokeCall[]): MockInvokeCall[] {
  return calls.filter((call) => call.command === 'plugin:shell|open');
}

const VALID_CASES: Array<{ label: string; channel: ChannelConfig; url: string }> = [
  {
    label: 'Ghost HTTPS',
    channel: GHOST_CHANNEL,
    url: 'https://ghost.example/第一章/%E4%B8%AD?preview=%2Fchapter#正文',
  },
  {
    label: 'Ghost HTTP',
    channel: GHOST_CHANNEL,
    url: 'http://ghost.internal/第一章/%E4%B8%AD',
  },
  {
    label: 'self-hosted WordPress HTTP',
    channel: WORDPRESS_CHANNEL,
    url: 'http://wordpress.local/wp-admin/post.php?post=42&action=edit',
  },
  {
    label: 'WordPress.com HTTPS',
    channel: WORDPRESS_COM_CHANNEL,
    url: 'https://author.wordpress.com/2026/07/第一章/',
  },
];

const INVALID_PERSISTED_CASES = [
  ['credentials', 'https://author:provider-secret@ghost.example/post/42'],
  ['control character', 'https://ghost.example/post/\n42'],
  ['C1 control character', 'https://ghost.example/post/\u009f42'],
  ['malformed authority', 'https:///ghost.example/post/42'],
  ['raw quote', 'https://ghost.example/post/"%20--proxy-server=attacker.example'],
  ['dot-only host', 'https://./post/42'],
  ['file scheme', 'file:///tmp/provider-result.html'],
  ['JavaScript scheme', 'javascript:alert(1)'],
  ['data scheme', 'data:text/html,provider-result'],
  ['custom scheme', 'novelist://publish/post/42'],
  ['scheme-relative URL', '//ghost.example/post/42'],
  ['POSIX path', '/tmp/provider-result.html'],
  ['Windows path', 'C:\\Users\\author\\provider-result.html'],
] as const;

const INVALID_PROVIDER_CASES = [
  ['credentials', 'https://author:provider-result-secret@ghost.example/post/created'],
  ['raw quote', 'https://ghost.example/post/"%20--proxy-server=attacker.example'],
  ['C1 control', 'https://ghost.example/post/\u009fcreated'],
] as const;

test.describe('[regression] Publish Open Remote shell boundary', () => {
  test.beforeEach(async ({ app }) => {
    await openChapter(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  for (const { label, channel, url } of VALID_CASES) {
    test(`opens one exact ${label} URL @task23`, async ({ app, mockState }) => {
      await mockState.setPublishChannels([channel]);
      await mockState.setPublishRemote({
        projectDir: MOCK_PROJECT_DIR,
        filePath: FILE_PATH,
        channelId: channel.id,
        remote: trackedRemote(channel, url),
      });
      await openChannel(app, channel.name);

      await app.getByTestId('publish-open-remote').click();

      await expect.poll(async () => shellOpenCalls(await mockState.getInvokeCalls())).toHaveLength(1);
      expect(shellOpenCalls(await mockState.getInvokeCalls())).toEqual([
        { command: 'plugin:shell|open', args: { path: url } },
      ]);
    });
  }

  test('opens the rebound URL instead of a stale publish-success URL @task23', async ({ app, mockState }) => {
    const publishedUrl = 'https://ghost.example/published-a/';
    const reboundUrl = 'https://ghost.example/rebound-b/';
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishResponses([{ result: {
      url: publishedUrl,
      remote_id: 'published-a',
      operation: 'created',
      provider_revision: { provider: 'ghost', updated_at: 'published-revision' },
    } }]);
    await openChannel(app, GHOST_CHANNEL.name);

    await app.getByTestId('publish-submit').click();
    await expect(app.getByText('Published successfully.')).toBeVisible();
    await app.getByTestId('publish-rebind').click();
    await app.getByTestId('publish-bind-input').fill(reboundUrl);
    await app.getByTestId('publish-bind-confirm').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');

    await app.getByTestId('publish-open-remote').click();

    await expect.poll(async () => shellOpenCalls(await mockState.getInvokeCalls())).toHaveLength(1);
    expect(shellOpenCalls(await mockState.getInvokeCalls())).toEqual([
      { command: 'plugin:shell|open', args: { path: reboundUrl } },
    ]);
  });

  test('failed Rebind preserves the current remote target and lifecycle @task23 @task23-negative', async ({ app, mockState }) => {
    const publishedUrl = 'https://ghost.example/published-a/';
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishResponses([{ result: {
      url: publishedUrl,
      remote_id: 'published-a',
      operation: 'created',
      provider_revision: { provider: 'ghost', updated_at: 'published-revision' },
    } }]);
    await mockState.setPublishBindError(JSON.stringify({
      kind: 'remote_not_found',
      data: { provider: 'ghost', remote_id: 'missing-b' },
    }));
    await openChannel(app, GHOST_CHANNEL.name);

    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    await app.getByTestId('publish-rebind').click();
    await app.getByTestId('publish-bind-input').fill('missing-b');
    await app.getByTestId('publish-bind-confirm').click();

    await expect(app.getByTestId('publish-bind-form')).toBeVisible();
    await expect(app.getByTestId('publish-bind-error')).toHaveText('Could not bind the remote post.');
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    await app.getByTestId('publish-open-remote').click();
    expect(shellOpenCalls(await mockState.getInvokeCalls())).toEqual([
      { command: 'plugin:shell|open', args: { path: publishedUrl } },
    ]);
  });

  test('keeps the current share menu mounted while publish channels refresh @task23 @task23-negative', async ({ app, mockState }) => {
    const rejectedUrl = 'https://ghost.example/post/"%20--proxy-server=attacker.example';
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: GHOST_CHANNEL.id,
      remote: trackedRemote(GHOST_CHANNEL, rejectedUrl),
    });
    await mockState.deferNextPublishSettingsRead();

    const trigger = app.getByTestId('share-menu-pane-1');
    const menu = app.getByRole('menu');
    const channelItem = menu.getByRole('menuitem', { name: `Publish to ${GHOST_CHANNEL.name}` });
    await trigger.click();

    await expect(menu).toBeVisible();
    await mockState.releaseNextPublishSettingsRead();
    await expect(channelItem).toBeVisible();
    await channelItem.click();
    await expect(app.getByTestId('publish-state')).toBeVisible();

    await app.getByTestId('publish-open-remote').click();

    await expect(app.getByTestId('publish-open-remote-error')).toHaveText(
      'The saved Publish URL is invalid and was not opened.',
    );
    expect(shellOpenCalls(await mockState.getInvokeCalls())).toEqual([]);
  });

  for (const [label, url] of INVALID_PERSISTED_CASES) {
    test(`rejects a persisted ${label} with bounded sanitized feedback and zero shell opens @task23 @task23-negative`, async ({ app, mockState }) => {
      await mockState.setPublishChannels([GHOST_CHANNEL]);
      await mockState.setPublishRemote({
        projectDir: MOCK_PROJECT_DIR,
        filePath: FILE_PATH,
        channelId: GHOST_CHANNEL.id,
        remote: trackedRemote(GHOST_CHANNEL, url),
      });
      await openChannel(app, GHOST_CHANNEL.name);

      await app.getByTestId('publish-open-remote').click();

      const feedback = app.getByTestId('publish-open-remote-error');
      await expect(feedback, label).toHaveText('The saved Publish URL is invalid and was not opened.');
      expect((await feedback.textContent())?.length, label).toBeLessThanOrEqual(80);
      await expect(app.getByText(/provider-secret/), label).toHaveCount(0);
      expect(shellOpenCalls(await mockState.getInvokeCalls()), label).toHaveLength(0);
    });
  }

  test('rejects HTTP for WordPress.com with zero shell opens @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([WORDPRESS_COM_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: WORDPRESS_COM_CHANNEL.id,
      remote: trackedRemote(WORDPRESS_COM_CHANNEL, 'http://author.wordpress.com/post/42'),
    });
    await openChannel(app, WORDPRESS_COM_CHANNEL.name);

    await app.getByTestId('publish-open-remote').click();

    await expect(app.getByTestId('publish-open-remote-error')).toBeVisible();
    expect(shellOpenCalls(await mockState.getInvokeCalls())).toHaveLength(0);
  });

  for (const [label, rejectedUrl] of INVALID_PROVIDER_CASES) {
    test(`rejects a provider-result ${label} without leaking or opening it @task23 @task23-negative`, async ({ app, mockState }) => {
      await mockState.setPublishChannels([GHOST_CHANNEL]);
      await mockState.setPublishResponses([{ result: {
        url: rejectedUrl,
        remote_id: 'created-id',
        operation: 'created',
        provider_revision: { provider: 'ghost', updated_at: 'created-revision' },
      } }]);
      await openChannel(app, GHOST_CHANNEL.name);
      await expect(app.getByTestId('publish-state')).toHaveText('New');

      await app.getByTestId('publish-submit').click();
      await expect(app.getByText('Published successfully.')).toBeVisible();
      await app.getByRole('button', { name: 'Open in browser', exact: true }).click();

      await expect(app.getByTestId('publish-open-remote-error')).toHaveText(
        'The saved Publish URL is invalid and was not opened.',
      );
      await expect(app.getByText(/provider-result-secret/)).toHaveCount(0);
      expect(shellOpenCalls(await mockState.getInvokeCalls())).toHaveLength(0);
    });
  }
});
