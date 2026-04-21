import { describe, it, expect, beforeEach } from 'vitest';
import { promptPresets, BUILTIN_PRESETS } from '$lib/components/ai-talk/presets.svelte';

function resetStore() {
  localStorage.clear();
  promptPresets.userPresets = [];
  promptPresets.hiddenBuiltins = [];
}

describe('promptPresets store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('lists all built-in presets by default', () => {
    expect(promptPresets.all).toHaveLength(BUILTIN_PRESETS.length);
    for (const p of promptPresets.all) {
      expect(p.builtin).toBe(true);
    }
  });

  it('create() adds a user preset and assigns a user:-prefixed id', () => {
    const id = promptPresets.create({
      name: 'Custom',
      systemPrompt: 'Do the thing.',
      temperature: 0.7,
    });
    expect(id.startsWith('user:')).toBe(true);
    const stored = promptPresets.get(id);
    expect(stored?.name).toBe('Custom');
    expect(stored?.builtin).toBe(false);
    expect(stored?.temperature).toBe(0.7);
  });

  it('update() modifies a user preset but leaves built-ins untouched', () => {
    const id = promptPresets.create({ name: 'Custom', systemPrompt: 'old' });
    promptPresets.update(id, { systemPrompt: 'new' });
    expect(promptPresets.get(id)?.systemPrompt).toBe('new');

    promptPresets.update('builtin:default', { systemPrompt: 'HACK' });
    const defaultPreset = promptPresets.get('builtin:default');
    expect(defaultPreset?.systemPrompt).not.toBe('HACK');
  });

  it('delete() removes a user preset outright', () => {
    const id = promptPresets.create({ name: 'Custom', systemPrompt: '…' });
    promptPresets.delete(id);
    expect(promptPresets.get(id)).toBeNull();
  });

  it('delete() on a built-in soft-hides it; restoreBuiltin reveals it again', () => {
    const count = promptPresets.all.length;
    promptPresets.delete('builtin:editor');
    expect(promptPresets.all).toHaveLength(count - 1);
    expect(promptPresets.all.some((p) => p.id === 'builtin:editor')).toBe(false);
    expect(promptPresets.get('builtin:editor')).not.toBeNull();
    promptPresets.restoreBuiltin('builtin:editor');
    expect(promptPresets.all).toHaveLength(count);
  });
});
