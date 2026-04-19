import { describe, it, expect, beforeEach } from 'vitest';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';

describe('newFileSettings', () => {
  beforeEach(() => localStorage.clear());

  it('default template is "Untitled {N}"', () => {
    newFileSettings.load();
    expect(newFileSettings.template).toBe('Untitled {N}');
  });

  it('default detectFromFolder is true', () => {
    newFileSettings.load();
    expect(newFileSettings.detectFromFolder).toBe(true);
  });

  it('default autoRenameFromH1 is true', () => {
    newFileSettings.load();
    expect(newFileSettings.autoRenameFromH1).toBe(true);
  });

  it('persists template change to localStorage', () => {
    newFileSettings.setTemplate('第{N}章');
    newFileSettings.load();
    expect(newFileSettings.template).toBe('第{N}章');
  });

  it('rejects invalid template (no {N})', () => {
    expect(() => newFileSettings.setTemplate('no number')).toThrow();
  });
});
