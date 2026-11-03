import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';
import { encryptConfiguration, type EncryptedEnvelope } from '../../../app/lib/services/account-crypto';

const ENDPOINT = 'http://localhost:8787';
const USER_ID = 'account-ui-user';
const RECOVERY_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

type Cloud = { revision: number; envelope: EncryptedEnvelope | null };

/** Mock only the native account/vault boundary; use the production engine and configuration adapter. */
async function installAccountBridge(page: Page, cloud: Cloud = { revision: 0, envelope: null }) {
  await page.evaluate(({ cloud, endpoint, userId }) => {
    const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
    if (!internals || typeof internals !== 'object' || !('invoke' in internals) || typeof internals.invoke !== 'function') throw new Error('Tauri mock bridge unavailable');
    const original = internals.invoke.bind(internals);
    const summary = { endpoint, user_id: userId, username: 'writer', device_id: 'current-device', expires_at: '2099-01-01T00:00:00Z' };
    let signedIn = false;
    let key: string | null = null;
    let savedState: string | null = null;
    let journal: string | null = null;
    const secrets = new Map<string, string>();
    const requests: Array<{ method: string; path: string }> = [];
    const calls: string[] = [];
    let devices = [
      { id: 'current-device', name: 'This laptop', created_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-11-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', current: true },
      { id: 'other-device', name: 'Other laptop', created_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', current: false },
    ];
    Reflect.set(window, '__ACCOUNT_UI_BRIDGE__', { requests, calls, get cloud() { return cloud; }, get savedState() { return savedState; } });
    internals.invoke = async (command: string, args: Record<string, unknown> = {}) => {
      if (!command.startsWith('account_')) return original(command, args);
      calls.push(command);
      switch (command) {
        case 'account_status': return signedIn ? summary : null;
        case 'account_authenticate': signedIn = true; return summary;
        case 'account_forget': signedIn = false; key = null; savedState = null; return null;
        case 'account_recovery_key': if (typeof args.value === 'string') key = args.value; return key;
        case 'account_load_state': return savedState;
        case 'account_save_state': savedState = String(args.value); return null;
        case 'account_config_journal':
          if (args.clear) journal = null;
          else if (typeof args.value === 'string') journal = args.value;
          return journal;
        case 'account_config_get_secret': return secrets.get(String(args.key)) ?? null;
        case 'account_config_set_secret':
          if (typeof args.value === 'string') secrets.set(String(args.key), args.value);
          else secrets.delete(String(args.key));
          return null;
        case 'account_config_webdav':
        case 'account_config_restore_webdav':
        case 'account_config_remove_restored_webdav': return null;
        case 'account_request': {
          const method = String(args.method);
          const path = String(args.path);
          requests.push({ method, path });
          if (!signedIn) throw new Error('session_expired');
          if (method === 'GET' && path === '/v1/config') return cloud;
          if (method === 'PUT' && path === '/v1/config') {
            const body = args.body;
            if (!body || typeof body !== 'object' || !('base_revision' in body) || !('envelope' in body)) throw new Error('Invalid account upload');
            const incoming = body.envelope;
            if (!incoming || typeof incoming !== 'object' || !('version' in incoming) || incoming.version !== 1 || !('iv' in incoming) || typeof incoming.iv !== 'string' || !('ciphertext' in incoming) || typeof incoming.ciphertext !== 'string') throw new Error('Invalid encrypted envelope');
            if (body.base_revision !== cloud.revision) throw new Error('revision_conflict');
            cloud = { revision: cloud.revision + 1, envelope: { version: 1, iv: incoming.iv, ciphertext: incoming.ciphertext } };
            return cloud;
          }
          if (method === 'GET' && path === '/v1/devices') return { devices };
          if (method === 'DELETE' && path.startsWith('/v1/devices/')) {
            devices = devices.filter((device) => device.id !== path.slice('/v1/devices/'.length));
            return { ok: true };
          }
          // Exercise production best-effort logout with an unavailable account server.
          if (method === 'POST' && path === '/v1/logout') throw new Error('offline');
          if (method === 'DELETE' && path === '/v1/account') {
            const body = args.body;
            if (!body || typeof body !== 'object' || !('password' in body) || body.password !== 'correct-account-password') throw new Error('account_credentials_invalid');
            return { ok: true };
          }
          throw new Error('Unexpected account request');
        }
        default: throw new Error('Unexpected account command: ' + command);
      }
    };
  }, { cloud, endpoint: ENDPOINT, userId: USER_ID });
}

async function openAccountPanel(page: Page) {
  await page.evaluate(() => {
    const api: unknown = Reflect.get(window, '__test_api__');
    if (!api || typeof api !== 'object' || !('toggleSettings' in api) || typeof api.toggleSettings !== 'function') throw new Error('App test API unavailable');
    api.toggleSettings();
  });
  await page.getByTestId('settings-section-sync').click();
  await expect(page.getByTestId('account-login')).toBeEnabled();
}

async function signIn(page: Page) {
  await page.getByTestId('account-endpoint').fill(ENDPOINT);
  await page.getByTestId('account-username').fill('writer');
  await page.getByTestId('account-password').fill('correct-account-password');
  await page.getByTestId('account-device-name').fill('This laptop');
  await page.getByTestId('account-login').click();
  await expect(page.getByTestId('account-state')).toHaveText('Configuration locked');
}

async function accountRequests(page: Page) {
  return page.evaluate(() => {
    const bridge: unknown = Reflect.get(window, '__ACCOUNT_UI_BRIDGE__');
    if (!bridge || typeof bridge !== 'object' || !('requests' in bridge) || !Array.isArray(bridge.requests)) throw new Error('Account bridge requests unavailable');
    return bridge.requests.map((request: unknown) => {
      if (!request || typeof request !== 'object' || !('method' in request) || typeof request.method !== 'string' || !('path' in request) || typeof request.path !== 'string') throw new Error('Invalid recorded request');
      return { method: request.method, path: request.path };
    });
  });
}

test.describe('[contract] Optional Novelist account configuration sync', () => {
  test('works without a project and requires saved key, explicit scope, preview, and commit before enabling', async ({ app }) => {
    await installAccountBridge(app);
    await openAccountPanel(app);
    await expect(app.getByTestId('cloud-account-panel')).toBeVisible();
    await expect(app.getByTestId('cloud-account-panel').getByText('WebDAV connection', { exact: true })).toBeVisible();
    await expect(app.getByTestId('account-endpoint')).toHaveValue('');
    await expect(app.getByTestId('account-password')).toHaveAttribute('type', 'password');
    await app.getByTestId('account-generate-key').click();
    await expect(app.getByTestId('account-use-generated-key')).toBeDisabled();
    await signIn(app);
    for (const category of ['preferences', 'shortcuts', 'ai', 'webdav']) {
      await expect(app.getByTestId(`account-category-${category}`)).not.toBeChecked();
    }
    await expect(app.getByTestId('account-include-secrets')).not.toBeChecked();
    await expect(app.getByTestId('account-preview')).toBeDisabled();
    await expect(app.getByTestId('account-sync-enable')).toBeDisabled();
    await expect(app.getByTestId('account-recovery-key')).toHaveAttribute('type', 'password');
    await expect(app.getByTestId('account-use-generated-key')).toBeDisabled();
    await app.getByTestId('account-recovery-key').fill(await app.getByTestId('account-generated-key').inputValue());
    await expect(app.getByTestId('account-unlock')).toBeDisabled();
    await app.getByTestId('account-key-saved').check();
    await app.getByTestId('account-use-generated-key').click();
    await expect(app.getByTestId('account-state')).toHaveText('Sync paused');
    await expect(app.getByTestId('account-generated-key')).toHaveCount(0);
    expect((await accountRequests(app)).filter((request) => request.method === 'PUT')).toEqual([]);
    await app.getByTestId('account-category-shortcuts').check();
    await app.getByTestId('account-preview').click();
    await expect(app.getByTestId('account-diff-preview')).toBeVisible();
    expect((await accountRequests(app)).filter((request) => request.method === 'PUT')).toEqual([]);
    await expect(app.getByTestId('account-sync-enable')).toBeDisabled();
    await app.getByTestId('account-commit-merge').click();
    await expect(app.getByTestId('account-sync-enable')).toBeEnabled();
    await app.getByTestId('account-sync-enable').click();
    await expect(app.getByTestId('account-enabled')).toHaveText('Configuration sync enabled');
    await expect(app.getByTestId('account-category-ai')).toBeDisabled();
    await app.getByTestId('account-sync-disable').click();
    await expect(app.getByTestId('account-category-ai')).toBeEnabled();
    await expect(app.getByTestId('account-backup-restore')).toBeVisible();
  });

  test('shows ordinary differences, hides credentials, requires conflict choices, and invalidates changed scope', async ({ app }) => {
    const envelope = await encryptConfiguration({
      schema: 2,
      fields: {
        'preferences/editor/fontSize': 40,
        'ai/profiles/remote/present': true,
        'ai/profiles/remote/label': 'Remote profile',
        'ai/profiles/remote/baseUrl': 'https://provider.example/v1',
        'ai/profiles/remote/model': 'remote-model',
        'ai/profiles/remote/apiKey': 'cloud-secret-never-rendered',
      },
      deleted: [],
      secretKeys: ['ai/profiles/remote/apiKey'],
    }, RECOVERY_KEY, ENDPOINT, USER_ID, 'cloud');
    await installAccountBridge(app, { revision: 1, envelope });
    await openAccountPanel(app);
    await signIn(app);
    await app.getByTestId('account-recovery-key').fill(RECOVERY_KEY);
    await app.getByTestId('account-unlock').click();
    await expect(app.getByTestId('account-recovery-key')).toHaveValue('');
    await app.getByTestId('account-category-preferences').check();
    await app.getByTestId('account-category-ai').check();
    await app.getByTestId('account-include-secrets').check();
    await app.getByTestId('account-preview').click();
    await expect(app.getByTestId('account-diff-row').filter({ hasText: 'Font size' })).toContainText('40');
    await expect(app.getByTestId('account-diff-row').filter({ hasText: 'API key' })).toContainText('Hidden credential');
    await expect(app.getByTestId('account-diff-preview')).not.toContainText('cloud-secret-never-rendered');
    await expect(app.getByTestId('account-commit-merge')).toBeDisabled();
    const conflicts = app.getByTestId('account-conflict-choice');
    for (let index = 0; index < await conflicts.count(); index++) await conflicts.nth(index).selectOption('local');
    await expect(app.getByTestId('account-commit-merge')).toBeEnabled();
    await app.getByTestId('account-category-shortcuts').check();
    await expect(app.getByTestId('account-commit-merge')).toBeDisabled();
    await expect(app.getByTestId('account-commit-local')).toBeDisabled();
    await expect(app.getByTestId('account-commit-cloud')).toBeDisabled();
    expect((await accountRequests(app)).filter((request) => request.method === 'PUT')).toEqual([]);
  });

  test('device revocation is explicit and offline sign-out keeps restored WebDAV by default', async ({ app }) => {
    await installAccountBridge(app);
    await openAccountPanel(app);
    await signIn(app);
    await expect(app.getByTestId('account-keep-connections')).toBeChecked();
    await app.getByTestId('account-devices-refresh').click();
    await expect(app.getByTestId('account-devices')).toContainText('Other laptop');
    await app.getByTestId('account-devices').getByRole('listitem').filter({ hasText: 'Other laptop' }).getByRole('button', { name: 'Revoke session' }).click();
    expect((await accountRequests(app)).filter((request) => request.method === 'DELETE')).toEqual([]);
    await expect(app.getByTestId('account-devices')).toContainText('WebDAV access already on that device remain');
    await app.getByTestId('account-device-revoke-confirm').click();
    await expect(app.getByTestId('account-devices').getByRole('listitem').filter({ hasText: 'Other laptop' })).toHaveCount(0);
    await app.getByTestId('account-logout').click();
    await app.getByTestId('account-logout-confirm').click();
    await expect(app.getByTestId('account-state')).toHaveText('Signed out');
    const calls = await app.evaluate(() => {
      const bridge: unknown = Reflect.get(window, '__ACCOUNT_UI_BRIDGE__');
      if (!bridge || typeof bridge !== 'object' || !('calls' in bridge) || !Array.isArray(bridge.calls) || !bridge.calls.every((call: unknown) => typeof call === 'string')) throw new Error('Account bridge calls unavailable');
      return bridge.calls;
    });
    expect(calls).toContain('account_forget');
    expect(calls).not.toContain('account_config_remove_restored_webdav');
    await expect(app.getByTestId('cloud-connect-form')).toBeVisible();
  });

  test('account deletion requires password and acknowledgement and preserves independent WebDAV UI', async ({ app }) => {
    await installAccountBridge(app);
    await openAccountPanel(app);
    await signIn(app);
    await app.getByTestId('account-delete').click();
    await expect(app.getByTestId('account-delete-confirm')).toBeDisabled();
    await expect(app.getByTestId('account-delete-form')).toContainText('files on WebDAV are not deleted');
    await expect(app.getByTestId('account-delete-password')).toHaveAttribute('type', 'password');
    await app.getByTestId('account-delete-password').fill('incorrect-password');
    await expect(app.getByTestId('account-delete-confirm')).toBeDisabled();
    await app.getByTestId('account-delete-acknowledged').check();
    await app.getByTestId('account-delete-confirm').click();
    await expect(app.getByTestId('account-error')).toBeVisible();
    await expect(app.getByTestId('account-delete-password')).toHaveValue('');
    await expect(app.getByTestId('account-identity')).toBeVisible();
    await app.getByTestId('account-delete-password').fill('correct-account-password');
    await app.getByTestId('account-keep-connections').uncheck();
    await app.getByTestId('account-delete-confirm').click();
    await expect(app.getByTestId('account-state')).toHaveText('Signed out');
    await expect(app.getByTestId('cloud-connect-form')).toBeVisible();
    const calls = await app.evaluate(() => {
      const bridge: unknown = Reflect.get(window, '__ACCOUNT_UI_BRIDGE__');
      if (!bridge || typeof bridge !== 'object' || !('calls' in bridge) || !Array.isArray(bridge.calls)) throw new Error('Account bridge calls unavailable');
      return bridge.calls;
    });
    expect(calls).toContain('account_config_remove_restored_webdav');
    expect(calls).toContain('account_forget');
  });
});
