import * as native from './account-native';
import type { AccountSummary } from './account-native';
import * as configuration from './account-config';
import { decryptConfiguration, encryptConfiguration, generateRecoveryKey, validateRecoveryKey, type EncryptedEnvelope, type JsonValue } from './account-crypto';

export type Category = 'preferences' | 'shortcuts' | 'ai' | 'webdav';
export type Fields = Record<string, JsonValue>;
export type Snapshot = { fields: Fields; secretKeys: string[] };
export interface ConfigAdapter {
  recoverConfiguration?(): Promise<void>;
  captureConfiguration(categories: Category[], includeSecrets: boolean): Promise<Snapshot>;
  applyConfiguration(fields: Fields, categories: Category[], includeSecrets: boolean): Promise<void>;
  removeRestoredConnections(): Promise<void>;
  fieldLabel(key: string): string;
}
export interface NativeAdapter {
  status(): Promise<AccountSummary | null>;
  authenticate(endpoint: string, username: string, password: string, deviceName: string, register: boolean): Promise<AccountSummary>;
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  forget(): Promise<void>;
  recoveryKey(value?: string | null): Promise<string | null>;
  loadState(): Promise<string | null>;
  saveState(value: string): Promise<void>;
}
export type Device = { id: string; name: string; created_at: string; last_seen_at: string; expires_at: string; current: boolean };
type Document = { schema: 2; fields: Fields; deleted: string[]; secretKeys: string[] };
type Cloud = { revision: number; envelope: EncryptedEnvelope | null };
type Choice = 'local' | 'cloud';
type Backup = { snapshot: Snapshot; categories: Category[] };
type StoredState = {
  version: 1;
  enabled: boolean;
  configured: boolean;
  categories: Category[];
  includeSecrets: boolean;
  revision: number;
  baseline: Document | null;
  backup: Backup | null;
  pending: Snapshot | null;
};
export type Preview = {
  rows: { key: string; label: string; kind: 'local' | 'cloud' | 'conflict' | 'same'; localPresent: boolean; cloudPresent: boolean; sensitive: boolean; localValue?: string; cloudValue?: string }[];
  conflicts: string[];
};
export type AccountView = {
  account: AccountSummary | null;
  enabled: boolean;
  busy: boolean;
  state: 'signed_out' | 'disabled' | 'locked' | 'ready' | 'pending' | 'error' | 'preview';
  error: string | null;
  categories: Category[];
  includeSecrets: boolean;
  revision: number;
  preview: Preview | null;
  hasBackup: boolean;
};
type Prepared = { cloud: Cloud; remote: Document; local: Snapshot; categories: Category[]; includeSecrets: boolean; preview: Preview };
const CATEGORIES: Category[] = ['preferences', 'shortcuts', 'ai', 'webdav'];
const EMPTY_DOCUMENT = (): Document => ({ schema: 2, fields: {}, deleted: [], secretKeys: [] });
const EMPTY_STATE = (): StoredState => ({ version: 1, enabled: false, configured: false, categories: [], includeSecrets: false, revision: 0, baseline: null, backup: null, pending: null });
const OWN = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a);
    return ak.length === Object.keys(b).length && ak.every((key) => OWN(b, key) && equal((a as Fields)[key], (b as Fields)[key]));
  }
  return false;
}

function validJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2000 && value.every((item) => validJson(item, depth + 1));
  return !!value && typeof value === 'object' && Object.keys(value).length <= 2000 && Object.entries(value).every(([key, item]) => !['__proto__', 'constructor', 'prototype'].includes(key) && validJson(item, depth + 1));
}

function validFields(value: unknown): value is Fields {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 4000 && Object.entries(value).every(([key, item]) => key.length <= 512 && /^(preferences|shortcuts|ai|webdav)\/[^\x00-\x1f]+$/.test(key) && validJson(item));
}

function readDocument(value: unknown): Document {
  const doc = value as Omit<Document, 'schema'> & { schema: unknown };
  if (!doc || (doc.schema !== 1 && doc.schema !== 2) || !validFields(doc.fields) || !Array.isArray(doc.deleted) || !Array.isArray(doc.secretKeys) || doc.deleted.length > 4000 || doc.secretKeys.length > 4000 || !doc.deleted.every((key) => typeof key === 'string' && key.length <= 512 && !OWN(doc.fields, key)) || !doc.secretKeys.every((key) => typeof key === 'string' && key.length <= 512)) throw new Error('unsupported_schema');
  // Schema 1 lacked application-directory semantics; absent folders retain the endpoint root.
  return { ...doc, schema: 2 };
}

