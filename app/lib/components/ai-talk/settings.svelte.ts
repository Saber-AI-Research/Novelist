/** AI settings stay local; account-restored credentials live in the OS vault. */
import { getConfigurationSecret, setConfigurationSecret } from '$lib/services/account-config-native';

const KEY = 'novelist:ai-talk:settings:v1';
const VAULT_PROFILES_KEY = 'novelist:ai-talk:vault-profiles:v1';
const VAULT_URLS_KEY = 'novelist:ai-talk:vault-urls:v1';

function loadIds(key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

export type AiTalkCredentialStorage = { profiles: string[]; urls: string[] };

export type AiTalkSettings = {
  activeProfileId: string;
  profiles: AiTalkProviderProfile[];
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  includeCurrentFile: boolean;
  includeSelection: boolean;
};

export type AiTalkProviderProfile = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  custom?: boolean;
};

// A deliberately lean set of built-in providers. Anything else (OpenRouter,
// Groq, a self-hosted gateway, …) is added by the user via "+ Add profile",
// which appends a custom profile that lives in the same list as these.
export const PROVIDER_TEMPLATES: AiTalkProviderProfile[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', temperature: 0.7 },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: '', model: 'claude-sonnet-4-5', temperature: 0.7 },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.7 },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.2', temperature: 0.7 },
];

const DEFAULTS: AiTalkSettings = {
  activeProfileId: 'openai',
  profiles: PROVIDER_TEMPLATES,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  systemPrompt: 'You are a helpful writing assistant for novelists.',
  includeCurrentFile: false,
  includeSelection: true,
};

// Once a profile list has been saved it is authoritative, including an empty
// list. Only legacy settings without a list receive the initial templates.
function mergeProfiles(parsed: Partial<AiTalkSettings>): AiTalkProviderProfile[] {
  if (Array.isArray(parsed.profiles)) return parsed.profiles;
  const activeProfileId = parsed.activeProfileId ?? DEFAULTS.activeProfileId;
  return PROVIDER_TEMPLATES.map((profile) => profile.id === activeProfileId ? {
    ...profile,
    baseUrl: parsed.baseUrl ?? profile.baseUrl,
    apiKey: parsed.apiKey ?? profile.apiKey,
    model: parsed.model ?? profile.model,
    temperature: parsed.temperature ?? profile.temperature,
  } : { ...profile });
}

function freshDefaults(): AiTalkSettings {
  return { ...DEFAULTS, profiles: PROVIDER_TEMPLATES.map((p) => ({ ...p })) };
}

function hydrateActiveProfile(value: AiTalkSettings): AiTalkSettings {
  const active = value.profiles.find((p) => p.id === value.activeProfileId) ?? value.profiles[0];
  if (!active) return { ...value, activeProfileId: '', baseUrl: '', apiKey: '', model: '' };
  return {
    ...value,
    activeProfileId: active.id,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    temperature: active.temperature,
  };
}

function load(): AiTalkSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshDefaults();
    const parsed = JSON.parse(raw) as Partial<AiTalkSettings>;
    return hydrateActiveProfile({ ...DEFAULTS, ...parsed, profiles: mergeProfiles(parsed) });
  } catch {
    return freshDefaults();
  }
}

function persist(value: AiTalkSettings, vaultProfiles: Set<string>, vaultUrls: Set<string>, strict = false) {
  const profiles = value.profiles.map((profile) => ({
    ...profile,
    apiKey: vaultProfiles.has(profile.id) ? '' : profile.apiKey,
    baseUrl: vaultUrls.has(profile.id) ? '' : profile.baseUrl,
  }));
  const safe = hydrateActiveProfile({ ...value, profiles });
  const save = () => {
    localStorage.setItem(VAULT_PROFILES_KEY, JSON.stringify([...vaultProfiles]));
    localStorage.setItem(VAULT_URLS_KEY, JSON.stringify([...vaultUrls]));
    localStorage.setItem(KEY, JSON.stringify(safe));
  };
  if (strict) save();
  else { try { save(); } catch { /* Local storage can be unavailable. */ } }
}

