/**
 * Persistent settings for the AI Agent panel (Claude CLI bridge).
 */

const KEY = 'novelist:ai-agent:settings:v1';

export type AiAgentSettings = {
  cliPath: string;
  model: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  systemPrompt: string;
  attachProjectRoot: boolean;
};

const DEFAULTS: AiAgentSettings = {
  cliPath: '',
  model: '',
  permissionMode: 'acceptEdits',
  systemPrompt: '',
  attachProjectRoot: true,
};

function load(): AiAgentSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AiAgentSettings>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(value: AiAgentSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

class AiAgentSettingsStore {
  value = $state<AiAgentSettings>(load());

  update(patch: Partial<AiAgentSettings>) {
    this.value = { ...this.value, ...patch };
    persist(this.value);
  }

  reset() {
    this.value = { ...DEFAULTS };
    persist(this.value);
  }
}

export const aiAgentSettings = new AiAgentSettingsStore();