function readState(value: unknown): StoredState {
  const state = value as StoredState;
  if (!state || state.version !== 1 || typeof state.enabled !== 'boolean' || typeof state.configured !== 'boolean' || !Array.isArray(state.categories) || !state.categories.every((category) => CATEGORIES.includes(category)) || typeof state.includeSecrets !== 'boolean' || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error('unsupported_schema');
  if (state.baseline) state.baseline = readDocument(state.baseline);
  if (state.pending && (!validFields(state.pending.fields) || !Array.isArray(state.pending.secretKeys))) throw new Error('unsupported_schema');
  if (state.backup && (!validFields(state.backup.snapshot?.fields) || !Array.isArray(state.backup.snapshot.secretKeys) || !Array.isArray(state.backup.categories) || !state.backup.categories.every((category) => CATEGORIES.includes(category)))) throw new Error('unsupported_schema');
  if (state.enabled && (!state.configured || !state.baseline || !state.categories.length)) throw new Error('unsupported_schema');
  return state;
}

function readCloud(value: unknown): Cloud {
  const cloud = value as Cloud;
  if (!cloud || !Number.isSafeInteger(cloud.revision) || cloud.revision < 0 || (cloud.envelope !== null && (!cloud.envelope || cloud.envelope.version !== 1))) throw new Error('unsupported_schema');
  return cloud;
}

/** Three-way comparison treats absence as deletion, independent of device clocks. */
export function configurationPreview(local: Snapshot, remote: Document, baseline: Document | null, categories: Category[], includeSecrets: boolean, label: (key: string) => string): Preview {
  const secrets = new Set([...local.secretKeys, ...remote.secretKeys, ...(baseline?.secretKeys ?? [])]);
  const keys = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields), ...remote.deleted, ...Object.keys(baseline?.fields ?? {}), ...(baseline?.deleted ?? [])]);
  const rows: Preview['rows'] = [];
  for (const key of [...keys].sort()) {
    if (!categories.some((category) => key.startsWith(`${category}/`)) || (!includeSecrets && secrets.has(key))) continue;
    const lp = OWN(local.fields, key), rp = OWN(remote.fields, key), bp = !!baseline && OWN(baseline.fields, key);
    const same = lp === rp && equal(local.fields[key], remote.fields[key]);
    const lc = lp !== bp || !equal(local.fields[key], baseline?.fields[key]);
    const rc = rp !== bp || !equal(remote.fields[key], baseline?.fields[key]) || (!baseline && remote.deleted.includes(key));
    // A known remote tombstone beats an untracked template on a returning/new device.
    const deletedWithoutBase = !baseline && remote.deleted.includes(key);
    const kind = same ? 'same' : deletedWithoutBase ? 'cloud' : lc && rc ? 'conflict' : lc ? 'local' : 'cloud';
    const sensitive = secrets.has(key);
    rows.push({
      key, label: label(key), kind, localPresent: lp, cloudPresent: rp, sensitive,
      ...(!sensitive && lp ? { localValue: JSON.stringify(local.fields[key]).slice(0, 240) } : {}),
      ...(!sensitive && rp ? { cloudValue: JSON.stringify(remote.fields[key]).slice(0, 240) } : {}),
    });
  }
  if (baseline) {
    for (const row of rows) {
      if (!/^(ai\/(profiles|prompts)\/[^/]+|webdav\/connection)\/present$/.test(row.key) || row.localPresent === row.cloudPresent || !OWN(baseline.fields, row.key)) continue;
      const prefix = row.key.slice(0, -'present'.length);
      const survivor = row.localPresent ? local.fields : remote.fields;
      if (rows.some((child) => child.key !== row.key && child.key.startsWith(prefix) && (OWN(survivor, child.key) !== OWN(baseline.fields, child.key) || !equal(survivor[child.key], baseline.fields[child.key])))) row.kind = 'conflict';
    }
  }
  return { rows, conflicts: rows.filter((row) => row.kind === 'conflict').map((row) => row.key) };
}