class AiTalkSettingsStore {
  value = $state<AiTalkSettings>(load());
  private vaultProfiles = loadIds(VAULT_PROFILES_KEY);
  private vaultUrls = loadIds(VAULT_URLS_KEY);
  private loadedSecrets = new Set<string>();
  private editedSecrets = new Set<string>();
  private secretWrites: Promise<void> = Promise.resolve();
  private secretLoad: Promise<void> | null = null;
  private secretLoadGeneration = 0;
  credentialError: string | null = null;

  constructor() {
    void this.ensureSecrets().catch(() => undefined);
  }

  ensureSecrets(): Promise<void> {
    if (this.secretLoad) return this.secretLoad;
    const generation = this.secretLoadGeneration;
    this.secretLoad = (async () => {
      for (const [ids, prefix, field] of [[this.vaultProfiles, 'ai:', 'apiKey'], [this.vaultUrls, 'ai-url:', 'baseUrl']] as const) {
        for (const id of ids) {
          const slot = `${prefix}${id}`;
          const value = await getConfigurationSecret(slot);
          if (generation !== this.secretLoadGeneration) return;
          this.loadedSecrets.add(slot);
          if (this.editedSecrets.has(slot)) continue;
          this.value = hydrateActiveProfile({ ...this.value, profiles: this.value.profiles.map((profile) => profile.id === id ? { ...profile, [field]: value ?? '' } : profile) });
        }
      }
    })().catch(() => {
      if (generation !== this.secretLoadGeneration) return;
      this.credentialError = 'secure_storage_unavailable';
      this.secretLoad = null;
      throw new Error('secure_storage_unavailable');
    });
    return this.secretLoad;
  }

  async flushSecretWrites(): Promise<void> { await this.secretWrites; }

  private save() {
    persist(this.value, this.vaultProfiles, this.vaultUrls);
    for (const profile of this.value.profiles) {
      for (const [ids, prefix, field] of [[this.vaultProfiles, 'ai:', 'apiKey'], [this.vaultUrls, 'ai-url:', 'baseUrl']] as const) {
        const slot = `${prefix}${profile.id}`;
        if (!ids.has(profile.id) || (!this.loadedSecrets.has(slot) && !this.editedSecrets.has(slot))) continue;
        const value = profile[field];
        this.secretWrites = this.secretWrites.then(() => setConfigurationSecret(slot, value || null)).catch(() => { this.credentialError = 'secure_storage_unavailable'; });
      }
    }
  }

  accountStorageState(): AiTalkCredentialStorage {
    return { profiles: [...this.vaultProfiles], urls: [...this.vaultUrls] };
  }

  /** Vault writes are staged by the account transaction before publishing. */
  replaceFromAccount(value: AiTalkSettings, storage: AiTalkCredentialStorage): void {
    const profiles = new Set(storage.profiles);
    const urls = new Set(storage.urls);
    persist(value, profiles, urls, true);
    this.secretLoadGeneration++;
    this.vaultProfiles = profiles;
    this.vaultUrls = urls;
    this.loadedSecrets = new Set([...profiles].map((id) => `ai:${id}`).concat([...urls].map((id) => `ai-url:${id}`)));
    this.secretLoad = Promise.resolve();
    this.value = hydrateActiveProfile(value);
  }

