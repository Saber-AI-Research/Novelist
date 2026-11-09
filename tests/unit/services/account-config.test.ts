// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { WebdavConfiguration } from '$lib/services/account-config-native';

const native = vi.hoisted(() => ({
  secrets: new Map<string, string>(), journal: null as string | null,
  vaultUnavailable: false, journalUnavailable: false,
  webdav: null as WebdavConfiguration | null,
}));
const state = vi.hoisted(() => ({
  mobile: false,
  global: {
    view: { sort_mode: 'numeric-asc', show_hidden_files: false, wrap_file_names: false, sidebar_font_size: 14 },
    new_file: { template: '第{N}章-{title}', detect_from_folder: true, auto_rename_from_h1: true, default_dir: '/device/pinned', last_used_dir: '/device/recent' },
    plugins: { enabled: { canvas: true } }, snapshot: { max_count: 100, min_interval_minutes: 60 },
    pandoc_path: '/device/pandoc', publish: { token: 'not-selected' }, image_hosts: { secret: 'not-selected' },
  },
}));
vi.mock('$lib/services/account-config-native', () => ({
  getConfigurationSecret: vi.fn(async (key: string) => { if (native.vaultUnavailable) throw new Error('vault unavailable'); return native.secrets.get(key) ?? null; }),
  setConfigurationSecret: vi.fn(async (key: string, value: string | null) => { if (native.vaultUnavailable) throw new Error('vault unavailable'); if (value === null) native.secrets.delete(key); else native.secrets.set(key, value); }),
  loadRestoreJournal: vi.fn(async () => native.journal),
  saveRestoreJournal: vi.fn(async (value: string) => { if (native.journalUnavailable) throw new Error('journal unavailable'); native.journal = value; return null; }),
  clearRestoreJournal: vi.fn(async () => { native.journal = null; return null; }),
  captureWebdav: vi.fn(async (includeSecrets: boolean) => native.webdav ? { ...native.webdav, password: includeSecrets ? native.webdav.password : null } : null),
  restoreWebdav: vi.fn(async (value: typeof native.webdav, preservePassword = false) => {
    const current = native.webdav;
    const same = value && current && value.endpoint === current.endpoint && value.username === current.username && value.remote_directory === current.remote_directory;
    native.webdav = value && preservePassword && same ? { ...value, password: current.password } : value;
  }),
  removeRestoredWebdav: vi.fn(async () => { if (native.webdav?.restored) native.webdav = null; }),
}));
vi.mock('$lib/ipc/commands', () => ({ commands: {
  getGlobalSettings: vi.fn(async () => ({ status: 'ok', data: structuredClone(state.global) })),
  writeGlobalSettings: vi.fn(async (view: unknown, newFile: unknown, plugins: unknown, snapshot: unknown) => { Object.assign(state.global, { view, new_file: newFile, plugins, snapshot }); return { status: 'ok', data: null }; }),
} }));
vi.mock('$lib/stores/settings.svelte', () => ({ settingsStore: { refreshGlobalDefaults: vi.fn(async () => undefined) } }));
vi.mock('$lib/stores/platform.svelte', () => ({ platform: { ready: true, get isMobile() { return state.mobile; }, can: () => !state.mobile } }));
vi.mock('$lib/themes', () => ({ getThemeById: (id: string) => id === 'light' ? { id } : undefined }));
vi.mock('$lib/i18n', () => ({ i18n: { locale: 'en', setLocale: vi.fn(async function(this: { locale: string }, locale: string) { this.locale = locale; localStorage.setItem('novelist-locale', locale); }) } }));
vi.mock('$lib/stores/ui.svelte', () => {
  const defaults = { fontFamily: 'Georgia', fontSize: 16, lineHeight: 1.8, maxWidth: 720, autoSaveMinutes: 5, indentStyle: 4, highlightMatches: true, renderImages: true };
  return { uiStore: { editorDefaults: defaults, editorSettings: { ...defaults }, themeId: 'system', sidebarWidth: 999, windowPosition: { x: 1, y: 2 }, updateEditorSettings: vi.fn(function(this: { editorSettings: object }, value: object) { this.editorSettings = { ...this.editorSettings, ...value }; localStorage.setItem('novelist-settings', JSON.stringify(this.editorSettings)); }), setTheme: vi.fn(function(this: { themeId: string }, value: string) { this.themeId = value; localStorage.setItem('novelist-theme', value); }) } };
});