/** All transport errors are reduced to codes so server responses never enter UI diagnostics. */
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codes = ['revision_conflict', 'session_expired', 'account_credentials_invalid', 'decryption_failed', 'invalid_recovery_key', 'invalid_envelope', 'unsupported_schema', 'configuration_too_large', 'configuration_changed', 'conflicts_unresolved', 'preview_required', 'scope_required', 'unlock_required', 'sync_not_configured', 'already_signed_in', 'signed_out'];
  return codes.find((code) => message.includes(code)) ?? 'account_operation_failed';
}

export class AccountSync {
  private listeners = new Set<() => void>();
  private key: string | null = null;
  private stored: StoredState = EMPTY_STATE();
  private prepared: Prepared | null = null;
  private initialized = false;
  private running = false;
  private viewState: AccountView = { account: null, enabled: false, busy: false, state: 'signed_out', error: null, categories: [], includeSecrets: false, revision: 0, preview: null, hasBackup: false };

  constructor(private adapter: ConfigAdapter, private transport: NativeAdapter = native) {}

  get view(): AccountView { return this.viewState; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private update(patch: Partial<AccountView> = {}): void {
    this.viewState = { ...this.viewState, enabled: this.stored.enabled, categories: [...this.stored.categories], includeSecrets: this.stored.includeSecrets, revision: this.stored.revision, hasBackup: !!this.stored.backup, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error('account_operation_busy');
    this.running = true;
    this.update({ busy: true, error: null });
    try { return await action(); }
    catch (error) {
      const code = errorCode(error);
      this.update({ state: this.prepared ? 'preview' : this.stored.pending ? 'pending' : 'error', error: code });
      throw new Error(code);
    } finally {
      this.running = false;
      this.update({ busy: false });
    }
  }

  private identity(): AccountSummary {
    if (!this.viewState.account) throw new Error('signed_out');
    return this.viewState.account;
  }

  private async persist(): Promise<void> {
    const account = this.identity();
    if (!this.key) throw new Error('unlock_required');
    await this.transport.saveState(JSON.stringify(await encryptConfiguration(this.stored, this.key, account.endpoint, account.user_id, 'local')));
    this.update();
  }

  private async decodeRemote(cloud: Cloud): Promise<Document> {
    const account = this.identity();
    if (!this.key) throw new Error('unlock_required');
    return cloud.envelope ? readDocument(await decryptConfiguration(cloud.envelope, this.key, account.endpoint, account.user_id, 'cloud')) : EMPTY_DOCUMENT();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.operation(async () => {
      await this.adapter.recoverConfiguration?.();
      const account = await this.transport.status();
      this.update({ account });
      if (!account) { this.initialized = true; this.update({ state: 'signed_out' }); return; }
      this.key = await this.transport.recoveryKey();
      if (this.key) {
        const raw = await this.transport.loadState();
        if (raw) this.stored = readState(await decryptConfiguration(JSON.parse(raw), this.key, account.endpoint, account.user_id, 'local'));
      }
      this.initialized = true;
      this.update({ state: !this.key ? 'locked' : this.stored.pending ? 'pending' : this.stored.enabled ? 'ready' : 'disabled' });
    });
  }

  async login(endpoint: string, username: string, password: string, deviceName: string, register: boolean): Promise<void> {
    await this.operation(async () => {
      if (this.viewState.account) throw new Error('already_signed_in');
      const account = await this.transport.authenticate(endpoint, username, password, deviceName, register);
      this.stored = EMPTY_STATE(); this.key = null; this.prepared = null; this.initialized = true;
      this.update({ account, state: 'locked', preview: null });
    });
  }

  generateRecoveryKey(): string { return generateRecoveryKey(); }

  async unlock(key: string): Promise<void> {
    await this.operation(async () => {
      const account = this.identity();
      validateRecoveryKey(key);
      const cloud = readCloud(await this.transport.request('GET', '/v1/config'));
      if (cloud.envelope) readDocument(await decryptConfiguration(cloud.envelope, key, account.endpoint, account.user_id, 'cloud'));
      const raw = await this.transport.loadState();
      const restored = raw ? readState(await decryptConfiguration(JSON.parse(raw), key, account.endpoint, account.user_id, 'local')) : EMPTY_STATE();
      await this.transport.recoveryKey(key);
      this.key = key; this.stored = restored; this.prepared = null;
      this.update({ state: this.stored.enabled ? 'ready' : 'disabled', preview: null });
    });
  }

  async preview(categories: Category[], includeSecrets: boolean): Promise<void> {
    await this.operation(async () => {
      if (!categories.length || !categories.every((category) => CATEGORIES.includes(category))) throw new Error('scope_required');
      const cloud = readCloud(await this.transport.request('GET', '/v1/config'));
      const remote = await this.decodeRemote(cloud);
      const local = await this.adapter.captureConfiguration(categories, includeSecrets);
      if (!validFields(local.fields)) throw new Error('unsupported_schema');
      const preview = configurationPreview(local, remote, this.stored.baseline, categories, includeSecrets, this.adapter.fieldLabel);
      this.prepared = { cloud, remote, local, categories: [...categories], includeSecrets, preview };
      this.update({ state: 'preview', preview });
    });
  }

  private async applyPrepared(mode: 'merge' | 'local' | 'cloud', choices: Record<string, Choice>): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) throw new Error('preview_required');
    if (mode === 'merge' && prepared.preview.conflicts.some((key) => choices[key] !== 'local' && choices[key] !== 'cloud')) throw new Error('conflicts_unresolved');
    const current = await this.adapter.captureConfiguration(prepared.categories, prepared.includeSecrets);
    if (!equal(current, prepared.local)) throw new Error('configuration_changed');
    const merged: Document = { schema: 2, fields: { ...prepared.remote.fields }, deleted: [...prepared.remote.deleted], secretKeys: [...new Set([...prepared.remote.secretKeys, ...prepared.local.secretKeys])] };
    const deleted = new Set(merged.deleted);
    for (const row of prepared.preview.rows) {
      const side = mode === 'merge' ? row.kind === 'conflict' ? choices[row.key] : row.kind === 'local' ? 'local' : 'cloud' : mode;
      const source = side === 'local' ? prepared.local.fields : prepared.remote.fields;
      if (OWN(source, row.key)) { merged.fields[row.key] = source[row.key]; deleted.delete(row.key); }
      else { delete merged.fields[row.key]; deleted.add(row.key); }
    }
    // Entity deletion also erases old encrypted secrets when secret upload is off.
    for (const marker of [...deleted]) {
      if (!/^(ai\/(profiles|prompts)\/[^/]+|webdav\/connection)\/present$/.test(marker)) continue;
      const prefix = marker.slice(0, -'present'.length);
      for (const key of new Set([...Object.keys(merged.fields), ...Object.keys(prepared.local.fields), ...Object.keys(this.stored.baseline?.fields ?? {})])) {
        if (key.startsWith(prefix)) { delete merged.fields[key]; deleted.add(key); }
      }
    }
    merged.deleted = [...deleted].sort();
    const account = this.identity();
    if (!this.key) throw new Error('unlock_required');
    const envelope = await encryptConfiguration(merged, this.key, account.endpoint, account.user_id, 'cloud');
    // Persist a complete recoverable copy before either side is modified.
    this.stored.backup = { snapshot: await this.adapter.captureConfiguration(prepared.categories, true), categories: prepared.categories };
    this.stored.pending = prepared.local;
    await this.persist();
    const committed = readCloud(await this.transport.request('PUT', '/v1/config', { base_revision: prepared.cloud.revision, envelope }));
    // If editing continued while the request ran, keep the baseline for the next merge.
    const latest = await this.adapter.captureConfiguration(prepared.categories, prepared.includeSecrets);
    if (!equal(latest, prepared.local)) throw new Error('configuration_changed');
    const selected: Fields = {};
    const secrets = new Set(merged.secretKeys);
    for (const [key, value] of Object.entries(merged.fields)) if (prepared.categories.some((category) => key.startsWith(`${category}/`)) && (prepared.includeSecrets || !secrets.has(key))) selected[key] = value;
    await this.adapter.applyConfiguration(selected, prepared.categories, prepared.includeSecrets);
    this.stored.baseline = merged;
    this.stored.revision = committed.revision;
    this.stored.categories = prepared.categories;
    this.stored.includeSecrets = prepared.includeSecrets;
    this.stored.configured = true;
    this.stored.pending = null;
    this.prepared = null;
    await this.persist();
    this.update({ state: this.stored.enabled ? 'ready' : 'disabled', preview: null });
  }

