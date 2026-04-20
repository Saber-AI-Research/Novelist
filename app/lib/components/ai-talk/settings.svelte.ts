/**
 * Persistent settings for the AI Talk panel. Stored in the host's localStorage
 * under a namespaced key so it doesn't collide with editor state.
 */

const KEY = 'novelist:ai-talk:settings:v1';

export type AiTalkSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
  includeCurrentFile: boolean;
  includeSelection: boolean;
};

const DEFAULTS: AiTalkSettings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  systemPrompt: 'You are a helpful writing assistant for novelists.',
  includeCurrentFile: false,
  includeSelection: true,
};

function load(): AiTalkSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AiTalkSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
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
    this.value = { ...this.value, ...patch };
    persist(this.value);
  }

  reset() {
    this.value = { ...DEFAULTS };
    persist(this.value);
  }
}

export const aiTalkSettings = new AiTalkSettingsStore();
