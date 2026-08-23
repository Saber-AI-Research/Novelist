import { describe, it, expect, beforeEach, vi } from 'vitest';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

describe('newFileSettings shim', () => {
  beforeEach(() => {
    // Reset the unified store's state; the shim reads from it.
    settingsStore.effective = {
      view: { sort_mode: 'numeric-asc', show_hidden_files: false, wrap_file_names: false, sidebar_font_size: 14 },
      new_file: {
        template: 'Untitled {N}',
        detect_from_folder: true,
        auto_rename_from_h1: true,
        default_dir: null,
        last_used_dir: null,
      },
      plugins: { enabled: {} },
      snapshot: { max_count: 100, min_interval_minutes: 60 },
      is_project_scoped: false,
    };
  });

  it('exposes default template', () => {
    expect(newFileSettings.template).toBe('Untitled {N}');
  });

  it('exposes default detectFromFolder', () => {
    expect(newFileSettings.detectFromFolder).toBe(true);
  });

  it('exposes default autoRenameFromH1', () => {
    expect(newFileSettings.autoRenameFromH1).toBe(true);
  });

  it('setTemplate rejects invalid template (no {N})', () => {
    expect(() => newFileSettings.setTemplate('no number')).toThrow();
  });

  it('setTemplate routes a valid template through settingsStore.writeNewFile', () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    newFileSettings.setTemplate('第{N}章');
    expect(spy).toHaveBeenCalledWith({ template: '第{N}章' });
    spy.mockRestore();
  });

  it('setDetectFromFolder routes through writeNewFile', () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    newFileSettings.setDetectFromFolder(false);
    expect(spy).toHaveBeenCalledWith({ detect_from_folder: false });
    spy.mockRestore();
  });

  it('setAutoRenameFromH1 routes through writeNewFile', () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    newFileSettings.setAutoRenameFromH1(false);
    expect(spy).toHaveBeenCalledWith({ auto_rename_from_h1: false });
    spy.mockRestore();
  });
});
