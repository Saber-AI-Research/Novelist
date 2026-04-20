import { commands } from '$lib/ipc/commands';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface UIExtension {
  pluginId: string;
  type: 'panel' | 'file-handler';
  label: string;
  /** Empty string for built-in panels; asset:// URL for iframe-loaded plugins. */
  entryUrl: string;
  width?: number;
  fileExtensions?: string[];
  /** True for first-party panels rendered as native Svelte components. */
  builtin?: boolean;
}

/**
 * First-party panels that are always present, rendered as native Svelte
 * components by `app/App.svelte` (no iframe). Hardcoded routing in App.svelte
 * intercepts their pluginId and chooses the matching native shim.
 */
const BUILTIN_PANELS: UIExtension[] = [
  {
    pluginId: 'ai-talk',
    type: 'panel',
    label: 'AI Talk',
    entryUrl: '',
    builtin: true,
  },
  {
    pluginId: 'ai-agent',
    type: 'panel',
    label: 'AI Agent',
    entryUrl: '',
    builtin: true,
  },
];

class ExtensionStore {
  panels = $state<UIExtension[]>([...BUILTIN_PANELS]);
  fileHandlers = $state<UIExtension[]>([]);
  activePanelId = $state<string | null>(null);

  async loadFromPlugins() {
    try {
      const result = await commands.listPlugins();
      if (result.status === 'error') {
        // Built-ins still available even if disk discovery fails.
        this.panels = [...BUILTIN_PANELS];
        this.fileHandlers = [];
        return;
      }
      const fromDisk: UIExtension[] = [];
      const fileHandlers: UIExtension[] = [];

      for (const plugin of result.data) {
        if (!plugin.ui) continue;
        // Skip if a built-in already owns this id (avoid double-listing).
        if (BUILTIN_PANELS.some((p) => p.pluginId === plugin.id)) continue;

        const basePath = `${await this.getPluginsDir()}/${plugin.id}`;
        const entryUrl = convertFileSrc(`${basePath}/${plugin.ui.entry}`);

        const ext: UIExtension = {
          pluginId: plugin.id,
          type: plugin.ui.type as 'panel' | 'file-handler',
          label: plugin.ui.label ?? plugin.name,
          entryUrl,
          width: plugin.ui.width ?? undefined,
          fileExtensions: plugin.ui.file_extensions ?? undefined,
        };

        if (ext.type === 'panel') {
          fromDisk.push(ext);
        } else if (ext.type === 'file-handler') {
          fileHandlers.push(ext);
        }
      }

      this.panels = [...BUILTIN_PANELS, ...fromDisk];
      this.fileHandlers = fileHandlers;
    } catch (e) {
      console.warn('Failed to load UI extensions:', e);
      this.panels = [...BUILTIN_PANELS];
      this.fileHandlers = [];
    }
  }

  private async getPluginsDir(): Promise<string> {
    const result = await commands.getPluginsDir();
    if (result.status === 'ok') return result.data;
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    const sep = home.endsWith('/') ? '' : '/';
    return `${home}${sep}.novelist/plugins`;
  }

  togglePanel(pluginId: string) {
    this.activePanelId = this.activePanelId === pluginId ? null : pluginId;
  }

  /** Set the active panel to a specific id (vs. the toggle behavior). */
  openPanel(pluginId: string) {
    this.activePanelId = pluginId;
  }

  getFileHandler(fileName: string): UIExtension | null {
    if (!fileName) return null;
    const lower = fileName.toLowerCase();
    return this.fileHandlers.find((h) =>
      h.fileExtensions?.some((ext) => lower.endsWith(ext)),
    ) ?? null;
  }
}

export const extensionStore = new ExtensionStore();
