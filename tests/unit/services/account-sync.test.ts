// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('$lib/services/account-config', () => ({}));
vi.mock('$lib/services/account-native', () => ({}));
import { AccountSync, type ConfigAdapter, type Fields, type NativeAdapter, type Category } from '$lib/services/account-sync';
import { decryptConfiguration, encryptConfiguration, generateRecoveryKey, type EncryptedEnvelope } from '$lib/services/account-crypto';
import type { AccountSummary } from '$lib/services/account-native';

type Remote = { revision: number; envelope: EncryptedEnvelope | null; writes: number; offline: boolean; reads?: number; legacyServer?: boolean };
type SyncDevice = {
  sync: AccountSync;
  adapter: ConfigAdapter;
  transport: NativeAdapter;
  fields(): Fields;
  edit(name: string, value?: string): void;
  counters(): { requests: number; applies: number };
  persisted(): string | null;
};
function device(remote: Remote, initial: Fields = {}, secrets: string[] = []): SyncDevice {
  let fields = structuredClone(initial);
  let key: string | null = null, state: string | null = null;
  let account: AccountSummary | null = null;
  let requests = 0, applies = 0;
  const adapter: ConfigAdapter = {
    async captureConfiguration(categories, includeSecrets) {
      return { fields: Object.fromEntries(Object.entries(fields).filter(([name]) => categories.some((category) => name.startsWith(`${category}/`)) && (includeSecrets || !secrets.includes(name)))), secretKeys: secrets };
    },
    async applyConfiguration(next, categories, includeSecrets) {
      applies++;
      fields = Object.fromEntries(Object.entries(fields).filter(([name]) => !categories.some((category) => name.startsWith(`${category}/`)) || (!includeSecrets && secrets.includes(name))));
      Object.assign(fields, structuredClone(next));
    },
    async removeRestoredConnections() {},
    fieldLabel: (name) => name,
  };
  const transport: NativeAdapter = {
    async status() { return account; },
    async authenticate(endpoint, username, _password, deviceName) {
      account = { endpoint, username, user_id: 'user-1', device_id: deviceName, expires_at: '2099-01-01T00:00:00Z' };
      return account;
    },
    async request(method, path, body) {
      requests++;
      if (remote.offline) throw new Error('network failure including password=not-for-display');
      if (path === '/v1/config/revision' && method === 'GET') {
        if (remote.legacyServer) throw new Error('account_request_failed');
        return { revision: remote.revision };
      }
      if (path === '/v1/config' && method === 'GET') { remote.reads = (remote.reads ?? 0) + 1; return { revision: remote.revision, envelope: remote.envelope }; }
      if (path === '/v1/config' && method === 'PUT') {
        const update = body as { base_revision: number; envelope: EncryptedEnvelope };
        if (update.base_revision !== remote.revision) throw new Error('revision_conflict');
        remote.envelope = update.envelope; remote.revision++; remote.writes++;
        return { revision: remote.revision, envelope: remote.envelope };
      }
      return { ok: true };
    },
    async forget() { account = null; key = null; state = null; },
    async recoveryKey(value = null) { if (value !== null) key = value; return key; },
    async loadState() { return state; },
    async saveState(value) { state = value; },
  };
  const sync = new AccountSync(adapter, transport);
  return {
    sync, adapter, transport,
    fields: () => fields,
    edit(name: string, value?: string) { if (value === undefined) delete fields[name]; else fields[name] = value; },
    counters: () => ({ requests, applies }),
    persisted: () => state,
  };
}
async function connect(target: SyncDevice, key: string, categories: Category[], mode: 'local' | 'cloud' = 'local', secrets = false) {
  await target.sync.login('http://localhost:8787', 'alice', 'not-sent-to-config', crypto.randomUUID(), false);
  await target.sync.unlock(key);
  await target.sync.preview(categories, secrets);
  await target.sync.commit(mode);
  await target.sync.enable();
}

