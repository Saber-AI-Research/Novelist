import type { Page } from '@playwright/test';
import { test, expect, openRecentProject } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const ENDPOINT = 'https://dav.example.com/files/writer/';

async function openSyncSettings(page: Page) {
  await page.evaluate(() => {
    const api: unknown = Reflect.get(window, '__test_api__');
    if (!api || typeof api !== 'object' || !('toggleSettings' in api) || typeof api.toggleSettings !== 'function') throw new Error('App test API unavailable');
    api.toggleSettings();
  });
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-section-sync').click();
  await expect(page.getByTestId('cloud-account-panel')).toBeVisible();
}

async function savedSyncConfig(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((project) => {
    const configs = JSON.parse(localStorage.getItem('__novelist_mock_sync_configs__') ?? '{}');
    return configs[project] ?? null;
  }, MOCK_PROJECT_DIR);
}

async function fillConnection(page: Page) {
  await page.getByTestId('cloud-endpoint').fill(ENDPOINT);
  await page.getByTestId('cloud-username').fill('writer');
  await page.getByTestId('cloud-password').fill('device-app-password');
}

const modes = [
  { name: 'default application directory', directory: 'Novelist', folder: `${ENDPOINT}Novelist/`, mode: 'Novelist (default)' },
  { name: 'custom nested Unicode directory', directory: '写作/My Drafts', folder: `${ENDPOINT}%E5%86%99%E4%BD%9C/My%20Drafts/`, mode: 'custom directory' },
  { name: 'explicit endpoint folder', directory: '', folder: ENDPOINT, mode: 'endpoint folder (legacy layout)' },
];

