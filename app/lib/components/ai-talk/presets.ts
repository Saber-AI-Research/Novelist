import { aiTalkSettings } from './settings.svelte';

export type AiTalkProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
};

/**
 * One-click provider presets for the AI Talk panel. Each sets both `baseUrl`
 * and a sensible default `model` so a new user doesn't need to remember the
 * endpoint / model-id combo for the common OpenAI-compatible providers.
 */
export const AI_TALK_PRESETS: readonly AiTalkProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' },
];

/**
 * Apply a preset by id — writes the provider's `baseUrl` + `model` into the
 * settings store, leaving apiKey / temperature / etc. untouched. Unknown ids
 * are a no-op so UI callers don't need to pre-validate.
 */
export function applyAiTalkPreset(id: string): boolean {
  const p = AI_TALK_PRESETS.find((x) => x.id === id);
  if (!p) return false;
  aiTalkSettings.update({ baseUrl: p.baseUrl, model: p.model });
  return true;
}
