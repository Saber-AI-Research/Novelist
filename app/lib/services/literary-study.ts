import type { ProjectConfig } from '$lib/ipc/commands';
import { commands } from '$lib/ipc/commands';
import { extensionStore } from '$lib/stores/extensions.svelte';

export const LITERARY_PLUGIN_ID = 'literary-commentary';
export const LITERARY_PROJECT_TYPE = 'literary-study';

export function isLiteraryStudyProject(config: ProjectConfig | null | undefined): boolean {
  return config?.project.type === LITERARY_PROJECT_TYPE;
}

export async function ensureLiteraryPluginReady(): Promise<string | null> {
  if (extensionStore.getFileHandler('chapter.litstudy')) return null;

  const plugins = await commands.listPlugins();
  if (plugins.status === 'error') return plugins.error;
  const plugin = plugins.data.find((candidate) => candidate.id === LITERARY_PLUGIN_ID);
  if (!plugin) return 'The bundled Literary Commentary plugin is unavailable';

  if (!plugin.enabled) {
    const enabled = await commands.setPluginEnabled(LITERARY_PLUGIN_ID, true);
    if (enabled.status === 'error') return enabled.error;
  }

  await extensionStore.loadFromPlugins();
  return extensionStore.getFileHandler('chapter.litstudy')
    ? null
    : 'The Literary Commentary editor could not be loaded';
}
