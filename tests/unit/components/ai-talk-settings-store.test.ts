import { describe, it, expect, beforeEach, vi } from 'vitest';
import { aiTalkSettings } from '$lib/components/ai-talk/settings.svelte';

const KEY = 'novelist:ai-talk:settings:v1';

describe('aiTalkSettings store', () => {
  beforeEach(() => {
    localStorage.clear();
    aiTalkSettings.reset();
    localStorage.clear();
  });

  it('exposes the documented defaults on a fresh profile', () => {
    expect(aiTalkSettings.value).toMatchObject({
      activeProfileId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      systemPrompt: 'You are a helpful writing assistant for novelists.',
      includeCurrentFile: false,
      includeSelection: true,
    });
    expect(aiTalkSettings.value.profiles.map((p) => p.id)).toEqual([
      'openai',
      'anthropic',
      'deepseek',
      'openrouter',
      'groq',
      'ollama',
      'custom',
    ]);
  });

  it('update() merges a partial patch into the current value', () => {
    aiTalkSettings.update({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' });
    expect(aiTalkSettings.value.baseUrl).toBe('http://localhost:11434/v1');
    expect(aiTalkSettings.value.model).toBe('llama3.2');
    // Unrelated fields survive untouched.
    expect(aiTalkSettings.value.temperature).toBe(0.7);
    expect(aiTalkSettings.value.includeSelection).toBe(true);
  });

  it('update() persists to localStorage under the versioned key', () => {
    aiTalkSettings.update({ apiKey: 'sk-secret' });
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).apiKey).toBe('sk-secret');
  });

  it('update() applied twice cumulatively merges', () => {
    aiTalkSettings.update({ model: 'gpt-4o' });
    aiTalkSettings.update({ temperature: 0.2 });
    expect(aiTalkSettings.value.model).toBe('gpt-4o');
    expect(aiTalkSettings.value.temperature).toBe(0.2);
  });

  it('reset() restores defaults and persists them', () => {
    aiTalkSettings.update({ apiKey: 'sk-x', model: 'gpt-4o', includeSelection: false });
    aiTalkSettings.reset();
    expect(aiTalkSettings.value.apiKey).toBe('');
    expect(aiTalkSettings.value.model).toBe('gpt-4o-mini');
    expect(aiTalkSettings.value.includeSelection).toBe(true);
    const raw = localStorage.getItem(KEY);
    expect(JSON.parse(raw!).model).toBe('gpt-4o-mini');
  });

  it('saveAsNewProfile snapshots current settings into an active custom profile', () => {
    aiTalkSettings.update({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-d', model: 'deepseek-chat' });
    const id = aiTalkSettings.saveAsNewProfile('Work DeepSeek');
    expect(aiTalkSettings.value.activeProfileId).toBe(id);
    const profile = aiTalkSettings.value.profiles.find((p) => p.id === id);
    expect(profile).toMatchObject({
      label: 'Work DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-d',
      model: 'deepseek-chat',
      custom: true,
    });
  });

  it('switching activeProfileId swaps the connection fields', () => {
    aiTalkSettings.update({ apiKey: 'sk-openai' });
    const id = aiTalkSettings.saveAsNewProfile('Alt');
    aiTalkSettings.update({ model: 'other-model' });
    aiTalkSettings.update({ activeProfileId: 'openai' });
    expect(aiTalkSettings.value.model).toBe('gpt-4o-mini');
    expect(aiTalkSettings.value.apiKey).toBe('sk-openai');
    aiTalkSettings.update({ activeProfileId: id });
    expect(aiTalkSettings.value.model).toBe('other-model');
  });

  it('renameProfile / deleteProfile manage custom profiles only', () => {
    const id = aiTalkSettings.saveAsNewProfile('Temp');
    aiTalkSettings.renameProfile(id, 'Renamed');
    expect(aiTalkSettings.value.profiles.find((p) => p.id === id)?.label).toBe('Renamed');
    aiTalkSettings.deleteProfile('openai'); // built-in: no-op
    expect(aiTalkSettings.value.profiles.some((p) => p.id === 'openai')).toBe(true);
    aiTalkSettings.deleteProfile(id);
    expect(aiTalkSettings.value.profiles.some((p) => p.id === id)).toBe(false);
    expect(aiTalkSettings.value.activeProfileId).not.toBe(id);
  });

  it('persist failures (quota / disabled storage) do not throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => aiTalkSettings.update({ apiKey: 'sk-z' })).not.toThrow();
    // In-memory state still updated even though the write failed.
    expect(aiTalkSettings.value.apiKey).toBe('sk-z');
    spy.mockRestore();
  });
});

describe('aiTalkSettings — module-load behavior', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('hydrates partial saved state and fills the rest from defaults', async () => {
    localStorage.setItem(KEY, JSON.stringify({ apiKey: 'sk-saved', model: 'claude-sonnet-4-5' }));
    const mod = await import('$lib/components/ai-talk/settings.svelte');
    expect(mod.aiTalkSettings.value.apiKey).toBe('sk-saved');
    expect(mod.aiTalkSettings.value.model).toBe('claude-sonnet-4-5');
    // Missing keys come from defaults.
    expect(mod.aiTalkSettings.value.baseUrl).toBe('https://api.openai.com/v1');
    expect(mod.aiTalkSettings.value.temperature).toBe(0.7);
  });

  it('falls back to defaults when localStorage contains corrupt JSON', async () => {
    localStorage.setItem(KEY, '{not valid json');
    const mod = await import('$lib/components/ai-talk/settings.svelte');
    expect(mod.aiTalkSettings.value.model).toBe('gpt-4o-mini');
    expect(mod.aiTalkSettings.value.temperature).toBe(0.7);
  });

  it('keeps saved custom profiles when merging with the default set', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        activeProfileId: 'custom-abc',
        profiles: [
          { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', model: 'gpt-4o-mini', temperature: 0.7 },
          { id: 'custom-abc', label: 'My Router', baseUrl: 'https://r.example/v1', apiKey: 'sk-2', model: 'mix-large', temperature: 0.4, custom: true },
        ],
      }),
    );
    const mod = await import('$lib/components/ai-talk/settings.svelte');
    const custom = mod.aiTalkSettings.value.profiles.find((p) => p.id === 'custom-abc');
    expect(custom).toMatchObject({ label: 'My Router', model: 'mix-large' });
    // The saved custom profile is active and hydrated into the flat fields.
    expect(mod.aiTalkSettings.value.activeProfileId).toBe('custom-abc');
    expect(mod.aiTalkSettings.value.model).toBe('mix-large');
    expect(mod.aiTalkSettings.value.baseUrl).toBe('https://r.example/v1');
  });
});
