import { commands, type ViewConfig, type NewFileConfig, type PluginsConfig, type SnapshotConfig } from '$lib/ipc/commands';
import { aiTalkSettings, type AiTalkSettings, type AiTalkProviderProfile, type AiTalkCredentialStorage } from '$lib/components/ai-talk/settings.svelte';
import { promptPresets, BUILTIN_PRESETS, type PromptPreset } from '$lib/components/ai-talk/presets.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { shortcutsStore } from '$lib/stores/shortcuts.svelte';
import { platform } from '$lib/stores/platform.svelte';
import { i18n } from '$lib/i18n';
import { getThemeById } from '$lib/themes';
import {
  getConfigurationSecret, setConfigurationSecret, loadRestoreJournal, saveRestoreJournal,
  clearRestoreJournal, captureWebdav, restoreWebdav, removeRestoredWebdav,
  type WebdavConfiguration,
} from './account-config-native';
import type { Category, Fields, Snapshot } from './account-sync';
import type { JsonValue } from './account-crypto';
import { normalizeWebdavDirectory } from './webdav-directory';
export type { Category, Fields, Snapshot, JsonValue };

const RETAINED_KEY = 'novelist:account:retained-fields:v1';
const RETAINED_SECRET_KEYS = 'novelist:account:retained-secret-keys:v1';
// The local theme/language that was active when an unsupported synced value
// was retained. Once the local value moves away from it, the user's choice wins.
const RETAINED_FALLBACKS = 'novelist:account:retained-fallbacks:v1';
const STORAGE_KEYS = [
  'novelist-settings', 'novelist-theme', 'novelist-locale', 'novelist-shortcuts',
  'novelist:ai-talk:settings:v1', 'novelist:ai-talk:vault-profiles:v1', 'novelist:ai-talk:vault-urls:v1',
  'novelist:ai-talk:prompt-presets:v1', 'novelist:ai-talk:hidden-builtin-presets:v1',
  RETAINED_KEY, RETAINED_SECRET_KEYS, RETAINED_FALLBACKS,
];
const CATEGORIES: Category[] = ['preferences', 'shortcuts', 'ai', 'webdav'];
const EDITOR_FIELDS = ['fontFamily', 'fontSize', 'lineHeight', 'maxWidth', 'autoSaveMinutes', 'indentStyle', 'highlightMatches', 'renderImages'] as const;
const VIEW_FIELDS = ['sort_mode', 'show_hidden_files', 'wrap_file_names', 'sidebar_font_size'] as const;
const NEW_FILE_FIELDS = ['template', 'detect_from_folder', 'auto_rename_from_h1'] as const;
const SNAPSHOT_FIELDS = ['max_count', 'min_interval_minutes'] as const;
const PROFILE_FIELDS = ['label', 'baseUrl', 'model', 'temperature', 'custom'] as const;
const PROMPT_FIELDS = ['name', 'systemPrompt', 'icon', 'temperature', 'model'] as const;
const SORT_MODES = ['name-asc', 'name-desc', 'numeric-asc', 'numeric-desc', 'mtime-asc', 'mtime-desc', 'ctime-asc', 'ctime-desc'];

