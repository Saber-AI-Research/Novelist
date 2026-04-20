import { describe, it, expect, beforeEach, vi } from 'vitest';
import { settingsStore } from '$lib/stores/settings.svelte';

/**
 * Unit coverage for settingsStore's new-file directory helpers.
 *
 * `resolveNewFileDir(projectRoot)` implements the precedence used by Cmd+N:
 *   pinned default_dir > live last_used_dir > provided project root.
 *
 * `recordLastUsedDir(dir)` is called after every successful file create and
 * must short-circuit when a pin is present or the recorded value hasn't
 * changed, so it doesn't generate IPC churn during rapid creates.
 */

function seedEffective(partial: Partial<typeof settingsStore.effective.new_file>) {
  settingsStore.effective = {
    view: { sort_mode: 'numeric-asc', show_hidden_files: false },
    new_file: {
      template: 'Untitled {N}',
      detect_from_folder: true,
      auto_rename_from_h1: true,
      default_dir: null,
      last_used_dir: null,
      ...partial,
    },
    plugins: { enabled: {} },
    is_project_scoped: false,
  };
}

describe('settingsStore.resolveNewFileDir', () => {
  beforeEach(() => seedEffective({}));

  it('falls back to the project root when nothing is set', () => {
    expect(settingsStore.resolveNewFileDir('/proj')).toBe('/proj');
  });

  it('prefers last_used_dir over the project root', () => {
    seedEffective({ last_used_dir: '/proj/chapters' });
    expect(settingsStore.resolveNewFileDir('/proj')).toBe('/proj/chapters');
  });

  it('prefers default_dir over last_used_dir', () => {
    seedEffective({
      default_dir: '/proj/pinned',
      last_used_dir: '/proj/chapters',
    });
    expect(settingsStore.resolveNewFileDir('/proj')).toBe('/proj/pinned');
  });

  it('keeps the empty string as "not set" (null/undefined-only precedence)', () => {
    // `default_dir: ''` is falsy — the resolver should skip it, not use it.
    seedEffective({ default_dir: '', last_used_dir: '/proj/chapters' });
    expect(settingsStore.resolveNewFileDir('/proj')).toBe('/proj/chapters');
  });
});

describe('settingsStore.recordLastUsedDir', () => {
  beforeEach(() => seedEffective({}));

  it('persists the new directory via writeNewFile', async () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    await settingsStore.recordLastUsedDir('/proj/chapters');
    expect(spy).toHaveBeenCalledWith({ last_used_dir: '/proj/chapters' });
    spy.mockRestore();
  });

  it('no-ops when the directory equals the current last_used_dir', async () => {
    seedEffective({ last_used_dir: '/proj/chapters' });
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    await settingsStore.recordLastUsedDir('/proj/chapters');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('no-ops when a pinned default_dir is set (pin wins over recency)', async () => {
    seedEffective({ default_dir: '/proj/pinned' });
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    await settingsStore.recordLastUsedDir('/proj/chapters');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('settingsStore.setDefaultDir', () => {
  beforeEach(() => seedEffective({}));

  it('writes the pin via writeNewFile with the given path', async () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    await settingsStore.setDefaultDir('/proj/fixed');
    expect(spy).toHaveBeenCalledWith({ default_dir: '/proj/fixed' });
    spy.mockRestore();
  });

  it('clears the pin when passed null', async () => {
    const spy = vi.spyOn(settingsStore, 'writeNewFile').mockResolvedValue();
    await settingsStore.setDefaultDir(null);
    expect(spy).toHaveBeenCalledWith({ default_dir: null });
    spy.mockRestore();
  });
});
