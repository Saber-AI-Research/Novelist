import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pluginSettings, requestOpenPanelSettings } from '$lib/stores/plugin-settings.svelte';

describe('pluginSettings registry', () => {
  it('has() reports true only for registered built-in plugins', () => {
    expect(pluginSettings.has('ai-talk')).toBe(true);
    expect(pluginSettings.has('ai-agent')).toBe(true);
  });

  it('has() returns false for unknown plugin ids', () => {
    expect(pluginSettings.has('bogus-plugin')).toBe(false);
    expect(pluginSettings.has('')).toBe(false);
  });

  it('get() returns the full entry for a registered plugin', () => {
    const entry = pluginSettings.get('ai-talk');
    expect(entry).not.toBeNull();
    expect(entry!.pluginId).toBe('ai-talk');
    expect(entry!.label).toBe('AI Talk');
    expect(entry!.panelId).toBe('ai-talk');
    expect(typeof entry!.load).toBe('function');
  });

  it('get() returns null for unknown plugin ids', () => {
    expect(pluginSettings.get('not-a-plugin')).toBeNull();
  });

  it('list() includes every registered plugin exactly once', () => {
    const ids = pluginSettings.list().map((e) => e.pluginId);
    expect(ids).toContain('ai-talk');
    expect(ids).toContain('ai-agent');
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('entry.load() dynamically imports a Svelte component module', async () => {
    const entry = pluginSettings.get('ai-talk')!;
    const mod = await entry.load();
    // Svelte components are exposed as the module's default export.
    expect(mod.default).toBeDefined();
  });
});

describe('requestOpenPanelSettings', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('writes the namespaced open-settings flag for the given panel', () => {
    requestOpenPanelSettings('ai-talk');
    expect(sessionStorage.getItem('novelist:ai-talk:open-settings')).toBe('1');
  });

  it('uses a panel-specific key so multiple panels do not collide', () => {
    requestOpenPanelSettings('ai-talk');
    requestOpenPanelSettings('ai-agent');
    expect(sessionStorage.getItem('novelist:ai-talk:open-settings')).toBe('1');
    expect(sessionStorage.getItem('novelist:ai-agent:open-settings')).toBe('1');
  });

  it('swallows sessionStorage failures silently', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => requestOpenPanelSettings('ai-talk')).not.toThrow();
    spy.mockRestore();
  });
});
