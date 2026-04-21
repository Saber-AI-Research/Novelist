import { describe, it, expect, beforeEach, vi } from 'vitest';
import { aiAgentSettings } from '$lib/components/ai-agent/settings.svelte';

const KEY = 'novelist:ai-agent:settings:v1';

describe('aiAgentSettings store', () => {
  beforeEach(() => {
    localStorage.clear();
    aiAgentSettings.reset();
    localStorage.clear();
  });

  it('exposes the documented defaults on a fresh profile', () => {
    expect(aiAgentSettings.value).toEqual({
      cliPath: '',
      model: '',
      permissionMode: 'acceptEdits',
      systemPrompt: '',
      attachProjectRoot: true,
    });
  });

  it('update() merges a partial patch into the current value', () => {
    aiAgentSettings.update({ cliPath: '/usr/local/bin/claude', model: 'sonnet' });
    expect(aiAgentSettings.value.cliPath).toBe('/usr/local/bin/claude');
    expect(aiAgentSettings.value.model).toBe('sonnet');
    expect(aiAgentSettings.value.permissionMode).toBe('acceptEdits');
    expect(aiAgentSettings.value.attachProjectRoot).toBe(true);
  });

  it('update() persists to localStorage under the versioned key', () => {
    aiAgentSettings.update({ permissionMode: 'plan' });
    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).permissionMode).toBe('plan');
  });

  it('reset() restores defaults and persists them', () => {
    aiAgentSettings.update({ cliPath: '/opt/claude', permissionMode: 'bypassPermissions' });
    aiAgentSettings.reset();
    expect(aiAgentSettings.value.cliPath).toBe('');
    expect(aiAgentSettings.value.permissionMode).toBe('acceptEdits');
    const raw = localStorage.getItem(KEY);
    expect(JSON.parse(raw!).permissionMode).toBe('acceptEdits');
  });

  it('persist failures do not throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => aiAgentSettings.update({ cliPath: '/tmp/c' })).not.toThrow();
    expect(aiAgentSettings.value.cliPath).toBe('/tmp/c');
    spy.mockRestore();
  });
});

describe('aiAgentSettings — module-load behavior', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('hydrates partial saved state and fills the rest from defaults', async () => {
    localStorage.setItem(KEY, JSON.stringify({ cliPath: '/home/me/.volta/bin/claude', permissionMode: 'plan' }));
    const mod = await import('$lib/components/ai-agent/settings.svelte');
    expect(mod.aiAgentSettings.value.cliPath).toBe('/home/me/.volta/bin/claude');
    expect(mod.aiAgentSettings.value.permissionMode).toBe('plan');
    expect(mod.aiAgentSettings.value.attachProjectRoot).toBe(true);
  });

  it('falls back to defaults when localStorage contains corrupt JSON', async () => {
    localStorage.setItem(KEY, '{bad');
    const mod = await import('$lib/components/ai-agent/settings.svelte');
    expect(mod.aiAgentSettings.value.permissionMode).toBe('acceptEdits');
    expect(mod.aiAgentSettings.value.cliPath).toBe('');
  });
});
