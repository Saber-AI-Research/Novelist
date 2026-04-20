/**
 * Unified settings store.
 *
 * Reads effective settings (global merged with project overlay) from the
 * backend on `load()`, exposes them as reactive rune state, and routes writes
 * to the right layer:
 *   - project open → writes to `<project>/.novelist/project.toml`
 *   - no project   → writes to `~/.novelist/settings.json`
 *
 * For plugins specifically, the project file stores only the delta (entries
 * that differ from the global default), keeping the file compact.
 */
import {
  commands,
  type EffectiveSettings,
  type NewFileConfig,
  type PluginsConfig,
  type ViewConfig,
} from '$lib/ipc/commands';

const DEFAULT_EFFECTIVE: EffectiveSettings = {
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

class SettingsStore {
  effective = $state<EffectiveSettings>(DEFAULT_EFFECTIVE);
  private dirPath = $state<string | null>(null);

  get isProjectScoped(): boolean {
    return this.dirPath !== null;
  }

  /** Load effective settings for the given scope. `null` = global/scratch mode. */
  async load(dirPath: string | null): Promise<void> {
    this.dirPath = dirPath;
    // Running outside Tauri (e.g. unit tests under happy-dom) → invoke throws.
    // Fall back to defaults rather than propagating.
    try {
      // Seamless migration pass before loading — projects opened for the first
      // time after the 0.2.x settings-layer change pick up the old localStorage
      // values and persist them into project.toml, then the keys are cleared.
      if (dirPath) {
        await this.migrateFromLocalStorage(dirPath);
      }
      const res = await commands.getEffectiveSettings(dirPath);
      if (res.status === 'ok') {
        this.effective = res.data;
      } else {
        console.error('[settings] load failed:', res.error);
        this.effective = { ...DEFAULT_EFFECTIVE, is_project_scoped: dirPath !== null };
      }
    } catch (e) {
      this.effective = { ...DEFAULT_EFFECTIVE, is_project_scoped: dirPath !== null };
    }
  }

  /**
   * If the project file has no `[view]` / `[new_file]` section yet but the old
   * localStorage keys exist, copy them into project.toml and delete the keys.
   *
   * Runs once per project on first load. No-op when the project already has
   * the sections or the keys are absent.
   */
  private async migrateFromLocalStorage(dirPath: string): Promise<void> {
    if (typeof localStorage === 'undefined') return;

    const sortKey = `novelist.sortMode.${dirPath}`;
    const newFileKey = 'novelist.newFileSettings.v1';
    const legacySort = localStorage.getItem(sortKey);
    const legacyNewFile = localStorage.getItem(newFileKey);
    if (!legacySort && !legacyNewFile) return;

    // Check raw project config: only migrate when the section is missing
    // (don't overwrite explicit per-project choices that might already exist).
    const raw = await commands.readProjectConfig(dirPath);
    if (raw.status !== 'ok') return;

    const hasView = !!raw.data.view && Object.keys(raw.data.view).length > 0;
    const hasNewFile = !!raw.data.new_file && Object.keys(raw.data.new_file).length > 0;

    let didMigrateSort = false;
    let didMigrateNewFile = false;

    if (legacySort && !hasView) {
      const res = await commands.writeProjectSettings(
        dirPath,
        { sort_mode: legacySort, show_hidden_files: null },
        null,
        null
      );
      if (res.status === 'ok') didMigrateSort = true;
    }

    if (legacyNewFile && !hasNewFile) {
      try {
        const parsed = JSON.parse(legacyNewFile) as {
          template?: string;
          detectFromFolder?: boolean;
          autoRenameFromH1?: boolean;
        };
        const res = await commands.writeProjectSettings(dirPath, null, {
          template: parsed.template ?? null,
          detect_from_folder:
            typeof parsed.detectFromFolder === 'boolean' ? parsed.detectFromFolder : null,
          auto_rename_from_h1:
            typeof parsed.autoRenameFromH1 === 'boolean' ? parsed.autoRenameFromH1 : null,
        }, null);
        if (res.status === 'ok') didMigrateNewFile = true;
      } catch {
        // Malformed legacy value — drop silently; user can reconfigure.
        didMigrateNewFile = true;
      }
    }

    // Only clear the sort key (project-scoped). The newFile key could be
    // used by other projects that haven't opened yet — keep it until we've
    // migrated every project. A simple heuristic: keep it around; it only
    // acts as a fallback, and future loads of this project won't re-trigger
    // migration because the project now has `[new_file]`.
    if (didMigrateSort) {
      localStorage.removeItem(sortKey);
    }
    // Note: we intentionally DON'T remove the newFileKey — other projects
    // may still need it for their own first migration. It becomes dormant
    // once every project has migrated.
    void didMigrateNewFile;
  }

  /** Patch view fields. Writes to the current scope (project if open, else global). */
  async writeView(patch: Partial<ViewConfig>): Promise<void> {
    const current = this.effective.view;
    const next: ViewConfig = {
      sort_mode: patch.sort_mode ?? current.sort_mode,
      show_hidden_files: patch.show_hidden_files ?? current.show_hidden_files,
    };
    const res = this.dirPath
      ? await commands.writeProjectSettings(this.dirPath, next, null, null)
      : await commands.writeGlobalSettings(next, null, null);
    if (res.status !== 'ok') {
      console.error('[settings] writeView failed:', res.error);
      return;
    }
    this.effective = {
      ...this.effective,
      view: {
        sort_mode: next.sort_mode ?? DEFAULT_EFFECTIVE.view.sort_mode,
        show_hidden_files: next.show_hidden_files ?? DEFAULT_EFFECTIVE.view.show_hidden_files,
      },
    };
  }

  async writeNewFile(patch: Partial<NewFileConfig>): Promise<void> {
    const current = this.effective.new_file;
    const next: NewFileConfig = {
      template: patch.template ?? current.template,
      detect_from_folder: patch.detect_from_folder ?? current.detect_from_folder,
      auto_rename_from_h1: patch.auto_rename_from_h1 ?? current.auto_rename_from_h1,
    };
    const res = this.dirPath
      ? await commands.writeProjectSettings(this.dirPath, null, next, null)
      : await commands.writeGlobalSettings(null, next, null);
    if (res.status !== 'ok') {
      console.error('[settings] writeNewFile failed:', res.error);
      return;
    }
    this.effective = {
      ...this.effective,
      new_file: {
        template: next.template ?? DEFAULT_EFFECTIVE.new_file.template,
        detect_from_folder: next.detect_from_folder ?? DEFAULT_EFFECTIVE.new_file.detect_from_folder,
        auto_rename_from_h1: next.auto_rename_from_h1 ?? DEFAULT_EFFECTIVE.new_file.auto_rename_from_h1,
        default_dir: next.default_dir ?? null,
        last_used_dir: next.last_used_dir ?? null,
      },
    };
  }

  /**
   * Record the directory the user most recently created a file in.
   * Called after every successful create flow so Cmd+N can reuse it.
   * No-op when a pinned `default_dir` is set (pin wins over recency).
   */
  async recordLastUsedDir(dir: string): Promise<void> {
    // Pinned default wins — tracking the recency would be misleading.
    if (this.effective.new_file.default_dir) return;
    if (this.effective.new_file.last_used_dir === dir) return;
    await this.writeNewFile({ last_used_dir: dir });
  }

  /** Set or clear the pinned default directory for new files. */
  async setDefaultDir(dir: string | null): Promise<void> {
    await this.writeNewFile({ default_dir: dir });
  }

  /**
   * Where Cmd+N should create next, given a project fallback. Respects the
   * pinned `default_dir` first, then the live `last_used_dir`, then the
   * project root.
   */
  resolveNewFileDir(projectRoot: string): string {
    return (
      this.effective.new_file.default_dir ||
      this.effective.new_file.last_used_dir ||
      projectRoot
    );
  }

  /**
   * Set a plugin's enabled state in the current scope.
   *
   * Project mode: store delta only. If the new value matches the global
   * default, the project override is removed (so the project inherits).
   * Scratch mode: update the global map.
   */
  async writePluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (!this.dirPath) {
      // Global mode — write full map.
      const nextMap: Record<string, boolean> = {
        ...this.effective.plugins.enabled,
        [pluginId]: enabled,
      };
      const res = await commands.writeGlobalSettings(null, null, { enabled: nextMap });
      if (res.status !== 'ok') {
        console.error('[settings] writePluginEnabled (global) failed:', res.error);
        return;
      }
      this.effective = {
        ...this.effective,
        plugins: { enabled: nextMap },
      };
      return;
    }

    // Project mode — compute delta relative to global defaults.
    const globalRes = await commands.getGlobalSettings();
    const globalMap: Record<string, boolean> =
      globalRes.status === 'ok' ? globalRes.data.plugins?.enabled ?? {} : {};
    const projectCfg = await commands.readProjectConfig(this.dirPath);
    const currentOverrides: Record<string, boolean> =
      projectCfg.status === 'ok' ? projectCfg.data.plugins?.enabled ?? {} : {};

    const nextOverrides = { ...currentOverrides };
    const defaultVal = pluginId in globalMap ? globalMap[pluginId] : true;
    if (enabled === defaultVal) {
      delete nextOverrides[pluginId];
    } else {
      nextOverrides[pluginId] = enabled;
    }
    const res = await commands.writeProjectSettings(
      this.dirPath,
      null,
      null,
      { enabled: nextOverrides }
    );
    if (res.status !== 'ok') {
      console.error('[settings] writePluginEnabled (project) failed:', res.error);
      return;
    }
    this.effective = {
      ...this.effective,
      plugins: {
        enabled: { ...this.effective.plugins.enabled, [pluginId]: enabled },
      },
    };
  }

  /** Project-only: reset a plugin's override so it inherits the global default. */
  async resetPluginOverride(pluginId: string): Promise<void> {
    if (!this.dirPath) return;
    const projectCfg = await commands.readProjectConfig(this.dirPath);
    const current: Record<string, boolean> =
      projectCfg.status === 'ok' ? projectCfg.data.plugins?.enabled ?? {} : {};
    if (!(pluginId in current)) return;
    const next = { ...current };
    delete next[pluginId];
    const res = await commands.writeProjectSettings(this.dirPath, null, null, { enabled: next });
    if (res.status !== 'ok') {
      console.error('[settings] resetPluginOverride failed:', res.error);
      return;
    }
    // Refresh resolved state from backend so the UI reflects the inherited value.
    await this.load(this.dirPath);
  }

  /**
   * Promote the current project-scoped settings to global defaults.
   * Useful for "Save as global default" action in the plugin UX.
   */
  async promoteToGlobal(): Promise<void> {
    // Write the current resolved effective settings as the new globals.
    const v: ViewConfig = {
      sort_mode: this.effective.view.sort_mode,
      show_hidden_files: this.effective.view.show_hidden_files,
    };
    const n: NewFileConfig = {
      template: this.effective.new_file.template,
      detect_from_folder: this.effective.new_file.detect_from_folder,
      auto_rename_from_h1: this.effective.new_file.auto_rename_from_h1,
    };
    const p: PluginsConfig = { enabled: { ...this.effective.plugins.enabled } };
    const res = await commands.writeGlobalSettings(v, n, p);
    if (res.status !== 'ok') {
      console.error('[settings] promoteToGlobal failed:', res.error);
    }
  }
}

export const settingsStore = new SettingsStore();
