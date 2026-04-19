import { commands } from '$lib/ipc/commands';
import { convertFileSrc } from '@tauri-apps/api/core';

export interface UIExtension {
  pluginId: string;
  type: 'panel' | 'file-handler';
  label: string;
  entryUrl: string;
  width?: number;
  fileExtensions?: string[];
}

class ExtensionStore {
  panels = $state<UIExtension[]>([]);
  fileHandlers = $state<UIExtension[]>([]);
  activePanelId = $state<string | null>(null);

  async loadFromPlugins() {
    try {
      const result = await commands.listPlugins();
      if (result.status === 'error') return;
      this.panels = [];
      this.fileHandlers = [];

      for (const plugin of result.data) {
        if (!plugin.ui) continue;

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
          this.panels.push(ext);
        } else if (ext.type === 'file-handler') {
          this.fileHandlers.push(ext);
        }
      }
    } catch (e) {
      console.warn('Failed to load UI extensions:', e);
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

  getFileHandler(fileName: string): UIExtension | null {
    if (!fileName) return null;
    const lower = fileName.toLowerCase();
    return this.fileHandlers.find(h =>
      h.fileExtensions?.some(ext => lower.endsWith(ext))
    ) ?? null;
  }
}

export const extensionStore = new ExtensionStore();