  async commit(mode: 'merge' | 'local' | 'cloud', choices: Record<string, Choice> = {}): Promise<void> {
    await this.operation(() => this.applyPrepared(mode, choices));
  }

  async enable(): Promise<void> {
    await this.operation(async () => {
      if (!this.stored.configured || !this.stored.categories.length) throw new Error('sync_not_configured');
      this.stored.enabled = true; await this.persist(); this.update({ state: 'ready' });
    });
  }

  async disable(): Promise<void> {
    await this.operation(async () => {
      this.stored.enabled = false; await this.persist(); this.update({ state: 'disabled' });
    });
  }

  async sync(): Promise<void> {
    if (!this.stored.enabled || !this.key || this.running || this.prepared) return;
    await this.operation(async () => {
      const { categories, includeSecrets } = this.stored;
      const local = await this.adapter.captureConfiguration(categories, includeSecrets);
      this.stored.pending = local;
      await this.persist();
      this.update({ state: 'pending' });
      const cloud = readCloud(await this.transport.request('GET', '/v1/config'));
      const remote = await this.decodeRemote(cloud);
      const preview = configurationPreview(local, remote, this.stored.baseline, categories, includeSecrets, this.adapter.fieldLabel);
      if (preview.rows.every((row) => row.kind === 'same')) {
        this.stored.baseline = remote; this.stored.revision = cloud.revision; this.stored.pending = null;
        await this.persist(); this.update({ state: 'ready' }); return;
      }
      this.prepared = { cloud, remote, local, categories, includeSecrets, preview };
      this.update({ state: 'preview', preview });
      if (!preview.conflicts.length) await this.applyPrepared('merge', {});
    });
  }

