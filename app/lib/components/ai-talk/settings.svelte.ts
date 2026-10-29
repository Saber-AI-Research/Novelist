/**
 * Persistent settings for the AI Talk panel. Stored in the host's localStorage
 * under a namespaced key so it doesn't collide with editor state.
 */

const KEY = 'novelist:ai-talk:settings:v1';

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

function persist(value: AiTalkSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — silently ignore */
  }
}

class AiTalkSettingsStore {
  value = $state<AiTalkSettings>(load());

  update(patch: Partial<AiTalkSettings>) {
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
    persist(this.value);
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
    this.value = hydrateActiveProfile({
      ...v,
      activeProfileId: id,
      profiles: [...v.profiles, profile],
    });
    persist(this.value);
    return id;
  }

  renameProfile(id: string, label: string) {
    const cleaned = label.trim();
    if (!cleaned) return;
    this.value = {
      ...this.value,
      profiles: this.value.profiles.map((p) => (p.id === id ? { ...p, label: cleaned } : p)),
    };
    persist(this.value);
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
    persist(this.value);
  }

  reset() {
    this.value = freshDefaults();
    persist(this.value);
  }
}

export const aiTalkSettings = new AiTalkSettingsStore();