describe('optional account configuration sync', () => {
  it('starts signed out without network and login never uploads or applies configuration', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const target = device(remote, { 'preferences/theme': 'local' });
    await target.sync.initialize();
    expect(target.sync.view.state).toBe('signed_out');
    expect(target.counters()).toEqual({ requests: 0, applies: 0 });
    await target.sync.login('http://localhost:8787', 'alice', 'password', 'desktop', false);
    await target.sync.unlock(generateRecoveryKey());
    expect(remote.writes).toBe(0);
    expect(target.counters().applies).toBe(0);
    expect(target.fields()['preferences/theme']).toBe('local');
    await expect(target.sync.enable()).rejects.toThrow('sync_not_configured');
  });

  it('merges independent device edits and retains both versions of a same-field conflict', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const a = device(remote, { 'preferences/theme': 'light', 'preferences/font': 'serif' });
    await connect(a, key, ['preferences']);
    const b = device(remote);
    await connect(b, key, ['preferences'], 'cloud');
    b.edit('preferences/theme', 'dark'); await b.sync.sync();
    a.edit('preferences/font', 'sans'); await a.sync.sync();
    expect(a.fields()).toEqual({ 'preferences/theme': 'dark', 'preferences/font': 'sans' });
    await b.sync.sync();
    a.edit('preferences/theme', 'sepia'); b.edit('preferences/theme', 'blue');
    await b.sync.sync();
    const writes = remote.writes;
    await a.sync.sync();
    expect(a.sync.view.preview?.conflicts).toEqual(['preferences/theme']);
    expect(a.fields()['preferences/theme']).toBe('sepia');
    expect(remote.writes).toBe(writes);
    await expect(a.sync.commit('merge')).rejects.toThrow('conflicts_unresolved');
    await a.sync.commit('merge', { 'preferences/theme': 'local' });
    await b.sync.sync();
    expect(b.fields()['preferences/theme']).toBe('sepia');
  });

  it('preserves tombstones across stale devices and new-device templates', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const a = device(remote, { 'ai/profiles/openai/label': 'OpenAI' });
    await connect(a, key, ['ai']);
    const b = device(remote); await connect(b, key, ['ai'], 'cloud');
    b.edit('ai/profiles/openai/label'); await b.sync.sync();
    a.edit('ai/profiles/custom/label', 'Custom'); await a.sync.sync();
    expect(a.fields()).toEqual({ 'ai/profiles/custom/label': 'Custom' });
    const c = device(remote, { 'ai/profiles/openai/label': 'OpenAI' });
    await c.sync.login('http://localhost:8787', 'alice', 'password', 'new-phone', false);
    await c.sync.unlock(key); await c.sync.preview(['ai'], false);
    expect(c.sync.view.preview?.conflicts).toEqual([]);
    await c.sync.commit('merge');
    expect(c.fields()).toEqual({ 'ai/profiles/custom/label': 'Custom' });
  });

  it('deletes profile credentials with the entity even after secret synchronization is disabled', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const prefix = 'ai/profiles/provider/';
    const secret = `${prefix}apiKey`;
    const a = device(remote, { [`${prefix}present`]: true, [`${prefix}label`]: 'Provider', [secret]: 'old-key' }, [secret]);
    await connect(a, key, ['ai'], 'local', true);
    await a.sync.disable();
    await a.sync.preview(['ai'], false); await a.sync.commit('merge'); await a.sync.enable();
    a.edit(`${prefix}present`); a.edit(`${prefix}label`); a.edit(secret);
    await a.sync.sync();
    const decoded = await decryptConfiguration(remote.envelope!, key, 'http://localhost:8787', 'user-1', 'cloud') as { fields: Fields; deleted: string[] };
    expect(decoded.fields).toEqual({});
    expect(decoded.deleted).toContain(secret);
  });

  it('excludes secrets without consent and preserves existing device credentials during ordinary restore', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const secret = 'ai/profiles/provider/apiKey';
    const a = device(remote, { 'ai/profiles/provider/label': 'Provider', [secret]: 'first-device-key' }, [secret]);
    await connect(a, key, ['ai']);
    const decoded = await decryptConfiguration(remote.envelope!, key, 'http://localhost:8787', 'user-1', 'cloud') as { fields: Fields };
    expect(decoded.fields).toEqual({ 'ai/profiles/provider/label': 'Provider' });
    const b = device(remote, { [secret]: 'second-device-key' }, [secret]);
    await connect(b, key, ['ai'], 'cloud');
    expect(b.fields()[secret]).toBe('second-device-key');
    expect(b.fields()['ai/profiles/provider/label']).toBe('Provider');
    expect(b.persisted()).not.toContain('second-device-key');
  });

  it('persists encrypted offline edits, retries online and restores a backup with sync disabled', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const a = device(remote, { 'preferences/theme': 'light' });
    const key = generateRecoveryKey();
    await connect(a, key, ['preferences']);
    a.edit('preferences/theme', 'dark'); remote.offline = true;
    await expect(a.sync.sync()).rejects.toThrow('account_operation_failed');
    expect(a.sync.view.state).toBe('pending');
    expect(a.persisted()).not.toContain('dark');
    expect(a.sync.view.error).not.toContain('password');
    remote.offline = false; await a.sync.sync();
    expect(a.sync.view.state).toBe('ready');
    const b = device(remote);
    await connect(b, key, ['preferences'], 'cloud');
    b.edit('preferences/theme', 'sepia'); await b.sync.sync();
    await a.sync.sync();
    expect(a.fields()['preferences/theme']).toBe('sepia');
    await a.sync.restoreBackup();
    expect(a.sync.view.enabled).toBe(false);
    expect(a.fields()['preferences/theme']).toBe('dark');
    remote.offline = true; await a.sync.logout(true);
    expect(a.sync.view.account).toBeNull();
    expect(a.fields()['preferences/theme']).toBe('dark');
    expect(a.persisted()).toBeNull();
  });

  it('rejects stale preview writes before applying cloud data and rejects a wrong recovery key', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, key, ['preferences']);
    const b = device(remote, { 'preferences/theme': 'local' });
    await b.sync.login('http://localhost:8787', 'alice', 'password', 'phone', false);
    await expect(b.sync.unlock(generateRecoveryKey())).rejects.toThrow('decryption_failed');
    await b.sync.unlock(key); await b.sync.preview(['preferences'], false);
    a.edit('preferences/theme', 'two'); await a.sync.sync();
    await expect(b.sync.commit('cloud')).rejects.toThrow('revision_conflict');
    expect(b.fields()['preferences/theme']).toBe('local');
    expect(b.counters().applies).toBe(0);
  });

  it('idle background syncs do not rewrite the encrypted local state', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, generateRecoveryKey(), ['preferences']);
    await a.sync.sync();
    const before = a.persisted();
    await a.sync.sync(); await a.sync.sync();
    // Each write re-encrypts with a fresh nonce, so an unchanged string means no write.
    expect(a.persisted()).toBe(before);
    expect(remote.writes).toBe(1);
  });

  it('idle devices only check the revision and pulling cloud changes uploads nothing', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, key, ['preferences']);
    const b = device(remote, {}); await connect(b, key, ['preferences'], 'cloud');
    expect(remote.writes).toBe(1);
    const reads = remote.reads ?? 0;
    await b.sync.sync(); await b.sync.sync();
    expect(remote.reads ?? 0).toBe(reads);
    a.edit('preferences/theme', 'two'); await a.sync.sync();
    expect(remote.writes).toBe(2);
    await b.sync.sync();
    expect(b.fields()['preferences/theme']).toBe('two');
    expect(b.sync.view.state).toBe('ready');
    expect(remote.writes).toBe(2);
    expect(b.sync.view.revision).toBe(2);
  });

  it('falls back to full fetches and uploads on services without the revision check', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false, legacyServer: true };
    const key = generateRecoveryKey();
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, key, ['preferences']);
    const b = device(remote, {}); await connect(b, key, ['preferences'], 'cloud');
    a.edit('preferences/theme', 'two'); await a.sync.sync();
    await b.sync.sync();
    expect(b.fields()['preferences/theme']).toBe('two');
    expect(b.sync.view.state).toBe('ready');
  });

  it('clears a stale pending snapshot once local edits are reverted', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, generateRecoveryKey(), ['preferences']);
    remote.offline = true;
    a.edit('preferences/theme', 'two');
    await expect(a.sync.sync()).rejects.toThrow();
    expect(a.sync.view.state).toBe('pending');
    a.edit('preferences/theme', 'one');
    remote.offline = false;
    await a.sync.sync();
    expect(a.sync.view.state).toBe('ready');
    expect(remote.writes).toBe(1);
  });

  it('recovers when settings change while the cloud write is in flight', async () => {
    const remote: Remote = { revision: 0, envelope: null, writes: 0, offline: false };
    const key = generateRecoveryKey();
    const a = device(remote, { 'preferences/theme': 'one' }); await connect(a, key, ['preferences']);
    const request = a.transport.request;
    a.transport.request = async (method, path, body) => {
      const result = await request(method, path, body);
      if (method === 'PUT') a.edit('preferences/theme', 'three');
      return result;
    };
    a.edit('preferences/theme', 'two');
    await a.sync.sync();
    expect(remote.writes).toBe(2);
    // The edit made during the write survives locally and is still pending.
    expect(a.fields()['preferences/theme']).toBe('three');
    expect(a.sync.view.state).toBe('pending');
    a.transport.request = request;
    // Nothing blocks the next sync, and the newer edit reaches the cloud without a conflict.
    await a.sync.sync();
    expect(a.sync.view.state).toBe('ready');
    expect(remote.writes).toBe(3);
    const b = device(remote, {}); await b.sync.login('http://localhost:8787', 'alice', 'password', 'phone', false);
    await b.sync.unlock(key); await b.sync.preview(['preferences'], false); await b.sync.commit('cloud');
    expect(b.fields()['preferences/theme']).toBe('three');
  });

  it('upgrades legacy encrypted documents while retaining an explicitly chosen directory', async () => {
    const key = generateRecoveryKey();
    const fields = { 'webdav/connection/present': true, 'webdav/connection/endpoint': 'https://dav.example.test/', 'webdav/connection/username': 'writer', 'webdav/connection/remote_directory': '写作/小说' };
    const envelope = await encryptConfiguration({ schema: 1, fields, deleted: [], secretKeys: ['webdav/connection/password'] }, key, 'http://localhost:8787', 'user-1', 'cloud');
    const remote: Remote = { revision: 1, envelope, writes: 0, offline: false };
    const target = device(remote);
    await connect(target, key, ['webdav'], 'cloud');
    expect(target.fields()['webdav/connection/remote_directory']).toBe('写作/小说');
    const uploaded = await decryptConfiguration(remote.envelope!, key, 'http://localhost:8787', 'user-1', 'cloud') as { schema: number; fields: Fields };
    expect(uploaded.schema).toBe(2);
    expect(uploaded.fields['webdav/connection/remote_directory']).toBe('写作/小说');
  });

  it('authenticates ciphertext to the account, service and local/cloud purpose', async () => {
    const key = generateRecoveryKey();
    const encrypted = await encryptConfiguration({ value: 'secret' }, key, 'https://one.example', 'alice', 'cloud');
    await expect(decryptConfiguration(encrypted, key, 'https://two.example', 'alice', 'cloud')).rejects.toThrow('decryption_failed');
    await expect(decryptConfiguration(encrypted, key, 'https://one.example', 'bob', 'cloud')).rejects.toThrow('decryption_failed');
    await expect(decryptConfiguration(encrypted, key, 'https://one.example', 'alice', 'local')).rejects.toThrow('decryption_failed');
    const modified = { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, -4) + 'AAAA' };
    await expect(decryptConfiguration(modified, key, 'https://one.example', 'alice', 'cloud')).rejects.toThrow('decryption_failed');
  });
});
