import { describe, it, expect, beforeEach, vi } from 'vitest';
import { projectStore } from '$lib/stores/project.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

describe('projectStore.sortMode', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset the unified store — the sortMode getter reads from here.
    settingsStore.effective = {
      view: { sort_mode: 'numeric-asc', show_hidden_files: false },
      new_file: {
        template: 'Untitled {N}',
        detect_from_folder: true,
        auto_rename_from_h1: true,
        default_dir: null,
        last_used_dir: null,
      },
      plugins: { enabled: {} },
      is_project_scoped: false,
    };
  });

  it('defaults to numeric-asc', () => {
    expect(projectStore.sortMode).toBe('numeric-asc');
  });

  it('reflects the current settingsStore value', () => {
    settingsStore.effective = {
      ...settingsStore.effective,
      view: { sort_mode: 'name-desc', show_hidden_files: false },
    };
    expect(projectStore.sortMode).toBe('name-desc');
  });

  it('setSortMode routes through settingsStore.writeView', () => {
    const spy = vi.spyOn(settingsStore, 'writeView').mockResolvedValue();
    projectStore.setSortMode('mtime-desc');
    expect(spy).toHaveBeenCalledWith({ sort_mode: 'mtime-desc' });
    spy.mockRestore();
  });

  it('coerces an unknown sort_mode from backend to numeric-asc default', () => {
    settingsStore.effective = {
      ...settingsStore.effective,
      view: { sort_mode: 'bogus-mode', show_hidden_files: false },
    };
    expect(projectStore.sortMode).toBe('numeric-asc');
  });
});