  async restoreBackup(): Promise<void> {
    await this.operation(async () => {
      const backup = this.stored.backup;
      if (!backup) throw new Error('sync_not_configured');
      // Disable before restore so the restored version is never immediately uploaded.
      this.stored.enabled = false;
      await this.persist();
      await this.adapter.applyConfiguration(backup.snapshot.fields, backup.categories, true);
      this.prepared = null; this.stored.pending = null;
      await this.persist(); this.update({ state: 'disabled', preview: null });
    });
  }

  async devices(): Promise<Device[]> {
    return this.operation(async () => {
      const result = await this.transport.request('GET', '/v1/devices') as { devices: Device[] };
      if (!Array.isArray(result?.devices) || result.devices.some((device) => typeof device.id !== 'string' || typeof device.name !== 'string' || typeof device.current !== 'boolean')) throw new Error('unsupported_schema');
      return result.devices;
    });
  }

  async revokeDevice(id: string): Promise<void> {
    await this.operation(async () => {
      await this.transport.request('DELETE', `/v1/devices/${encodeURIComponent(id)}`);
      if (id === this.identity().device_id) await this.forgetLocal(true);
    });
  }

  private async forgetLocal(keepConnections: boolean): Promise<void> {
    if (!keepConnections) await this.adapter.removeRestoredConnections();
    await this.transport.forget();
    this.key = null; this.prepared = null; this.stored = EMPTY_STATE();
    this.update({ account: null, state: 'signed_out', preview: null });
  }

  async logout(keepConnections: boolean): Promise<void> {
    await this.operation(async () => {
      try { await this.transport.request('POST', '/v1/logout'); } catch { /* Device cleanup also works offline. */ }
      await this.forgetLocal(keepConnections);
    });
  }

  async deleteAccount(password: string, keepConnections: boolean): Promise<void> {
    await this.operation(async () => {
      await this.transport.request('DELETE', '/v1/account', { password });
      await this.forgetLocal(keepConnections);
    });
  }

  start(): () => void {
    let disposed = false;
    const sync = () => { if (!disposed) void this.sync().catch(() => {}); };
    void this.initialize().then(() => { if (!disposed) sync(); }).catch(() => {});
    const timer = setInterval(sync, 30_000);
    window.addEventListener('online', sync);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('online', sync); };
  }
}

export const accountSync = new AccountSync(configuration);
