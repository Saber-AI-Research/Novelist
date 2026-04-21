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
    expect(aiTalkSettings.value).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      temperature: 0.7,
      systemPrompt: 'You are a helpful writing assistant for novelists.',
      includeCurrentFile: false,
      includeSelection: true,
    });
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
});
