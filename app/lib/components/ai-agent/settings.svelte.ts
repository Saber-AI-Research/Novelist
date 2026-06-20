/**
 * Persistent settings for the AI Agent panel (Claude CLI bridge).
 */

const KEY = 'novelist:ai-agent:settings:v1';

export type AgentProvider = 'claude' | 'codex';

export type AiAgentSettings = {
  /** Backend stamped onto NEW sessions. Existing sessions keep their provider. */
  providerId: AgentProvider;
  cliPath: string;
  model: string;
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  systemPrompt: string;
  attachProjectRoot: boolean;
  /** Codex-specific overrides (the `codex` binary differs from `claude`). */
  codexCliPath: string;
  codexModel: string;
};

const DEFAULTS: AiAgentSettings = {
  providerId: 'claude',
  cliPath: '',
  model: '',
  permissionMode: 'acceptEdits',
  systemPrompt: '',
  attachProjectRoot: true,
  codexCliPath: '',
  codexModel: '',
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