  update(patch: Partial<AiTalkSettings>) {
    if (patch.apiKey !== undefined) this.editedSecrets.add(`ai:${patch.activeProfileId ?? this.value.activeProfileId}`);
    if (patch.baseUrl !== undefined) this.editedSecrets.add(`ai-url:${patch.activeProfileId ?? this.value.activeProfileId}`);
    const next = { ...this.value, ...patch };
    const activeProfileId = patch.activeProfileId ?? next.activeProfileId;
    let profiles = next.profiles;
    const active = profiles.find((p) => p.id === activeProfileId);
    if (
      active &&
      (patch.baseUrl !== undefined ||
        patch.apiKey !== undefined ||
        patch.model !== undefined ||
        patch.temperature !== undefined)
    ) {
      profiles = profiles.map((p) =>
        p.id === active.id
          ? {
              ...p,
              baseUrl: patch.baseUrl ?? p.baseUrl,
              apiKey: patch.apiKey ?? p.apiKey,
              model: patch.model ?? p.model,
              temperature: patch.temperature ?? p.temperature,
            }
          : p,
      );
    }
    this.value = hydrateActiveProfile({ ...next, activeProfileId, profiles });
    this.save();
  }

  /**
   * Save the current connection settings (baseUrl/apiKey/model/temperature)
   * as a new custom profile and make it active. Returns the new profile id.
   */
  saveAsNewProfile(label?: string): string {
    const v = this.value;
    const id = `custom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    let host = 'custom';
    try {
      host = new URL(v.baseUrl).hostname;
    } catch {
      /* keep fallback */
    }
    const profile: AiTalkProviderProfile = {
      id,
      label: (label ?? '').trim() || `${v.model || 'Model'} @ ${host}`,
      baseUrl: v.baseUrl,
      apiKey: v.apiKey,
      model: v.model,
      temperature: v.temperature,
      custom: true,
    };
    if (this.vaultProfiles.has(v.activeProfileId)) { this.vaultProfiles.add(id); this.loadedSecrets.add(`ai:${id}`); }
    if (this.vaultUrls.has(v.activeProfileId)) { this.vaultUrls.add(id); this.loadedSecrets.add(`ai-url:${id}`); }
    this.value = hydrateActiveProfile({
      ...v,
      activeProfileId: id,
      profiles: [...v.profiles, profile],
    });
    this.save();
    return id;
  }

  renameProfile(id: string, label: string) {
    const cleaned = label.trim();
    if (!cleaned) return;
    this.value = {
      ...this.value,
      profiles: this.value.profiles.map((p) => (p.id === id ? { ...p, label: cleaned } : p)),
    };
    this.save();
  }

  /** Add a clean connection; restoring a template never restores its old key. */
  addProfile(templateId?: string): string {
    const template = PROVIDER_TEMPLATES.find((p) => p.id === templateId);
    const id = `custom-${crypto.randomUUID()}`;
    const profile: AiTalkProviderProfile = {
      id, label: 'Custom', baseUrl: '', apiKey: '', model: '', temperature: 0.7,
      ...template,
      // Preserve the familiar template id when it is available.
      ...(template && !this.value.profiles.some((p) => p.id === template.id) ? {} : { id }),
      custom: true,
    };
    this.update({ profiles: [...this.value.profiles, profile], activeProfileId: profile.id });
    return profile.id;
  }

  /** Every profile can be removed, including the last one. */
  deleteProfile(id: string) {
    const target = this.value.profiles.find((p) => p.id === id);
    if (!target) return;
    const profiles = this.value.profiles.filter((p) => p.id !== id);
    const activeProfileId =
      this.value.activeProfileId === id ? profiles[0]?.id ?? '' : this.value.activeProfileId;
    this.value = hydrateActiveProfile({ ...this.value, activeProfileId, profiles });
    for (const [ids, prefix] of [[this.vaultProfiles, 'ai:'], [this.vaultUrls, 'ai-url:']] as const) {
      if (!ids.delete(id)) continue;
      this.secretWrites = this.secretWrites.then(() => setConfigurationSecret(`${prefix}${id}`, null)).catch(() => { this.credentialError = 'secure_storage_unavailable'; });
    }
    this.save();
  }

  reset() {
    this.value = freshDefaults();
    this.save();
  }
}

export const aiTalkSettings = new AiTalkSettingsStore();
