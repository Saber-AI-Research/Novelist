import { test, expect } from '../fixtures/app-fixture';
import type { Locator, Page } from '@playwright/test';
import { OPAQUE_RED_PNG_BYTES, SECOND_OPAQUE_RED_PNG_BYTES } from '../fixtures/image-data';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const FILE_PATH = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
const GHOST_CHANNEL = {
  id: 'ghost-main',
  name: 'Editorial Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
};
const GHOST_SECONDARY_CHANNEL = {
  ...GHOST_CHANNEL,
  id: 'ghost-secondary',
  name: 'Secondary Ghost',
};
const MEDIUM_CHANNEL = {
  id: 'medium-main',
  name: 'Author Medium',
  platform: 'medium' as const,
  token: 'mock-token',
};
const WORDPRESS_CHANNEL = {
  id: 'wordpress-main',
  name: 'Editorial WordPress',
  platform: 'wordpress_self_hosted' as const,
  site_url: 'https://wordpress.example',
  username: 'editor',
  app_password: 'mock-password',
};

async function openChapter(app: Page) {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible' });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible' });
}

async function openChannel(app: Page, channelName: string) {
  await app.locator('.share-btn').click();
  await app.getByRole('menuitem', { name: new RegExp(`Publish to ${channelName}`) }).click();
  await expect(app.getByRole('dialog')).toBeVisible();
  await expect(app.getByTestId('publish-state')).toBeVisible();
}

async function dropCover(target: Locator, bytes: Uint8Array, name: string) {
  await target.evaluate((element, input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(input.bytes)], input.name, {
      type: 'image/png',
    }));
    element.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  }, { bytes: Array.from(bytes), name });
}