function invalid(): never { throw new Error('invalid_configuration'); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function own(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function selected(key: string, categories: Category[]): boolean { return categories.some((category) => key.startsWith(`${category}/`)); }
function string(value: unknown, max = 65_536): value is string { return typeof value === 'string' && value.length <= max; }
function number(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function idPart(id: string): string { if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) invalid(); return encodeURIComponent(id); }
function decodeId(value: string): string { try { const id = decodeURIComponent(value); if (idPart(id) !== value) invalid(); return id; } catch { return invalid(); } }
function safeUrl(value: string): boolean {
  if (!value) return true;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
}
function validAiUrl(value: unknown): value is string {
  if (!string(value, 8192)) return false;
  if (!value) return true;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}
function validShortcut(value: unknown): value is string {
  return string(value, 128) && (value === '' || /^(?:(?:Cmd|Ctrl|Alt|Shift)\+)*(?:[^+\s]|[A-Za-z][A-Za-z0-9]*)$/u.test(value));
}
function canApplyShortcut(id: string): boolean {
  if (!shortcutsStore.allCommandIds.includes(id)) return false;
  if (!platform.ready) return false;
  if (id === 'open-directory') return platform.can('pick_directory');
  if (['open-file', 'toggle-devtools', 'toggle-split'].includes(id)) return !platform.isMobile;
  return true;
}
function readRetained(): Fields {
  const value: unknown = JSON.parse(localStorage.getItem(RETAINED_KEY) ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Fields;
}
function readRetainedFallbacks(): Record<string, string> {
  const value: unknown = JSON.parse(localStorage.getItem(RETAINED_FALLBACKS) ?? '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.values(value).every((item) => string(item, 256))) invalid();
  return value as Record<string, string>;
}
function readRetainedSecretKeys(): string[] {
  const value: unknown = JSON.parse(localStorage.getItem(RETAINED_SECRET_KEYS) ?? '[]');
  if (!Array.isArray(value) || !value.every((key) => string(key, 512))) invalid();
  return value;
}
async function retainedSlot(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `retained:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function knownField(key: string): boolean {
  if (['preferences/theme', 'preferences/language', 'ai/activeProfileId', 'ai/systemPrompt', 'ai/includeCurrentFile', 'ai/includeSelection'].includes(key)) return true;
  if (EDITOR_FIELDS.some((field) => key === `preferences/editor/${field}`)) return true;
  if (VIEW_FIELDS.some((field) => key === `preferences/global/view/${field}`)) return true;
  if (NEW_FILE_FIELDS.some((field) => key === `preferences/global/new_file/${field}`)) return true;
  if (SNAPSHOT_FIELDS.some((field) => key === `preferences/global/snapshot/${field}`)) return true;
  if (/^preferences\/global\/plugins\/[^/]+$/u.test(key)) return true;
  if (/^shortcuts\/[^/]+$/u.test(key)) return true;
  if (/^ai\/profiles\/[^/]+\/(present|label|baseUrl|apiKey|model|temperature|custom)$/u.test(key)) return true;
  if (/^ai\/prompts\/[^/]+\/(present|name|systemPrompt|icon|temperature|model)$/u.test(key)) return true;
  if (/^ai\/hiddenPrompts\/[^/]+$/u.test(key)) return true;
  return ['webdav/connection/present', 'webdav/connection/endpoint', 'webdav/connection/username', 'webdav/connection/password', 'webdav/connection/remote_directory'].includes(key);
}

function validateFields(fields: Fields, categories: Category[], includeSecrets: boolean): void {
  if (!Array.isArray(categories) || categories.some((category) => !CATEGORIES.includes(category)) || new Set(categories).size !== categories.length || typeof includeSecrets !== 'boolean') invalid();
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 4096) invalid();
  const validateJson = (value: unknown, depth = 0): void => {
    if (depth > 24) invalid();
    if (value === null || typeof value === 'boolean' || string(value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) { value.forEach((item) => validateJson(item, depth + 1)); return; }
    if (!value || typeof value !== 'object') invalid();
    for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid(); validateJson(item, depth + 1); }
  };
  validateJson(fields);
  if (new TextEncoder().encode(JSON.stringify(fields)).length > 524_288) invalid();
  for (const [key, value] of Object.entries(fields)) {
    if (new TextEncoder().encode(key).length > 512 || /[\u0000-\u001f\u007f]/u.test(key) || !CATEGORIES.some((category) => key.startsWith(`${category}/`))) invalid();
    if (/(?:^|\/)(?:default_dir|last_used_dir|pandoc_path|project|projects|projectConfig|baseline|baselines|window|windowPosition|devicePath|localPath)(?:\/|$)/iu.test(key)) invalid();
    if (!selected(key, categories)) continue;
    if (!knownField(key)) { if (new TextEncoder().encode(JSON.stringify(value)).length > 8192) invalid(); continue; }
    if (key.startsWith('shortcuts/')) { decodeId(key.slice(10)); if (!validShortcut(value)) invalid(); continue; }
    if (key.startsWith('preferences/editor/')) {
      const field = key.slice(19);
      if (field === 'fontFamily' ? !string(value, 1024) : field === 'indentStyle' ? !(value === 'tab' || [2, 4, 8].includes(value as number)) : ['highlightMatches', 'renderImages'].includes(field) ? typeof value !== 'boolean' : !number(value, field === 'autoSaveMinutes' ? 0 : 1, field === 'lineHeight' ? 5 : field === 'maxWidth' ? 4096 : field === 'autoSaveMinutes' ? 10080 : 128)) invalid();
    } else if (key === 'preferences/theme' || key === 'preferences/language') { if (!string(value, 256)) invalid(); }
    else if (key.includes('/global/view/')) {
      const field = key.split('/').at(-1);
      if (field === 'sort_mode' ? !string(value, 64) || !SORT_MODES.includes(value) : field === 'sidebar_font_size' ? !number(value, 12, 18) || !Number.isInteger(value) : typeof value !== 'boolean') invalid();
    } else if (key.includes('/global/new_file/')) { if (key.endsWith('/template') ? !string(value, 4096) : typeof value !== 'boolean') invalid(); }
    else if (key.includes('/global/snapshot/')) { if (!number(value, 0, 4_294_967_295) || !Number.isInteger(value)) invalid(); }
    else if (key.includes('/global/plugins/')) { decodeId(key.split('/').at(-1)!); if (typeof value !== 'boolean') invalid(); }
    else if (/^ai\/(profiles|prompts)\//u.test(key)) {
      const [, group, encoded, field] = key.split('/'); decodeId(encoded);
      if (field === 'present' ? value !== true : field === 'temperature' ? !number(value, 0, 2) : field === 'custom' ? typeof value !== 'boolean' : field === 'baseUrl' ? !validAiUrl(value) : !string(value, field === 'apiKey' ? 8192 : 65_536)) invalid();
      if (fields[`ai/${group}/${encoded}/present`] !== true && !(group === 'profiles' && (field === 'apiKey' || (field === 'baseUrl' && !safeUrl(value as string))))) invalid();
    } else if (key.startsWith('ai/hiddenPrompts/')) { decodeId(key.slice(17)); if (value !== true) invalid(); }
    else if (key === 'ai/activeProfileId' || key === 'ai/systemPrompt') { if (!string(value)) invalid(); }
    else if (key === 'ai/includeCurrentFile' || key === 'ai/includeSelection') { if (typeof value !== 'boolean') invalid(); }
    else if (key.startsWith('webdav/')) {
      if (key.endsWith('/present')) { if (value !== true) invalid(); }
      else if (!string(value, key.endsWith('/password') ? 1024 : 2048)) invalid();
    }
  }
  if (categories.includes('ai') && typeof fields['ai/activeProfileId'] === 'string' && fields['ai/activeProfileId'] !== '' && fields[`ai/profiles/${idPart(fields['ai/activeProfileId'])}/present`] !== true) invalid();
  if (categories.includes('webdav')) {
    const present = fields['webdav/connection/present'];
    const endpoint = fields['webdav/connection/endpoint'];
    const username = fields['webdav/connection/username'];
    const directory = fields['webdav/connection/remote_directory'] ?? '';
    if (present === true) {
      if (!string(endpoint, 2048) || !endpoint || endpoint !== endpoint.trim() || /\p{Cc}/u.test(endpoint) || new TextEncoder().encode(endpoint).length > 2048 || !safeUrl(endpoint) || !string(username, 256) || new TextEncoder().encode(username).length > 256 || !username.trim() || username !== username.trim() || /:|\p{Cc}/u.test(username)) invalid();
      if (!string(directory, 512)) invalid();
      try { if (normalizeWebdavDirectory(directory) !== directory) invalid(); } catch { invalid(); }
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) invalid();
      const password = fields['webdav/connection/password'];
      if (includeSecrets && password !== undefined && (!string(password, 1024) || new TextEncoder().encode(password).length > 1024 || !password || /\p{Cc}/u.test(password))) invalid();
    } else if (Object.keys(fields).some((key) => key.startsWith('webdav/connection/') && key !== 'webdav/connection/password' && knownField(key))) invalid();
  }
}

let transaction: Promise<void> = Promise.resolve();
function exclusive<T>(run: () => Promise<T>): Promise<T> {
  const result = transaction.then(run, run);
  transaction = result.then(() => undefined, () => undefined);
  return result;
}

async function capture(categories: Category[], includeSecrets: boolean): Promise<Snapshot> {
  validateFields({}, categories, includeSecrets);
  const fields: Fields = Object.create(null);
  const secretKeys = new Set<string>();
  for (const [key, value] of Object.entries(readRetained())) if (selected(key, categories)) fields[key] = value;
  for (const key of readRetainedSecretKeys()) {
    if (!selected(key, categories)) continue;
    secretKeys.add(key);
    if (includeSecrets) { const raw = await getConfigurationSecret(await retainedSlot(key)); if (raw !== null) fields[key] = JSON.parse(raw) as JsonValue; }
  }
  if (categories.includes('preferences')) {
    const result = await commands.getGlobalSettings();
    if (result.status !== 'ok') throw new Error('settings_capture_failed');
    for (const field of EDITOR_FIELDS) fields[`preferences/editor/${field}`] = uiStore.editorSettings[field];
    const fallbacks = readRetainedFallbacks();
    for (const [key, local] of [['preferences/theme', uiStore.themeId], ['preferences/language', i18n.locale]] as const) {
      // A retained value stands in for the local one only while the local
      // value is still the fallback applied with it.
      if (!own(fields, key) || (own(fallbacks, key) && fallbacks[key] !== local)) fields[key] = local;
    }
    for (const [section, names] of [['view', VIEW_FIELDS], ['new_file', NEW_FILE_FIELDS], ['snapshot', SNAPSHOT_FIELDS]] as const) {
      for (const field of names) { const value = (result.data[section] as Record<string, JsonValue>)[field]; if (value !== undefined && value !== null) fields[`preferences/global/${section}/${field}`] = value; }
    }
    for (const [id, enabled] of Object.entries(result.data.plugins.enabled ?? {})) fields[`preferences/global/plugins/${idPart(id)}`] = enabled;
  }
  if (categories.includes('shortcuts')) {
    for (const [id, binding] of Object.entries(shortcutsStore.overrides)) {
      const key = `shortcuts/${idPart(id)}`;
      if (!own(fields, key) || canApplyShortcut(id)) fields[key] = binding;
    }
  }
  if (categories.includes('ai')) {
    if (includeSecrets) await aiTalkSettings.ensureSecrets();
    await aiTalkSettings.flushSecretWrites();
    const value = aiTalkSettings.value;
    fields['ai/activeProfileId'] = value.activeProfileId;
    fields['ai/systemPrompt'] = value.systemPrompt;
    fields['ai/includeCurrentFile'] = value.includeCurrentFile;
    fields['ai/includeSelection'] = value.includeSelection;
    for (const [field, item] of Object.entries(value)) {
      if (['activeProfileId', 'profiles', 'baseUrl', 'apiKey', 'model', 'temperature', 'systemPrompt', 'includeCurrentFile', 'includeSelection'].includes(field)) continue;
      const key = `ai/extra/${idPart(field)}`;
      secretKeys.add(key); if (includeSecrets) fields[key] = clone(item) as JsonValue;
    }
    const protectedUrls = new Set(aiTalkSettings.accountStorageState().urls);
    for (const profile of value.profiles) {
      const prefix = `ai/profiles/${idPart(profile.id)}`;
      fields[`${prefix}/present`] = true;
      for (const field of PROFILE_FIELDS) {
        const item = profile[field];
        if (item === undefined) continue;
        if (field === 'baseUrl' && (!safeUrl(profile.baseUrl) || protectedUrls.has(profile.id))) { secretKeys.add(`${prefix}/${field}`); if (includeSecrets) fields[`${prefix}/${field}`] = item; }
        else fields[`${prefix}/${field}`] = item;
      }
      secretKeys.add(`${prefix}/apiKey`);
      if (includeSecrets && profile.apiKey) fields[`${prefix}/apiKey`] = profile.apiKey;
      for (const [field, item] of Object.entries(profile)) {
        if (['id', 'apiKey', ...PROFILE_FIELDS].includes(field)) continue;
        const key = `${prefix}/${idPart(field)}`; secretKeys.add(key); if (includeSecrets) fields[key] = clone(item) as JsonValue;
      }
    }
    for (const preset of promptPresets.userPresets) {
      const prefix = `ai/prompts/${idPart(preset.id)}`; fields[`${prefix}/present`] = true;
      for (const field of PROMPT_FIELDS) { const item = preset[field]; if (item !== undefined && typeof item !== 'function') fields[`${prefix}/${field}`] = item as JsonValue; }
      for (const [field, item] of Object.entries(preset)) {
        if (['id', 'builtin', ...PROMPT_FIELDS].includes(field) || typeof item === 'function') continue;
        const key = `${prefix}/${idPart(field)}`; secretKeys.add(key); if (includeSecrets) fields[key] = clone(item) as JsonValue;
      }
    }
    for (const id of promptPresets.hiddenBuiltins) fields[`ai/hiddenPrompts/${idPart(id)}`] = true;
  }
  if (categories.includes('webdav')) {
    secretKeys.add('webdav/connection/password');
    const config = await captureWebdav(includeSecrets);
    if (config) {
      fields['webdav/connection/present'] = true;
      fields['webdav/connection/endpoint'] = config.endpoint;
      fields['webdav/connection/username'] = config.username;
      fields['webdav/connection/remote_directory'] = config.remote_directory;
      if (includeSecrets && config.password) fields['webdav/connection/password'] = config.password;
    }
  }
  return { fields, secretKeys: [...secretKeys] };
}

export function captureConfiguration(categories: Category[], includeSecrets: boolean): Promise<Snapshot> {
  return exclusive(async () => { await recover(); return capture(categories, includeSecrets); });
}

type GlobalSections = { view: ViewConfig | null; new_file: NewFileConfig | null; plugins: PluginsConfig | null; snapshot: SnapshotConfig | null };
type AiStorage = AiTalkCredentialStorage;
type Undo = {
  version: 1;
  storage: Record<string, string | null>;
  secrets: Record<string, string | null>;
  preferences?: { global: GlobalSections; editor: typeof uiStore.editorSettings; theme: string; language: 'en' | 'zh-CN' };
  shortcuts?: Record<string, string>;
  ai?: { value: AiTalkSettings; storage: AiStorage; presets: PromptPreset[]; hidden: string[] };
  webdav?: { configuration: WebdavConfiguration | null };
};

async function writeGlobal(sections: GlobalSections): Promise<void> {
  const result = await commands.writeGlobalSettings(sections.view, sections.new_file, sections.plugins, sections.snapshot);
  if (result.status !== 'ok') throw new Error('settings_restore_failed');
}
async function rollback(undo: Undo): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (run: () => void | Promise<void>) => { try { await run(); } catch (error) { errors.push(error); } };
  for (const [slot, value] of Object.entries(undo.secrets)) await attempt(() => setConfigurationSecret(slot, value));
  if (undo.preferences) {
    const prefs = undo.preferences;
    await attempt(() => writeGlobal(prefs.global));
    await attempt(() => { uiStore.updateEditorSettings(prefs.editor); uiStore.setTheme(prefs.theme); });
    await attempt(() => i18n.setLocale(prefs.language));
    await attempt(() => settingsStore.refreshGlobalDefaults());
  }
  if (undo.webdav) await attempt(() => restoreWebdav(undo.webdav!.configuration));
  if (undo.shortcuts) await attempt(() => shortcutsStore.replaceFromAccount(undo.shortcuts!));
  if (undo.ai) {
    const ai = undo.ai;
    await attempt(() => aiTalkSettings.replaceFromAccount(ai.value, ai.storage));
    await attempt(() => promptPresets.replaceFromAccount(ai.presets, ai.hidden));
  }
  for (const [key, value] of Object.entries(undo.storage)) await attempt(() => { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); });
  if (errors.length) throw new Error('configuration_recovery_required');
}
async function recover(): Promise<void> {
  const raw = await loadRestoreJournal();
  if (raw === null) return;
  let undo: Undo;
  try { undo = JSON.parse(raw) as Undo; if (undo.version !== 1 || !undo.storage || !undo.secrets) invalid(); }
  catch { throw new Error('configuration_recovery_required'); }
  await rollback(undo);
  await clearRestoreJournal();
  if (undo.webdav && typeof window !== 'undefined') window.dispatchEvent(new Event('novelist-webdav-connection-changed'));
}
export function recoverConfiguration(): Promise<void> { return exclusive(recover); }

export function applyConfiguration(fields: Fields, categories: Category[], includeSecrets: boolean): Promise<void> {
  // Validate before waiting or reading native state; malformed input cannot
  // start a settings or vault mutation.
  validateFields(fields, categories, includeSecrets);
  const incoming = clone(fields);
  return exclusive(async () => {
    await recover();
    if (categories.includes('ai')) { await aiTalkSettings.ensureSecrets(); await aiTalkSettings.flushSecretWrites(); }
    const undo: Undo = { version: 1, storage: Object.fromEntries(STORAGE_KEYS.map((key) => [key, localStorage.getItem(key)])), secrets: Object.create(null) };
    const secretWrites: Record<string, string | null> = Object.create(null);
    const retained = readRetained();
    const retainedSecrets = new Set(readRetainedSecretKeys());
    const fallbacks = readRetainedFallbacks();
    for (const key of Object.keys(retained)) if (selected(key, categories)) delete retained[key];
    for (const key of Object.keys(fallbacks)) if (selected(key, categories)) delete fallbacks[key];
    if (includeSecrets) for (const key of retainedSecrets) if (selected(key, categories)) { secretWrites[await retainedSlot(key)] = null; retainedSecrets.delete(key); }
    const preserve = async (key: string, value: JsonValue, sensitive: boolean) => {
      if (sensitive) {
        if (!includeSecrets) return;
        retainedSecrets.add(key); secretWrites[await retainedSlot(key)] = JSON.stringify(value);
      } else retained[key] = value;
    };
    for (const [key, value] of Object.entries(incoming)) if (selected(key, categories) && !knownField(key)) await preserve(key, value, true);
    // Deleting an entity while secret synchronization is disabled can leave
    // its encrypted cloud credential behind. Retain it without activating it.
    for (const [key, value] of Object.entries(incoming)) {
      const profile = /^ai\/profiles\/([^/]+)\/(apiKey|baseUrl)$/u.exec(key);
      if (categories.includes('ai') && profile && incoming[`ai/profiles/${profile[1]}/present`] !== true) await preserve(key, value, true);
      if (categories.includes('webdav') && key === 'webdav/connection/password' && incoming['webdav/connection/present'] !== true) await preserve(key, value, true);
    }

    let preferences: { global: GlobalSections; editor: typeof uiStore.editorSettings; theme: string; language: 'en' | 'zh-CN' } | undefined;
    if (categories.includes('preferences')) {
      const result = await commands.getGlobalSettings();
      if (result.status !== 'ok') throw new Error('settings_capture_failed');
      const raw = result.data;
      undo.preferences = { global: { view: clone(raw.view), new_file: clone(raw.new_file), plugins: clone(raw.plugins), snapshot: clone(raw.snapshot) }, editor: clone(uiStore.editorSettings), theme: uiStore.themeId, language: i18n.locale };
      const view = Object.fromEntries(VIEW_FIELDS.map((field) => [field, incoming[`preferences/global/view/${field}`] ?? null])) as NonNullable<GlobalSections['view']>;
      const newFile = { ...raw.new_file, ...Object.fromEntries(NEW_FILE_FIELDS.map((field) => [field, incoming[`preferences/global/new_file/${field}`] ?? null])) } as NonNullable<GlobalSections['new_file']>;
      const snapshot = Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, incoming[`preferences/global/snapshot/${field}`] ?? null])) as NonNullable<GlobalSections['snapshot']>;
      const enabled = Object.fromEntries(Object.entries(incoming).filter(([key]) => key.startsWith('preferences/global/plugins/')).map(([key, value]) => [decodeId(key.split('/').at(-1)!), value as boolean]));
      const editor = { ...uiStore.editorDefaults, ...Object.fromEntries(EDITOR_FIELDS.filter((field) => own(incoming, `preferences/editor/${field}`)).map((field) => [field, incoming[`preferences/editor/${field}`]])) };
      const theme = (incoming['preferences/theme'] ?? 'system') as string;
      const language = (incoming['preferences/language'] ?? 'en') as string;
      if (theme !== 'system' && !getThemeById(theme)) { await preserve('preferences/theme', theme, false); fallbacks['preferences/theme'] = uiStore.themeId; }
      if (!['en', 'zh-CN'].includes(language)) { await preserve('preferences/language', language, false); fallbacks['preferences/language'] = i18n.locale; }
      preferences = { global: { view, new_file: newFile, plugins: { enabled }, snapshot }, editor, theme: theme === 'system' || getThemeById(theme) ? theme : uiStore.themeId, language: language === 'en' || language === 'zh-CN' ? language : i18n.locale };
    }

    let shortcuts: Record<string, string> | undefined;
    if (categories.includes('shortcuts')) {
      undo.shortcuts = clone(shortcutsStore.overrides);
      shortcuts = {};
      for (const [key, value] of Object.entries(incoming)) if (key.startsWith('shortcuts/') && knownField(key)) {
        const id = decodeId(key.slice(10));
        if (canApplyShortcut(id)) shortcuts[id] = value as string;
        else await preserve(key, value, false);
      }
    }

    let ai: Undo['ai'];
    if (categories.includes('ai')) {
      const current = clone(aiTalkSettings.value);
      const currentStorage = aiTalkSettings.accountStorageState();
      undo.ai = { value: current, storage: currentStorage, presets: clone(promptPresets.userPresets), hidden: [...promptPresets.hiddenBuiltins] };
      const profiles: AiTalkProviderProfile[] = [];
      const vaultProfiles = new Set(currentStorage.profiles);
      const vaultUrls = new Set(currentStorage.urls);
      for (const [key, present] of Object.entries(incoming)) {
        const match = /^ai\/profiles\/([^/]+)\/present$/u.exec(key);
        if (!match || present !== true) continue;
        const id = decodeId(match[1]); const prefix = `ai/profiles/${match[1]}`;
        const old = current.profiles.find((profile) => profile.id === id);
        const apiKey = includeSecrets ? (incoming[`${prefix}/apiKey`] ?? '') as string : old?.apiKey ?? '';
        const suppliedUrl = incoming[`${prefix}/baseUrl`];
        const baseUrl = typeof suppliedUrl === 'string' && (includeSecrets || safeUrl(suppliedUrl)) ? suppliedUrl : !includeSecrets ? old?.baseUrl ?? '' : '';
        profiles.push({ id, label: (incoming[`${prefix}/label`] ?? '') as string, baseUrl, apiKey, model: (incoming[`${prefix}/model`] ?? '') as string, temperature: (incoming[`${prefix}/temperature`] ?? 0.7) as number, ...(own(incoming, `${prefix}/custom`) ? { custom: incoming[`${prefix}/custom`] as boolean } : {}) });
        if (includeSecrets) { vaultProfiles.add(id); secretWrites[`ai:${id}`] = apiKey || null; }
        if (includeSecrets && !safeUrl(baseUrl)) { vaultUrls.add(id); secretWrites[`ai-url:${id}`] = baseUrl || null; }
        else if (includeSecrets && vaultUrls.has(id)) { vaultUrls.delete(id); secretWrites[`ai-url:${id}`] = null; }
      }
      for (const id of currentStorage.profiles) if (!profiles.some((profile) => profile.id === id)) { vaultProfiles.delete(id); secretWrites[`ai:${id}`] = null; }
      for (const id of currentStorage.urls) if (!profiles.some((profile) => profile.id === id)) { vaultUrls.delete(id); secretWrites[`ai-url:${id}`] = null; }
      const presets: PromptPreset[] = [];
      for (const [key, present] of Object.entries(incoming)) {
        const match = /^ai\/prompts\/([^/]+)\/present$/u.exec(key); if (!match || present !== true) continue;
        const id = decodeId(match[1]); const prefix = `ai/prompts/${match[1]}`;
        const preset: PromptPreset = { id, name: (incoming[`${prefix}/name`] ?? '') as string, systemPrompt: (incoming[`${prefix}/systemPrompt`] ?? '') as string, builtin: false };
        for (const field of ['icon', 'temperature', 'model'] as const) if (own(incoming, `${prefix}/${field}`)) Object.assign(preset, { [field]: incoming[`${prefix}/${field}`] });
        if (BUILTIN_PRESETS.some((builtin) => builtin.id === id)) { for (const [field, value] of Object.entries(incoming)) if (field.startsWith(`${prefix}/`)) await preserve(field, value, false); }
        else presets.push(preset);
      }
      const hidden = Object.keys(incoming).filter((key) => key.startsWith('ai/hiddenPrompts/')).map((key) => decodeId(key.slice(17)));
      ai = { value: { ...current, profiles, activeProfileId: (incoming['ai/activeProfileId'] ?? '') as string, systemPrompt: (incoming['ai/systemPrompt'] ?? '') as string, includeCurrentFile: (incoming['ai/includeCurrentFile'] ?? false) as boolean, includeSelection: (incoming['ai/includeSelection'] ?? true) as boolean }, storage: { profiles: [...vaultProfiles], urls: [...vaultUrls] }, presets, hidden };
    }

    let webdav: WebdavConfiguration | null | undefined;
    if (categories.includes('webdav')) {
      const current = await captureWebdav(true);
      undo.webdav = { configuration: current };
      if (incoming['webdav/connection/present'] === true) {
        const endpoint = incoming['webdav/connection/endpoint'] as string;
        const username = incoming['webdav/connection/username'] as string;
        const remote_directory = (incoming['webdav/connection/remote_directory'] ?? '') as string;
        const same = current?.endpoint === endpoint && current.username === username && current.remote_directory === remote_directory;
        webdav = { endpoint, username, remote_directory, password: includeSecrets ? (incoming['webdav/connection/password'] ?? null) as string | null : null, connected_at: same ? current!.connected_at : new Date().toISOString(), restored: same && !current!.restored ? false : true, secure_credential: true };
        // Matching credentials stay in their original secure/manual storage
        // when secrets were excluded from this restore.
        if (!includeSecrets && same) webdav.secure_credential = current!.secure_credential;
      } else webdav = null;
    }
    for (const [slot, value] of Object.entries(secretWrites)) {
      if (new TextEncoder().encode(slot).length > 512 || (value !== null && new TextEncoder().encode(value).length > 8192)) invalid();
    }
    for (const slot of Object.keys(secretWrites)) undo.secrets[slot] = await getConfigurationSecret(slot);
    await saveRestoreJournal(JSON.stringify(undo));
    try {
      for (const [slot, value] of Object.entries(secretWrites)) await setConfigurationSecret(slot, value);
      if (preferences) await writeGlobal(preferences.global);
      if (webdav !== undefined) await restoreWebdav(webdav, !includeSecrets);
      if (preferences) {
        uiStore.updateEditorSettings(preferences.editor); uiStore.setTheme(preferences.theme);
        await i18n.setLocale(preferences.language); await settingsStore.refreshGlobalDefaults();
      }
      if (shortcuts) shortcutsStore.replaceFromAccount(shortcuts);
      if (ai) { aiTalkSettings.replaceFromAccount(ai.value, ai.storage); promptPresets.replaceFromAccount(ai.presets, ai.hidden); }
      localStorage.setItem(RETAINED_KEY, JSON.stringify(retained));
      localStorage.setItem(RETAINED_SECRET_KEYS, JSON.stringify([...retainedSecrets]));
      localStorage.setItem(RETAINED_FALLBACKS, JSON.stringify(fallbacks));
      await clearRestoreJournal();
      if (webdav !== undefined && typeof window !== 'undefined') window.dispatchEvent(new Event('novelist-webdav-connection-changed'));
    } catch {
      await rollback(undo);
      await clearRestoreJournal();
      throw new Error('configuration_restore_failed');
    }
  });
}

export function removeRestoredConnections(): Promise<void> {
  return exclusive(async () => {
    await recover();
    await removeRestoredWebdav();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('novelist-webdav-connection-changed'));
  });
}

export function fieldLabel(key: string): string {
  const category = key.split('/')[0];
  const prefix = ({ preferences: 'Preferences', shortcuts: 'Shortcuts', ai: 'AI', webdav: 'WebDAV connection' } as Record<string, string>)[category] ?? 'Configuration';
  if (!knownField(key)) return `${prefix} · Unsupported setting`;
  if (key.startsWith('shortcuts/')) {
    let id: string; try { id = decodeId(key.slice(10)); } catch { return `${prefix} · Saved binding`; }
    return `${prefix} · ${shortcutsStore.labels[id] ?? 'Saved binding'}`;
  }
  const field = key.split('/').at(-1)!;
  if (field === 'remote_directory') return `${prefix} · Application folder`;
  const names: Record<string, string> = { apiKey: 'API key', baseUrl: 'Provider URL', systemPrompt: 'System prompt', activeProfileId: 'Active connection', includeCurrentFile: 'Include current file', includeSelection: 'Include selection', password: 'Password', endpoint: 'Server URL', username: 'Username', present: key.includes('/prompts/') ? 'Prompt' : 'Connection', label: 'Connection name', model: 'Model', temperature: 'Temperature', custom: 'Custom connection', name: 'Prompt name', icon: 'Prompt icon', theme: 'Theme', language: 'Language', fontFamily: 'Editor font', fontSize: 'Font size', lineHeight: 'Line height', maxWidth: 'Editor width', autoSaveMinutes: 'Autosave interval', indentStyle: 'Indentation', highlightMatches: 'Highlight matches', renderImages: 'Show images', sort_mode: 'File sorting', show_hidden_files: 'Show hidden files', wrap_file_names: 'Wrap file names', sidebar_font_size: 'Sidebar font size', template: 'New-file template', detect_from_folder: 'Detect chapter numbering', auto_rename_from_h1: 'Rename from heading', max_count: 'Snapshot count', min_interval_minutes: 'Snapshot interval' };
  return `${prefix} · ${names[field] ?? (key.includes('/plugins/') ? 'Plugin preference' : key.includes('/hiddenPrompts/') ? 'Hidden built-in prompt' : 'Saved setting')}`;
}