import { aiTalkSettings, type AiTalkSettings } from '$lib/components/ai-talk/settings.svelte';
import { promptPresets } from '$lib/components/ai-talk/presets.svelte';
import { shortcutsStore } from '$lib/stores/shortcuts.svelte';
import { commands } from '$lib/ipc/commands';
import { uiStore } from '$lib/stores/ui.svelte';
import { captureConfiguration, applyConfiguration, recoverConfiguration, removeRestoredConnections, fieldLabel, type Fields } from '$lib/services/account-config';
import { saveRestoreJournal, clearRestoreJournal, setConfigurationSecret, restoreWebdav } from '$lib/services/account-config-native';

function initialAi(): AiTalkSettings {
  return { activeProfileId: 'openai', profiles: [{ id: 'openai', label: 'Local provider', baseUrl: 'https://api.example.test/v1', apiKey: 'local-key', model: 'local-model', temperature: 0.7 }], baseUrl: 'https://api.example.test/v1', apiKey: 'local-key', model: 'local-model', temperature: 0.7, systemPrompt: 'Keep my writing voice.', includeCurrentFile: false, includeSelection: true };
}
function profileFields(): Fields {
  return { 'ai/activeProfileId': 'openai', 'ai/profiles/openai/present': true, 'ai/profiles/openai/label': 'Cloud provider', 'ai/profiles/openai/baseUrl': 'https://api.example.test/v1', 'ai/profiles/openai/model': 'cloud-model', 'ai/profiles/openai/temperature': 0.4 };
}