test.describe('[publish-update] durable lifecycle and recovery', () => {
  test.beforeEach(async ({ app }) => {
    await openChapter(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('creates once, reopens as Updating, and updates the same remote ID @task23', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('New');
    await app.locator('#pub-title').fill('Durable title');
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await expect(app.locator('#pub-title')).toHaveValue('Durable title');
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');

    const calls = await mockState.getInvokeCalls();
    const publishes = calls.filter(call => call.command === 'publish_to_ghost');
    expect(publishes).toHaveLength(2);
    expect((publishes[0].args.input as any).update_target).toBeUndefined();
    expect((publishes[1].args.input as any).update_target).toEqual({
      remote_id: 'ghost-1',
      expected_revision: { provider: 'ghost', updated_at: 'revision-1' },
    });
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(2);
    await app.screenshot({
      path: '.sisyphus/evidence/task-21-create-update.png',
      fullPage: true,
    });
  });

  test('WordPress verifies before uploads, reuses an unchanged restored cover, and uploads a changed cover once on retry @task19 @task23', async ({ app, mockState }) => {
    await mockState.setPublishChannels([WORDPRESS_CHANNEL]);
    await openChannel(app, WORDPRESS_CHANNEL.name);
    await dropCover(app.getByTestId('publish-cover-drop'), OPAQUE_RED_PNG_BYTES, '初始封面.png');
    await expect(app.getByTestId('publish-cover-preview')).toBeVisible();
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');

    let calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'verify_wordpress_self_hosted_update')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'upload_post_image_wordpress_self_hosted')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'publish_to_wordpress_self_hosted')).toHaveLength(1);
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openChannel(app, WORDPRESS_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await expect(app.getByTestId('publish-cover-preview')).toBeVisible();
    await mockState.reset();
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');

    calls = await mockState.getInvokeCalls();
    const unchangedAttempt = calls.filter(call => [
      'verify_wordpress_self_hosted_update',
      'upload_post_image_wordpress_self_hosted',
      'publish_to_wordpress_self_hosted',
      'persist_publish_result',
    ].includes(call.command));
    expect(unchangedAttempt.map(call => call.command)).toEqual([
      'verify_wordpress_self_hosted_update',
      'publish_to_wordpress_self_hosted',
      'persist_publish_result',
    ]);
    expect((unchangedAttempt[1].args.input as any).featured_media_id).toBeUndefined();
    await app.getByRole('button', { name: 'Close', exact: true }).click();

    await openChannel(app, WORDPRESS_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await dropCover(
      app.getByTestId('publish-cover-drop'),
      SECOND_OPAQUE_RED_PNG_BYTES,
      '重写封面.png',
    );
    await expect(app.getByTestId('publish-cover-preview')).toBeVisible();
    await mockState.reset();
    await mockState.setPublishVerifyResponses([{
      error: JSON.stringify({
        kind: 'update_conflict',
        data: {
          provider: 'wordpress',
          remote_id: 'wordpress_self_hosted-1',
          actual: {
            provider: 'wordpress',
            modified: 'authoritative-revision',
            modified_gmt: null,
          },
        },
      }),
    }]);

    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-conflict')).toBeVisible();
    calls = await mockState.getInvokeCalls();
    let recoveryAttempt = calls.filter(call => [
      'verify_wordpress_self_hosted_update',
      'upload_post_image_wordpress_self_hosted',
      'publish_to_wordpress_self_hosted',
      'persist_publish_result',
    ].includes(call.command));
    expect(recoveryAttempt.map(call => call.command)).toEqual([
      'verify_wordpress_self_hosted_update',
    ]);

    await app.getByTestId('publish-overwrite').click();
    await app.getByTestId('publish-confirm-action').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    calls = await mockState.getInvokeCalls();
    recoveryAttempt = calls.filter(call => [
      'verify_wordpress_self_hosted_update',
      'upload_post_image_wordpress_self_hosted',
      'publish_to_wordpress_self_hosted',
      'persist_publish_result',
    ].includes(call.command));
    expect(recoveryAttempt.map(call => call.command)).toEqual([
      'verify_wordpress_self_hosted_update',
      'verify_wordpress_self_hosted_update',
      'upload_post_image_wordpress_self_hosted',
      'publish_to_wordpress_self_hosted',
      'persist_publish_result',
    ]);
    expect(calls.filter(call => call.command === 'upload_post_image_wordpress_self_hosted')).toHaveLength(1);
    const upload = calls.find(call => call.command === 'upload_post_image_wordpress_self_hosted');
    expect(upload?.args.bytes).toEqual(Array.from(SECOND_OPAQUE_RED_PNG_BYTES));
    await app.screenshot({
      path: '.sisyphus/evidence/task-19-cover-ordering.png',
      fullPage: true,
    });
  });

  test('transient remote-state failure blocks provider and persistence calls until retry succeeds @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: GHOST_CHANNEL.id,
      remote: {
        post_id: 'existing-id',
        url: 'https://ghost.example/existing-id/',
        provider_revision: { provider: 'ghost', updated_at: 'existing-revision' },
        capability: { kind: 'updatable' },
      },
    });
    await mockState.deferNextPublishRemoteRead();

    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Checking');
    await expect(app.getByTestId('publish-submit')).toBeDisabled();
    await expect.poll(async () => (
      (await mockState.getInvokeCalls()).filter(call => call.command === 'read_publish_remote_state').length
    )).toBe(1);

    const assertNoPublishSideEffects = async () => {
      const calls = await mockState.getInvokeCalls();
      for (const command of [
        'list_publish_tags',
        'convert_markdown_to_html',
        'upload_post_image_ghost',
        'publish_to_ghost',
        'persist_publish_result',
        'write_publish_form_draft',
      ]) {
        expect(calls.filter(call => call.command === command), command).toHaveLength(0);
      }
    };
    await assertNoPublishSideEffects();

    await mockState.rejectNextPublishRemoteRead('Bearer secret-provider-token');
    await expect(app.getByTestId('publish-state')).toHaveText('Unavailable');
    await expect(app.getByTestId('publish-remote-uncertain')).toContainText(
      'Remote publish state could not be verified. Publishing is blocked.',
    );
    await expect(app.getByText(/secret-provider-token/)).toHaveCount(0);
    await expect(app.getByTestId('publish-submit')).toBeDisabled();
    await assertNoPublishSideEffects();

    await app.getByTestId('publish-remote-retry').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await expect(app.getByTestId('publish-submit')).toBeEnabled();
    let calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(0);

    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    calls = await mockState.getInvokeCalls();
    const publishes = calls.filter(call => call.command === 'publish_to_ghost');
    expect(publishes).toHaveLength(1);
    expect((publishes[0].args.input as any).update_target).toEqual({
      remote_id: 'existing-id',
      expected_revision: { provider: 'ghost', updated_at: 'existing-revision' },
    });
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(1);
  });

  test('provider success with identity persistence failure retries persistence without creating again @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishPersistError('Bearer secret-persistence-token');
    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('New');

    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Unavailable');
    await expect(app.getByTestId('publish-remote-uncertain')).toBeVisible();
    await expect(app.getByText(/secret-persistence-token/)).toHaveCount(0);
    await expect(app.getByTestId('publish-submit')).toBeDisabled();

    let calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'read_publish_remote_state')).toHaveLength(1);

    await mockState.setPublishPersistError(null);
    await app.getByTestId('publish-remote-retry').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    await expect(app.getByText('Published successfully.')).toBeVisible();
    calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(2);
    expect(calls.filter(call => call.command === 'read_publish_remote_state')).toHaveLength(1);
  });

  test('pending identity recovery vetoes rename and project-switch retirement @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishPersistError('Bearer secret-persistence-token');
    await openChannel(app, GHOST_CHANNEL.name);

    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Unavailable');

    const outcomes = await app.evaluate(async ({ filePath, projectDir }) => {
      const renameModulePath = '/app/lib/services/rename-coordinator.ts';
      const projectModulePath = '/app/lib/services/project-switch-coordinator.ts';
      const [rename, project] = await Promise.all([
        import(/* @vite-ignore */ renameModulePath),
        import(/* @vite-ignore */ projectModulePath),
      ]);
      const results = await Promise.allSettled([
        rename.flushRenameSidecars(filePath),
        project.flushProjectSwitch(projectDir, '/tmp/next-project'),
        project.flushProjectSwitch(null, projectDir),
      ]);
      return results.map(result => result.status);
    }, { filePath: FILE_PATH, projectDir: MOCK_PROJECT_DIR });

    expect(outcomes).toEqual(['rejected', 'rejected', 'rejected']);
    await expect(app.getByRole('dialog')).toBeVisible();
    let calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(1);

    await mockState.reset();
    await app.keyboard.press('Meta+2');
    await app.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'stop_file_watcher')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'detect_project')).toHaveLength(0);
    await expect(app.getByRole('dialog')).toBeVisible();

    await mockState.setPublishPersistError(null);
    await app.getByTestId('publish-remote-retry').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(1);
  });

  test('in-flight identity persistence vetoes rename and project-switch retirement @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishPersistBlocked(true);
    await openChannel(app, GHOST_CHANNEL.name);

    await app.getByTestId('publish-submit').click();
    await expect.poll(async () => (
      (await mockState.getInvokeCalls()).filter(call => call.command === 'persist_publish_result').length
    )).toBe(1);

    const outcomes = await app.evaluate(async ({ filePath, projectDir }) => {
      const renamePath = '/app/lib/services/rename-coordinator.ts';
      const projectPath = '/app/lib/services/project-switch-coordinator.ts';
      const [rename, project] = await Promise.all([
        import(/* @vite-ignore */ renamePath),
        import(/* @vite-ignore */ projectPath),
      ]);
      const results = await Promise.allSettled([
        rename.flushRenameSidecars(filePath),
        project.flushProjectSwitch(projectDir, '/tmp/next-project'),
      ]);
      return results.map(result => result.status);
    }, { filePath: FILE_PATH, projectDir: MOCK_PROJECT_DIR });

    expect(outcomes).toEqual(['rejected', 'rejected']);
    await expect(app.getByRole('dialog')).toBeVisible();
    await mockState.setPublishPersistError('Bearer secret-persistence-token');
    await mockState.setPublishPersistBlocked(false);
    await expect(app.getByTestId('publish-state')).toHaveText('Unavailable');

    await mockState.setPublishPersistError(null);
    await app.getByTestId('publish-remote-retry').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(2);
  });

  test('in-flight binding vetoes rename and project-switch retirement @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishBindBlocked(true);
    await openChannel(app, GHOST_CHANNEL.name);
    await app.getByTestId('publish-attach-existing').click();
    await app.getByTestId('publish-bind-input').fill('bound-id');
    await app.getByTestId('publish-bind-confirm').click();
    await expect.poll(async () => (
      (await mockState.getInvokeCalls()).filter(call => call.command === 'bind_legacy_publication').length
    )).toBe(1);

    const outcomes = await app.evaluate(async ({ filePath, projectDir }) => {
      const renamePath = '/app/lib/services/rename-coordinator.ts';
      const projectPath = '/app/lib/services/project-switch-coordinator.ts';
      const [rename, project] = await Promise.all([
        import(/* @vite-ignore */ renamePath),
        import(/* @vite-ignore */ projectPath),
      ]);
      const results = await Promise.allSettled([
        rename.flushRenameSidecars(filePath),
        project.flushProjectSwitch(projectDir, '/tmp/next-project'),
      ]);
      return results.map(result => result.status);
    }, { filePath: FILE_PATH, projectDir: MOCK_PROJECT_DIR });

    expect(outcomes).toEqual(['rejected', 'rejected']);
    await expect(app.getByRole('dialog')).toBeVisible();
    await mockState.setPublishBindBlocked(false);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'bind_legacy_publication')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
  });

  test('remote-state resolution during exit starts no tag provider request @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishCoverLoadBlocked(true);
    await mockState.deferNextPublishRemoteRead();
    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Checking');

    await app.getByRole('button', { name: 'Cancel', exact: true }).click({ noWaitAfter: true });
    await mockState.releaseNextPublishRemoteRead();
    await expect.poll(async () => (
      (await mockState.getInvokeCalls()).filter(call => call.command === 'list_publish_tags').length
    )).toBe(0);

    await mockState.releaseNextPublishCoverLoad();
    await expect(app.getByRole('dialog')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'list_publish_tags')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(0);
  });

  test('late rejected read from an old document and channel cannot contaminate the new owner @task23 @task23-negative', async ({ app, mockState }) => {
    const chapterTwo = `${MOCK_PROJECT_DIR}/Chapter 2.md`;
    await mockState.setPublishChannels([GHOST_CHANNEL, GHOST_SECONDARY_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: chapterTwo,
      channelId: GHOST_SECONDARY_CHANNEL.id,
      remote: {
        post_id: 'secondary-id',
        url: 'https://ghost.example/secondary-id/',
        provider_revision: { provider: 'ghost', updated_at: 'secondary-revision' },
        capability: { kind: 'updatable' },
      },
    });
    await mockState.deferNextPublishRemoteRead();

    await openChannel(app, GHOST_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Checking');
    await app.locator('#pub-title').fill('Must remain memory-only');
    await expect.poll(async () => (
      (await mockState.getInvokeCalls()).filter(call => call.command === 'read_publish_remote_state').length
    )).toBe(1);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(app.getByRole('dialog')).toHaveCount(0);
    expect(
      (await mockState.getInvokeCalls()).filter(call => call.command === 'write_publish_form_draft'),
    ).toHaveLength(0);

    await app.getByTestId('sidebar-file-Chapter 2.md').click();
    await app.locator('.cm-editor').waitFor({ state: 'visible' });
    await openChannel(app, GHOST_SECONDARY_CHANNEL.name);
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');

    await mockState.rejectNextPublishRemoteRead('stale first-owner failure');
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    await expect(app.getByTestId('publish-remote-uncertain')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(0);
  });

  test('conflict sends no automatic retry and confirmed overwrite uses authoritative revision @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: GHOST_CHANNEL.id,
      remote: {
        post_id: 'g1',
        url: 'https://ghost.example/g1/',
        provider_revision: { provider: 'ghost', updated_at: 'old' },
        capability: { kind: 'updatable' },
      },
    });
    await mockState.setPublishResponses([
      {
        error: JSON.stringify({
          kind: 'update_conflict',
          data: {
            provider: 'ghost',
            remote_id: 'g1',
            actual: { provider: 'ghost', updated_at: 'authoritative' },
          },
        }),
      },
      {
        result: {
          url: 'https://ghost.example/g1/',
          remote_id: 'g1',
          operation: 'updated',
          provider_revision: { provider: 'ghost', updated_at: 'after-overwrite' },
        },
      },
    ]);
    await openChannel(app, GHOST_CHANNEL.name);
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-conflict')).toBeVisible();
    await expect(app.getByTestId('publish-open-remote')).toBeVisible();
    expect(Object.values(await mockState.getPublishRemotes())).toContainEqual(expect.objectContaining({
      post_id: 'g1',
      url: 'https://ghost.example/g1/',
    }));
    let calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);
    expect(calls.filter(call => call.command === 'persist_publish_result')).toHaveLength(0);
    await app.screenshot({
      path: '.sisyphus/evidence/task-21-conflict.png',
      fullPage: true,
    });

    await app.getByTestId('publish-overwrite').click();
    await expect(app.getByTestId('publish-confirmation')).toBeVisible();
    await app.getByTestId('publish-confirm-action').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    calls = await mockState.getInvokeCalls();
    const publishes = calls.filter(call => call.command === 'publish_to_ghost');
    expect(publishes).toHaveLength(2);
    expect((publishes[1].args.input as any).update_target.expected_revision).toEqual({
      provider: 'ghost',
      updated_at: 'authoritative',
    });
  });

  test('404 requires explicit New Copy and failed create retains old identity @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: GHOST_CHANNEL.id,
      remote: {
        post_id: 'deleted-id',
        url: 'https://ghost.example/deleted-id/',
        provider_revision: { provider: 'ghost', updated_at: 'old' },
        capability: { kind: 'updatable' },
      },
    });
    await mockState.setPublishResponses([
      {
        error: JSON.stringify({
          kind: 'remote_not_found',
          data: { provider: 'ghost', remote_id: 'deleted-id' },
        }),
      },
      { error: 'temporary provider failure' },
      {
        result: {
          url: 'https://ghost.example/new-copy/',
          remote_id: 'new-copy',
          operation: 'created',
          provider_revision: { provider: 'ghost', updated_at: 'new-revision' },
        },
      },
    ]);
    await openChannel(app, GHOST_CHANNEL.name);
    await app.getByTestId('publish-submit').click();
    await expect(app.getByTestId('publish-not-found')).toBeVisible();
    expect((await mockState.getInvokeCalls()).filter(call => call.command === 'publish_to_ghost')).toHaveLength(1);

    await app.getByTestId('publish-new-copy').click();
    await app.getByTestId('publish-confirm-action').click();
    await expect(app.getByText('Publish failed.')).toBeVisible();
    expect(JSON.stringify(await mockState.getPublishRemotes())).toContain('deleted-id');

    await app.getByTestId('publish-new-copy').click();
    await app.getByTestId('publish-confirm-action').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    const remotes = await mockState.getPublishRemotes();
    expect(JSON.stringify(remotes)).toContain('new-copy');
    expect(JSON.stringify(remotes)).not.toContain('deleted-id');
  });

  test('binds and rebinds verified Ghost identity without publishing @task23', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await openChannel(app, GHOST_CHANNEL.name);
    await app.getByTestId('publish-attach-existing').click();
    await app.getByTestId('publish-bind-input').fill('legacy-id');
    await app.getByTestId('publish-bind-confirm').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');

    await app.getByTestId('publish-rebind').click();
    await app.getByTestId('publish-bind-input').fill('replacement-id');
    await app.getByTestId('publish-bind-confirm').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updating');
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'bind_legacy_publication')).toHaveLength(2);
    expect(calls.filter(call => call.command === 'publish_to_ghost')).toHaveLength(0);
    expect(JSON.stringify(await mockState.getPublishRemotes())).toContain('replacement-id');
  });

  test('tracked Medium sends no default request and only confirmed New Copy creates @task23 @task23-negative', async ({ app, mockState }) => {
    await mockState.setPublishChannels([MEDIUM_CHANNEL]);
    await mockState.setPublishRemote({
      projectDir: MOCK_PROJECT_DIR,
      filePath: FILE_PATH,
      channelId: MEDIUM_CHANNEL.id,
      remote: {
        post_id: 'medium-old',
        url: 'https://medium.com/@author/medium-old',
        capability: {
          kind: 'unsupported_update',
          data: { reason: 'create_only_api' },
        },
      },
    });
    await openChannel(app, MEDIUM_CHANNEL.name);
    await expect(app.getByTestId('publish-unsupported')).toBeVisible();
    await expect(app.getByTestId('publish-open-remote')).toBeVisible();
    await expect(app.getByTestId('publish-medium-cover-note')).toBeVisible();
    expect((await mockState.getInvokeCalls()).filter(call => call.command === 'publish_to_medium')).toHaveLength(0);
    await app.screenshot({
      path: '.sisyphus/evidence/task-21-conflict-medium.png',
      fullPage: true,
    });

    await app.getByTestId('publish-new-copy').click();
    await app.getByTestId('publish-confirm-action').click();
    await expect(app.getByTestId('publish-state')).toHaveText('Updated');
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'publish_to_medium')).toHaveLength(1);
    expect((calls.find(call => call.command === 'publish_to_medium')?.args.input as any).update_target).toBeUndefined();
    expect(calls.filter(call => call.command === 'upload_post_image_medium')).toHaveLength(0);
  });
});
