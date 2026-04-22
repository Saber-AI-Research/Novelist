import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * [contract] settingsStore — IPC-heavy paths (load, writeView, writeNewFile,
 * writePluginEnabled, resetPluginOverride, promoteToGlobal, migration).
 *
 * The existing `settings-store.test.ts` covers the `resolveNewFileDir`
 * helpers; this suite drives every branch that talks to IPC, mocking each
 * Tauri command at the module boundary.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    getEffectiveSettings: vi.fn(),
    writeProjectSettings: vi.fn(),
    writeGlobalSettings: vi.fn(),
    getGlobalSettings: vi.fn(),
    readProjectConfig: vi.fn(),
  },
}));

import { settingsStore } from '$lib/stores/settings.svelte';
import { commands } from '$lib/ipc/commands';

const DEFAULT_EFFECTIVE = {
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

function resetStore() {
  settingsStore.effective = { ...DEFAULT_EFFECTIVE };
  // Reset the private dirPath via load(null) on the happy path.
  (settingsStore as any).dirPath = null;
  localStorage.clear();
  vi.clearAllMocks();
}

describe('[contract] settingsStore.load', () => {
  beforeEach(resetStore);

  it('populates effective settings from the IPC response', async () => {
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: {
        ...DEFAULT_EFFECTIVE,
        view: { sort_mode: 'name-desc', show_hidden_files: true },
        is_project_scoped: true,
      },
    });

    await settingsStore.load('/proj');

    expect(settingsStore.effective.view.sort_mode).toBe('name-desc');
    expect(settingsStore.effective.view.show_hidden_files).toBe(true);
    expect(settingsStore.effective.is_project_scoped).toBe(true);
    expect(settingsStore.isProjectScoped).toBe(true);
  });

  it('falls back to defaults + logs error when IPC returns error', async () => {
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'error',
      error: 'no file',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await settingsStore.load('/proj');

    expect(settingsStore.effective.view.sort_mode).toBe('numeric-asc');
    expect(settingsStore.effective.is_project_scoped).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('falls back to defaults when IPC throws (running outside Tauri)', async () => {
    (commands.getEffectiveSettings as any).mockRejectedValue(new Error('invoke unavailable'));

    await settingsStore.load(null);

    expect(settingsStore.effective.view.sort_mode).toBe('numeric-asc');
    expect(settingsStore.effective.is_project_scoped).toBe(false);
    expect(settingsStore.isProjectScoped).toBe(false);
  });
});

describe('[contract] settingsStore.load — migration from localStorage', () => {
  beforeEach(resetStore);

  it('migrates legacy sort mode into project.toml when [view] section is absent', async () => {
    localStorage.setItem('novelist.sortMode./proj', 'name-desc');
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: null },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, is_project_scoped: true },
    });

    await settingsStore.load('/proj');

    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      { sort_mode: 'name-desc', show_hidden_files: null },
      null,
      null,
    );
    // localStorage key is cleared after successful migration.
    expect(localStorage.getItem('novelist.sortMode./proj')).toBeNull();
  });

  it('migrates legacy newFileSettings JSON when [new_file] section is absent', async () => {
    localStorage.setItem(
      'novelist.newFileSettings.v1',
      JSON.stringify({
        template: '{folder} {N}',
        detectFromFolder: false,
        autoRenameFromH1: false,
      }),
    );
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: null },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, is_project_scoped: true },
    });

    await settingsStore.load('/proj');

    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      null,
      {
        template: '{folder} {N}',
        detect_from_folder: false,
        auto_rename_from_h1: false,
      },
      null,
    );
  });

  it('does NOT migrate when [view] is already populated (explicit project choice wins)', async () => {
    localStorage.setItem('novelist.sortMode./proj', 'name-desc');
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: {
        project: null,
        view: { sort_mode: 'numeric-asc' },
        new_file: null,
        plugins: null,
      },
    });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, is_project_scoped: true },
    });

    await settingsStore.load('/proj');

    // writeProjectSettings should NOT have been called for the view migration.
    expect(commands.writeProjectSettings).not.toHaveBeenCalled();
    // Legacy key stays (only cleared when migration fires).
    expect(localStorage.getItem('novelist.sortMode./proj')).toBe('name-desc');
  });

  it('survives malformed legacy JSON without throwing', async () => {
    localStorage.setItem('novelist.newFileSettings.v1', '{not-valid');
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: null },
    });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, is_project_scoped: true },
    });

    await expect(settingsStore.load('/proj')).resolves.not.toThrow();
  });

  it('skips migration entirely when no legacy keys are present', async () => {
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: null },
    });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, is_project_scoped: true },
    });

    await settingsStore.load('/proj');

    expect(commands.readProjectConfig).not.toHaveBeenCalled();
  });
});