beforeEach(async () => {
  await aiTalkSettings.flushSecretWrites();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  native.secrets.clear(); native.journal = null; native.vaultUnavailable = false; native.journalUnavailable = false; native.webdav = null;
  state.mobile = false;
  aiTalkSettings.replaceFromAccount(initialAi(), { profiles: [], urls: [] });
  promptPresets.replaceFromAccount([], []);
  shortcutsStore.replaceFromAccount({});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('[contract] account configuration adapter', () => {
  it('lists omitted secret slots and never captures credentials in URLs or headers as ordinary fields', async () => {
    const settings = initialAi();
    settings.profiles[0].baseUrl = 'https://user:password@api.example.test/v1?token=url-secret';
    Object.assign(settings.profiles[0], { headers: { Authorization: 'Bearer header-secret' } });
    aiTalkSettings.replaceFromAccount(settings, { profiles: ['openai'], urls: ['openai'] });
    native.secrets.set('ai:openai', 'local-key');
    native.secrets.set('ai-url:openai', settings.profiles[0].baseUrl);
    const captured = await captureConfiguration(['ai'], false);
    expect(captured.secretKeys).toEqual(expect.arrayContaining(['ai/profiles/openai/apiKey', 'ai/profiles/openai/baseUrl', 'ai/profiles/openai/headers']));
    expect(JSON.stringify(captured.fields)).not.toMatch(/local-key|url-secret|header-secret|user:password/);
    expect(fieldLabel('ai/profiles/openai/apiKey')).toBe('AI · API key');
  });

  it('keeps same-profile local secrets when ordinary configuration is restored', async () => {
    aiTalkSettings.replaceFromAccount(initialAi(), { profiles: ['openai'], urls: [] });
    native.secrets.set('ai:openai', 'local-key');
    await applyConfiguration({ ...profileFields(), 'ai/profiles/openai/apiKey': 'must-not-import' }, ['ai'], false);
    expect(aiTalkSettings.value.apiKey).toBe('local-key');
    expect(aiTalkSettings.value.model).toBe('cloud-model');
    expect(native.secrets.get('ai:openai')).toBe('local-key');
    expect(JSON.stringify([...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index)!)))).not.toContain('local-key');
    expect(setConfigurationSecret).not.toHaveBeenCalled();
  });

  it('stores restored API keys in the vault and keeps direct settings edits local when the vault is unavailable', async () => {
    await applyConfiguration({ ...profileFields(), 'ai/profiles/openai/apiKey': 'restored-key' }, ['ai'], true);
    expect(native.secrets.get('ai:openai')).toBe('restored-key');
    expect(localStorage.getItem('novelist:ai-talk:settings:v1')).not.toContain('restored-key');
    native.vaultUnavailable = true;
    expect(() => aiTalkSettings.update({ model: 'offline-model', apiKey: 'memory-only-key' })).not.toThrow();
    await aiTalkSettings.flushSecretWrites();
    expect(aiTalkSettings.value.model).toBe('offline-model');
    expect(aiTalkSettings.value.apiKey).toBe('memory-only-key');
    expect(localStorage.getItem('novelist:ai-talk:settings:v1')).toContain('offline-model');
    expect(localStorage.getItem('novelist:ai-talk:settings:v1')).not.toContain('memory-only-key');
    expect(aiTalkSettings.credentialError).toBe('secure_storage_unavailable');
  });

  it('keeps deletion authoritative and never revives an API-key-only orphan', async () => {
    await applyConfiguration({ 'ai/activeProfileId': '', 'ai/profiles/openai/apiKey': 'orphan-key' }, ['ai'], true);
    expect(aiTalkSettings.value.profiles).toEqual([]);
    expect(aiTalkSettings.value.apiKey).toBe('');
    const captured = await captureConfiguration(['ai'], true);
    expect(captured.fields).not.toHaveProperty('ai/profiles/openai/present');
    expect(captured.fields['ai/profiles/openai/apiKey']).toBe('orphan-key');
    expect(captured.secretKeys).toContain('ai/profiles/openai/apiKey');
    expect(localStorage.getItem('novelist:ai-talk:settings:v1')).not.toContain('orphan-key');
  });

  it('captures global preference allowlists without paths, project data or window coordinates', async () => {
    const captured = await captureConfiguration(['preferences'], false);
    expect(captured.fields['preferences/global/new_file/template']).toBe('第{N}章-{title}');
    expect(captured.fields['preferences/editor/fontSize']).toBe(16);
    expect(JSON.stringify(captured)).not.toMatch(/device\/|default_dir|last_used_dir|pandoc|windowPosition|sidebarWidth|not-selected/);
  });

  it('keeps an unsupported synced theme only until the user picks a theme on this device', async () => {
    uiStore.setTheme('system');
    const base = (await captureConfiguration(['preferences'], false)).fields;
    await applyConfiguration({ ...base, 'preferences/theme': 'custom-x', 'preferences/language': 'xx' }, ['preferences'], false);
    expect(uiStore.themeId).toBe('system');
    let captured = (await captureConfiguration(['preferences'], false)).fields;
    expect(captured['preferences/theme']).toBe('custom-x');
    expect(captured['preferences/language']).toBe('xx');
    uiStore.setTheme('light');
    captured = (await captureConfiguration(['preferences'], false)).fields;
    expect(captured['preferences/theme']).toBe('light');
    expect(captured['preferences/language']).toBe('xx');
  });

  it('preserves device paths while changing global defaults', async () => {
    await applyConfiguration({ 'preferences/global/new_file/template': 'Chapter {N}-{title}' }, ['preferences'], false);
    expect(state.global.new_file).toMatchObject({ template: 'Chapter {N}-{title}', default_dir: '/device/pinned', last_used_dir: '/device/recent' });
  });

  it('retains desktop shortcuts on mobile without adding incompatible active bindings', async () => {
    state.mobile = true;
    await applyConfiguration({ 'shortcuts/open-file': 'Cmd+Shift+O', 'shortcuts/toggle-sidebar': 'Cmd+B' }, ['shortcuts'], false);
    expect(shortcutsStore.overrides['open-file']).toBeUndefined();
    expect(shortcutsStore.overrides['toggle-sidebar']).toBe('Cmd+B');
    expect((await captureConfiguration(['shortcuts'], false)).fields['shortcuts/open-file']).toBe('Cmd+Shift+O');
  });

  it('retains unknown authorization headers without applying them or putting them in localStorage', async () => {
    await applyConfiguration({ ...profileFields(), 'ai/profiles/openai/headers': { Authorization: 'Bearer restored-header' } }, ['ai'], true);
    expect(aiTalkSettings.value.profiles[0]).not.toHaveProperty('headers');
    expect(localStorage.getItem('novelist:account:retained-fields:v1')).not.toContain('restored-header');
    expect((await captureConfiguration(['ai'], false)).fields).not.toHaveProperty('ai/profiles/openai/headers');
    expect((await captureConfiguration(['ai'], true)).fields['ai/profiles/openai/headers']).toEqual({ Authorization: 'Bearer restored-header' });
  });

  it('validates every selected category before journal, vault or settings mutation', async () => {
    expect(() => applyConfiguration({ ...profileFields(), 'ai/profiles/openai/temperature': 10, 'preferences/editor/fontSize': 20 }, ['preferences', 'ai'], true)).toThrow('invalid_configuration');
    expect(saveRestoreJournal).not.toHaveBeenCalled();
    expect(setConfigurationSecret).not.toHaveBeenCalled();
    expect(commands.writeGlobalSettings).not.toHaveBeenCalled();
    expect(aiTalkSettings.value.model).toBe('local-model');
  });

  it('does not mutate configuration when recovery journal preparation fails', async () => {
    native.journalUnavailable = true;
    await expect(applyConfiguration({ ...profileFields(), 'ai/profiles/openai/apiKey': 'new-key' }, ['ai'], true)).rejects.toThrow('journal unavailable');
    expect(native.journal).toBeNull();
    expect(setConfigurationSecret).not.toHaveBeenCalled();
    expect(aiTalkSettings.value.apiKey).toBe('local-key');
  });

  it('keeps its recovery journal until settings and vault have both rolled back successfully', async () => {
    native.secrets.set('ai:openai', 'local-key');
    aiTalkSettings.replaceFromAccount(initialAi(), { profiles: ['openai'], urls: [] });
    vi.mocked(clearRestoreJournal).mockImplementationOnce(async () => {
      native.vaultUnavailable = true;
      throw new Error('journal storage failed');
    });
    await expect(applyConfiguration({ ...profileFields(), 'ai/profiles/openai/apiKey': 'new-key' }, ['ai'], true)).rejects.toThrow('configuration_recovery_required');
    expect(native.secrets.get('ai:openai')).toBe('new-key');
    expect(native.journal).not.toBeNull();
    native.vaultUnavailable = false;
    await recoverConfiguration();
    expect(native.secrets.get('ai:openai')).toBe('local-key');
    expect(aiTalkSettings.value.model).toBe('local-model');
    expect(aiTalkSettings.value.apiKey).toBe('local-key');
    expect(native.journal).toBeNull();
  });

  it('preserves matching WebDAV passwords when secrets are excluded and delegates logout to selective removal', async () => {
    native.webdav = { endpoint: 'https://dav.example.test/novels/', remote_directory: '', username: 'writer', password: 'manual-password', connected_at: '2026-01-01T00:00:00Z', restored: false, secure_credential: false };
    await applyConfiguration({ 'webdav/connection/present': true, 'webdav/connection/endpoint': native.webdav.endpoint, 'webdav/connection/username': 'writer', 'webdav/connection/password': 'do-not-import' }, ['webdav'], false);
    expect(native.webdav).toMatchObject({ password: 'manual-password', restored: false, secure_credential: false });
    await removeRestoredConnections();
    expect(native.webdav?.endpoint).toBe('https://dav.example.test/novels/');
  });

  it('restores a chosen application folder as ordinary configuration without credentials', async () => {
    await applyConfiguration({
      'webdav/connection/present': true,
      'webdav/connection/endpoint': 'https://dav.example.test/user/',
      'webdav/connection/username': 'writer',
      'webdav/connection/remote_directory': '写作/长篇',
    }, ['webdav'], false);
    expect(native.webdav?.remote_directory).toBe('写作/长篇');
    const captured = await captureConfiguration(['webdav'], false);
    expect(captured.fields['webdav/connection/remote_directory']).toBe('写作/长篇');
    expect(captured.secretKeys).not.toContain('webdav/connection/remote_directory');
    expect(captured.fields).not.toHaveProperty('webdav/connection/password');
  });

  it('keeps legacy recovered connections at the endpoint root and rejects traversal before mutation', async () => {
    const legacy = {
      'webdav/connection/present': true,
      'webdav/connection/endpoint': 'https://dav.example.test/user/',
      'webdav/connection/username': 'writer',
    };
    await applyConfiguration(legacy, ['webdav'], false);
    expect(native.webdav?.remote_directory).toBe('');
    vi.mocked(saveRestoreJournal).mockClear();
    expect(() => applyConfiguration({ ...legacy, 'webdav/connection/remote_directory': '%2e%2e/another-user' }, ['webdav'], false)).toThrow('invalid_configuration');
    expect(saveRestoreJournal).not.toHaveBeenCalled();
  });

  it('recovers the previous WebDAV password when an ordinary restore fails after replacement', async () => {
    const original: WebdavConfiguration = { endpoint: 'https://dav.example.test/user/', remote_directory: 'Old', username: 'writer', password: 'original-password', connected_at: '2026-01-01T00:00:00Z', restored: true, secure_credential: true };
    native.webdav = { ...original };
    vi.mocked(clearRestoreJournal).mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(applyConfiguration({
      'webdav/connection/present': true,
      'webdav/connection/endpoint': original.endpoint,
      'webdav/connection/username': original.username,
      'webdav/connection/remote_directory': 'New',
    }, ['webdav'], false)).rejects.toThrow('configuration_restore_failed');
    expect(native.webdav).toEqual(original);
    expect(native.journal).toBeNull();
    expect(localStorage.getItem('novelist:account:retained-fields:v1') ?? '').not.toContain('original-password');
  });

  it('removes an imported password when rollback restores a previously passwordless connection', async () => {
    const original: WebdavConfiguration = { endpoint: 'https://dav.example.test/user/', remote_directory: 'Novelist', username: 'writer', password: null, connected_at: '2026-01-01T00:00:00Z', restored: true, secure_credential: true };
    native.webdav = { ...original };
    vi.mocked(clearRestoreJournal).mockRejectedValueOnce(new Error('journal unavailable'));
    await expect(applyConfiguration({
      'webdav/connection/present': true,
      'webdav/connection/endpoint': original.endpoint,
      'webdav/connection/username': original.username,
      'webdav/connection/remote_directory': original.remote_directory,
      'webdav/connection/password': 'imported-password',
    }, ['webdav'], true)).rejects.toThrow('configuration_restore_failed');
    expect(native.webdav).toEqual(original);
    expect(native.journal).toBeNull();
  });

  it('preserves a vaulted API key when ordinary restore starts before startup hydration finishes', async () => {
    vi.resetModules();
    localStorage.setItem('novelist:ai-talk:settings:v1', JSON.stringify({ ...initialAi(), apiKey: '', profiles: [{ ...initialAi().profiles[0], apiKey: '' }] }));
    localStorage.setItem('novelist:ai-talk:vault-profiles:v1', JSON.stringify(['openai']));
    native.secrets.set('ai:openai', 'vaulted-local-key');
    const { promise, resolve: completeRead } = Promise.withResolvers<string>();
    const boundary = await import('$lib/services/account-config-native');
    vi.mocked(boundary.getConfigurationSecret).mockReturnValueOnce(promise);
    // Fresh imports exercise startup hydration against a concurrent restore.
    const { aiTalkSettings: reloaded } = await import('$lib/components/ai-talk/settings.svelte');
    const loading = reloaded.ensureSecrets();
    const adapter = await import('$lib/services/account-config');
    vi.useFakeTimers();
    const restoring = adapter.applyConfiguration(profileFields(), ['ai'], false);
    // Drain the transaction's microtasks while credential hydration remains blocked.
    await vi.runAllTimersAsync();
    reloaded.update({ model: 'edited-before-hydration' });
    await reloaded.flushSecretWrites();
    completeRead('vaulted-local-key');
    await loading;
    await restoring;
    vi.useRealTimers();
    expect(reloaded.value.apiKey).toBe('vaulted-local-key');
    expect(reloaded.value.model).toBe('cloud-model');
    expect(native.secrets.get('ai:openai')).toBe('vaulted-local-key');
    expect(localStorage.getItem('novelist:ai-talk:settings:v1')).not.toContain('vaulted-local-key');
  });
});