test.describe('[contract] Optional WebDAV application directory', () => {
  for (const choice of modes) {
    test(`persists a connection using ${choice.name} without linking a project`, async ({ app, mockState }) => {
      await openSyncSettings(app);
      await expect(app.getByTestId('cloud-remote-directory')).toHaveValue('Novelist');
      await expect(app.getByTestId('cloud-use-endpoint-folder')).not.toBeChecked();
      await fillConnection(app);
      if (choice.directory === '') await app.getByTestId('cloud-use-endpoint-folder').check();
      else await app.getByTestId('cloud-remote-directory').fill(choice.directory);
      await expect(app.getByTestId('cloud-directory-preview')).toContainText(choice.mode);
      await expect(app.getByTestId('cloud-directory-preview')).toContainText(choice.folder);
      await app.getByTestId('cloud-connect').click();
      await expect(app.getByTestId('cloud-account-folder')).toContainText(choice.folder);
      await expect(app.getByTestId('cloud-account-folder')).toContainText(choice.mode);
      expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'connect_cloud_account').at(-1)?.args.remoteDirectory).toBe(choice.directory);
      expect((await mockState.getInvokeCalls()).filter((call) => ['bind_cloud_project', 'sync_now'].includes(call.command))).toEqual([]);

      await app.reload();
      await app.waitForSelector('#app > *');
      await openSyncSettings(app);
      await expect(app.getByTestId('cloud-account-folder')).toContainText(choice.folder);
      await expect(app.getByTestId('cloud-account-folder')).toContainText(choice.mode);
      await expect(app.getByTestId('cloud-connection-state')).toHaveText('Connected');
    });
  }

  test('saves manual choices offline, rejects invalid or accidental blank directories, and preserves the explicit root', async ({ app, mockState }) => {
    await openRecentProject(app);
    await openSyncSettings(app);
    await expect(app.getByTestId('sync-remote-directory')).toHaveValue('Novelist');
    await expect(app.getByTestId('sync-use-endpoint-folder')).not.toBeChecked();
    await app.locator('#sync-webdav-url').fill(ENDPOINT);
    await app.locator('#sync-webdav-url').blur();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('Novelist');
    await expect(app.locator('#sync-enabled')).toHaveAttribute('aria-checked', 'false');

    await app.getByTestId('sync-remote-directory').fill('写作/My Drafts');
    await app.getByTestId('sync-remote-directory').blur();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('写作/My Drafts');
    await expect(app.getByTestId('sync-final-path')).toContainText(`${ENDPOINT}%E5%86%99%E4%BD%9C/My%20Drafts/novelist-sync/<project-id>/`);
    expect((await savedSyncConfig(app))?.enabled).toBe(false);
    expect((await mockState.getInvokeCalls()).filter((call) => ['connect_cloud_account', 'test_sync_connection', 'bind_cloud_project', 'sync_now'].includes(call.command))).toEqual([]);

    await app.reload();
    await app.waitForSelector('#app > *');
    await openRecentProject(app);
    await openSyncSettings(app);
    await expect(app.getByTestId('sync-remote-directory')).toHaveValue('写作/My Drafts');
    const saves = (await mockState.getInvokeCalls()).filter((call) => call.command === 'save_sync_config').length;
    for (const invalid of ['../escape', '']) {
      await app.getByTestId('sync-remote-directory').fill(invalid);
      await app.getByTestId('sync-remote-directory').blur();
      await expect(app.getByTestId('sync-config-error')).toContainText('Enter a relative directory');
      await expect(app.getByTestId('sync-use-endpoint-folder')).not.toBeChecked();
      expect((await savedSyncConfig(app))?.remote_directory).toBe('写作/My Drafts');
    }
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'save_sync_config')).toHaveLength(saves);

    await app.evaluate(() => {
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (!internals || typeof internals !== 'object' || !('invoke' in internals) || typeof internals.invoke !== 'function') throw new Error('Tauri mock unavailable');
      const original = internals.invoke.bind(internals);
      let rejectSave = true;
      internals.invoke = async (command: string, args: Record<string, unknown>) => {
        if (command === 'save_sync_config' && rejectSave) {
          rejectSave = false;
          throw 'untrusted native error containing device-app-password';
        }
        return original(command, args);
      };
    });
    await app.getByTestId('sync-remote-directory').fill('Other folder');
    await app.getByTestId('sync-remote-directory').blur();
    await expect(app.getByTestId('sync-config-error')).toContainText('Could not save');
    await expect(app.getByTestId('settings-dialog')).not.toContainText('device-app-password');
    expect((await savedSyncConfig(app))?.remote_directory).toBe('写作/My Drafts');

    await app.getByTestId('sync-use-endpoint-folder').check();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('');
    await expect(app.getByTestId('sync-config-error')).toHaveCount(0);
    await expect(app.getByTestId('sync-directory-mode')).toContainText('endpoint folder (legacy layout)');
    await expect(app.getByTestId('sync-final-path')).toContainText(`${ENDPOINT}novelist-sync/<project-id>/`);
    expect((await savedSyncConfig(app))?.enabled).toBe(false);
    await app.reload();
    await app.waitForSelector('#app > *');
    await openRecentProject(app);
    await openSyncSettings(app);
    await expect(app.getByTestId('sync-use-endpoint-folder')).toBeChecked();
    await expect(app.getByTestId('sync-remote-directory')).toBeDisabled();
    await expect(app.getByTestId('sync-final-path')).toContainText(`${ENDPOINT}novelist-sync/<project-id>/`);
    await app.getByRole('button', { name: 'Test Connection', exact: true }).click();
    await expect(app.getByText('Connection successful.', { exact: true })).toBeVisible();
    expect((await mockState.getInvokeCalls()).filter((call) => call.command === 'test_sync_connection').at(-1)?.args.remoteDirectory).toBe('');
  });

  test('keeps legacy roots when saving or connecting, and pauses sync on a deliberate directory change', async ({ app, mockState }) => {
    await app.evaluate((project) => {
      const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
      if (!state || typeof state !== 'object' || !('setSyncConfig' in state) || typeof state.setSyncConfig !== 'function') throw new Error('Sync fixture unavailable');
      state.setSyncConfig(project, { enabled: true, webdav_url: 'https://dav.example.com/files/writer/', username: 'writer', password: 'legacy-password', interval_minutes: 30, legacy_remote_acknowledged: true, cloud_account: false });
    }, MOCK_PROJECT_DIR);
    await openRecentProject(app);
    await openSyncSettings(app);
    await expect(app.getByTestId('sync-use-endpoint-folder')).toBeChecked();
    await expect(app.getByTestId('sync-directory-mode')).toContainText('endpoint folder (legacy layout)');
    await expect(app.getByTestId('sync-final-path')).toContainText(`${ENDPOINT}novelist-sync/<project-id>/`);
    await app.locator('#sync-interval').selectOption('60');
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('');
    expect((await savedSyncConfig(app))?.interval_minutes).toBe(60);

    await fillConnection(app);
    await app.getByTestId('cloud-connect').click();
    await expect(app.getByTestId('cloud-account-folder')).toContainText(`${ENDPOINT}Novelist/`);
    await expect(app.getByTestId('cloud-link')).toBeVisible();
    await expect(app.getByTestId('sync-use-endpoint-folder')).toBeChecked();
    expect((await savedSyncConfig(app))?.remote_directory).toBe('');
    expect((await savedSyncConfig(app))?.cloud_account).toBe(false);
    expect((await savedSyncConfig(app))?.enabled).toBe(true);
    expect((await mockState.getInvokeCalls()).filter((call) => ['bind_cloud_project', 'sync_now'].includes(call.command))).toEqual([]);
    await app.getByTestId('sync-use-endpoint-folder').uncheck();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('Novelist');
    await expect(app.getByTestId('sync-directory-notice')).toContainText('Project sync is paused');
    await expect(app.locator('#sync-enabled')).toHaveAttribute('aria-checked', 'false');
    expect((await savedSyncConfig(app))?.enabled).toBe(false);
    expect((await savedSyncConfig(app))?.legacy_remote_acknowledged).toBe(false);
    expect((await mockState.getInvokeCalls()).filter((call) => ['bind_cloud_project', 'sync_now'].includes(call.command))).toEqual([]);
  });

  test('requires stopping a shared binding before editing its project directory and does not resume sync', async ({ app, mockState }) => {
    await openRecentProject(app);
    await openSyncSettings(app);
    await fillConnection(app);
    await app.getByTestId('cloud-connect').click();
    await app.getByTestId('cloud-link').click();
    await expect(app.getByTestId('settings-sync-cloud-managed')).toBeVisible();
    await expect(app.getByTestId('sync-remote-directory')).toBeDisabled();
    await expect(app.getByTestId('sync-use-endpoint-folder')).toBeDisabled();
    await expect(app.getByTestId('cloud-project-sync-path')).toContainText(`${ENDPOINT}Novelist/novelist-sync/<project-id>/`);
    await app.getByTestId('cloud-unlink').click();
    await expect(app.getByTestId('sync-remote-directory')).toBeEnabled();
    const commandsBefore = (await mockState.getInvokeCalls()).filter((call) => ['bind_cloud_project', 'sync_now'].includes(call.command)).length;
    await app.getByTestId('sync-remote-directory').fill('Another directory');
    await app.getByTestId('sync-remote-directory').blur();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('Another directory');
    expect((await savedSyncConfig(app))?.enabled).toBe(false);
    expect((await savedSyncConfig(app))?.cloud_account).toBe(false);
    expect((await mockState.getInvokeCalls()).filter((call) => ['bind_cloud_project', 'sync_now'].includes(call.command))).toHaveLength(commandsBefore);
  });

  test('invalidates successful and pending connection checks when credentials or the folder change', async ({ app }) => {
    await openRecentProject(app);
    await openSyncSettings(app);
    await app.locator('#sync-webdav-url').fill(ENDPOINT);
    const success = app.getByText('Connection successful.', { exact: true });
    for (const [selector, value] of [
      ['#sync-webdav-url', 'https://other.example.com/'],
      ['#sync-username', 'another-writer'],
      ['#sync-password', 'another-password'],
      ['[data-testid="sync-remote-directory"]', 'Another folder'],
    ]) {
      await app.getByRole('button', { name: 'Test Connection', exact: true }).click();
      await expect(success).toBeVisible();
      await app.locator(selector).fill(value);
      await expect(success).toHaveCount(0);
    }
    await app.getByTestId('sync-remote-directory').blur();
    await expect.poll(async () => (await savedSyncConfig(app))?.remote_directory).toBe('Another folder');

    await app.evaluate(() => {
      const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
      if (!internals || typeof internals !== 'object' || !('invoke' in internals) || typeof internals.invoke !== 'function') throw new Error('Tauri mock unavailable');
      const original = internals.invoke.bind(internals);
      const gate = Promise.withResolvers<boolean>();
      const request = { started: false, complete: gate.resolve };
      Reflect.set(window, '__SYNC_TEST_REQUEST__', request);
      internals.invoke = (command: string, args: Record<string, unknown>) => {
        if (command === 'test_sync_connection') { request.started = true; return gate.promise; }
        return original(command, args);
      };
    });
    await app.getByRole('button', { name: 'Test Connection', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Testing...', exact: true })).toBeDisabled();
    await app.locator('#sync-username').fill('changed-during-check');
    await app.evaluate(async () => {
      const request: unknown = Reflect.get(window, '__SYNC_TEST_REQUEST__');
      if (!request || typeof request !== 'object' || !('started' in request) || !request.started || !('complete' in request) || typeof request.complete !== 'function') throw new Error('Connection test was not started');
      request.complete(true);
    });
    await expect(app.getByRole('button', { name: 'Test Connection', exact: true })).toBeEnabled();
    await expect(success).toHaveCount(0);
  });
});