describe('[contract] settingsStore.writeView', () => {
  beforeEach(resetStore);

  it('routes to writeGlobalSettings when no project is open', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writeView({ sort_mode: 'name-asc' });

    expect(commands.writeGlobalSettings).toHaveBeenCalled();
    expect(commands.writeProjectSettings).not.toHaveBeenCalled();
    expect(settingsStore.effective.view.sort_mode).toBe('name-asc');
  });

  it('routes to writeProjectSettings when a project is open', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writeView({ show_hidden_files: true });

    expect(commands.writeProjectSettings).toHaveBeenCalled();
    expect(settingsStore.effective.view.show_hidden_files).toBe(true);
  });

  it('logs + early-returns on IPC error without mutating effective', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({
      status: 'error',
      error: 'disk full',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = settingsStore.effective.view.sort_mode;

    await settingsStore.writeView({ sort_mode: 'name-desc' });

    expect(settingsStore.effective.view.sort_mode).toBe(before);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('[contract] settingsStore.writeNewFile', () => {
  beforeEach(resetStore);

  it('merges the patch over current values (defaults preserved)', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writeNewFile({ template: 'Chapter {N}' });

    expect(settingsStore.effective.new_file.template).toBe('Chapter {N}');
    // Other fields unchanged from defaults.
    expect(settingsStore.effective.new_file.detect_from_folder).toBe(true);
  });

  it('error result logs and leaves effective unchanged', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({
      status: 'error',
      error: 'EIO',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await settingsStore.writeNewFile({ template: 'X' });

    expect(settingsStore.effective.new_file.template).toBe('Untitled {N}');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('[contract] settingsStore.writePluginEnabled', () => {
  beforeEach(resetStore);

  it('global mode: writes the full enabled map', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writePluginEnabled('mindmap', true);

    expect(commands.writeGlobalSettings).toHaveBeenCalledWith(null, null, {
      enabled: { mindmap: true },
    });
    expect(settingsStore.effective.plugins.enabled.mindmap).toBe(true);
  });

  it('global mode: returns + logs on error without mutation', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({
      status: 'error',
      error: 'x',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await settingsStore.writePluginEnabled('mindmap', true);

    expect(settingsStore.effective.plugins.enabled.mindmap).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('project mode: stores an override when the new value differs from the global default', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.getGlobalSettings as any).mockResolvedValue({
      status: 'ok',
      data: { plugins: { enabled: { mindmap: true } } },
    });
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: {} } },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writePluginEnabled('mindmap', false);

    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      null,
      null,
      { enabled: { mindmap: false } },
    );
  });

  it('project mode: removes the override when the value equals the global default', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.getGlobalSettings as any).mockResolvedValue({
      status: 'ok',
      data: { plugins: { enabled: { mindmap: true } } },
    });
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: { mindmap: false } } },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writePluginEnabled('mindmap', true);

    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      null,
      null,
      { enabled: {} },
    );
  });

  it('project mode: defaults a missing global entry to true (so overriding to true removes it)', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.getGlobalSettings as any).mockResolvedValue({
      status: 'ok',
      data: { plugins: { enabled: {} } },
    });
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: { mindmap: false } } },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.writePluginEnabled('mindmap', true);

    // true equals the implicit default of true -> override removed.
    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      null,
      null,
      { enabled: {} },
    );
  });
});

describe('[contract] settingsStore.resetPluginOverride', () => {
  beforeEach(resetStore);

  it('is a no-op when no project is open', async () => {
    await settingsStore.resetPluginOverride('mindmap');
    expect(commands.writeProjectSettings).not.toHaveBeenCalled();
  });

  it('is a no-op when the plugin has no override in the project config', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: {} } },
    });

    await settingsStore.resetPluginOverride('mindmap');

    expect(commands.writeProjectSettings).not.toHaveBeenCalled();
  });

  it('removes the override and reloads effective settings', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: { mindmap: false } } },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.getEffectiveSettings as any).mockResolvedValue({
      status: 'ok',
      data: { ...DEFAULT_EFFECTIVE, plugins: { enabled: { mindmap: true } }, is_project_scoped: true },
    });

    await settingsStore.resetPluginOverride('mindmap');

    expect(commands.writeProjectSettings).toHaveBeenCalledWith(
      '/proj',
      null,
      null,
      { enabled: {} },
    );
    // After the reload, inherited global default shows through.
    expect(settingsStore.effective.plugins.enabled.mindmap).toBe(true);
  });

  it('logs and returns on write error', async () => {
    (settingsStore as any).dirPath = '/proj';
    (commands.readProjectConfig as any).mockResolvedValue({
      status: 'ok',
      data: { project: null, view: null, new_file: null, plugins: { enabled: { mindmap: false } } },
    });
    (commands.writeProjectSettings as any).mockResolvedValue({
      status: 'error',
      error: 'permission',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await settingsStore.resetPluginOverride('mindmap');

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('[contract] settingsStore.promoteToGlobal', () => {
  beforeEach(resetStore);

  it('writes the current effective settings as the new globals', async () => {
    settingsStore.effective = {
      ...DEFAULT_EFFECTIVE,
      view: { sort_mode: 'mtime-desc', show_hidden_files: true },
      new_file: {
        template: 'Chapter {N}',
        detect_from_folder: false,
        auto_rename_from_h1: false,
        default_dir: null,
        last_used_dir: null,
      },
      plugins: { enabled: { mindmap: false } },
    };
    (commands.writeGlobalSettings as any).mockResolvedValue({ status: 'ok', data: null });

    await settingsStore.promoteToGlobal();

    expect(commands.writeGlobalSettings).toHaveBeenCalledWith(
      { sort_mode: 'mtime-desc', show_hidden_files: true },
      { template: 'Chapter {N}', detect_from_folder: false, auto_rename_from_h1: false },
      { enabled: { mindmap: false } },
    );
  });

  it('logs but does not throw on IPC error', async () => {
    (commands.writeGlobalSettings as any).mockResolvedValue({
      status: 'error',
      error: 'EIO',
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(settingsStore.promoteToGlobal()).resolves.not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
