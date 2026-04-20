import { describe, it, expect, beforeEach } from 'vitest';
import { AI_TALK_PRESETS, applyAiTalkPreset } from '$lib/components/ai-talk/presets';
import { aiTalkSettings } from '$lib/components/ai-talk/settings.svelte';

describe('AI_TALK_PRESETS — list', () => {
  it('exposes the expected six providers', () => {
    const ids = AI_TALK_PRESETS.map((p) => p.id);
    expect(ids).toEqual(['openai', 'anthropic', 'deepseek', 'groq', 'openrouter', 'ollama']);
  });

  it('every preset has a non-empty baseUrl and model', () => {
    for (const p of AI_TALK_PRESETS) {
      expect(p.baseUrl.length, `baseUrl for ${p.id}`).toBeGreaterThan(0);
      expect(p.model.length, `model for ${p.id}`).toBeGreaterThan(0);
      expect(p.label.length, `label for ${p.id}`).toBeGreaterThan(0);
    }
  });

  it('all ids are unique', () => {
    const ids = AI_TALK_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('Ollama preset uses a localhost URL (local-only contract)', () => {
    const ollama = AI_TALK_PRESETS.find((p) => p.id === 'ollama')!;
    expect(ollama.baseUrl).toMatch(/^http:\/\/localhost/);
  });
});

describe('applyAiTalkPreset', () => {
  beforeEach(() => {
    localStorage.clear();
    aiTalkSettings.reset();
    localStorage.clear();
  });

  it('writes the preset baseUrl and model into aiTalkSettings', () => {
    const ok = applyAiTalkPreset('anthropic');
    expect(ok).toBe(true);
    expect(aiTalkSettings.value.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(aiTalkSettings.value.model).toBe('claude-sonnet-4-5');
  });

  it('preserves unrelated settings (apiKey, temperature, systemPrompt)', () => {
    aiTalkSettings.update({ apiKey: 'sk-keep', temperature: 0.25, systemPrompt: 'custom' });
    applyAiTalkPreset('groq');
    expect(aiTalkSettings.value.apiKey).toBe('sk-keep');
    expect(aiTalkSettings.value.temperature).toBe(0.25);
    expect(aiTalkSettings.value.systemPrompt).toBe('custom');
    expect(aiTalkSettings.value.baseUrl).toBe('https://api.groq.com/openai/v1');
  });

  it('returns false and does nothing for an unknown preset id', () => {
    aiTalkSettings.update({ baseUrl: 'https://pre-existing/v1', model: 'pre-existing' });
    const ok = applyAiTalkPreset('not-a-provider');
    expect(ok).toBe(false);
    expect(aiTalkSettings.value.baseUrl).toBe('https://pre-existing/v1');
    expect(aiTalkSettings.value.model).toBe('pre-existing');
  });

  it('each preset can be applied round-trip without side-effects between them', () => {
    for (const preset of AI_TALK_PRESETS) {
      applyAiTalkPreset(preset.id);
      expect(aiTalkSettings.value.baseUrl).toBe(preset.baseUrl);
      expect(aiTalkSettings.value.model).toBe(preset.model);
    }
  });
});
