import type { ProjectConfig } from '$lib/ipc/commands';
import { commands } from '$lib/ipc/commands';
import { extensionStore } from '$lib/stores/extensions.svelte';
import { t } from '$lib/i18n';

export const BOOK_TRANSLATION_PLUGIN_ID = 'book-translation';
export const BOOK_TRANSLATION_PROJECT_TYPE = 'book-translation';

export function isBookTranslationProject(config: ProjectConfig | null | undefined): boolean {
  return config?.project.type === BOOK_TRANSLATION_PROJECT_TYPE;
}

export async function ensureBookTranslationPluginReady(): Promise<string | null> {
  if (extensionStore.getFileHandler('chapter.novtrans')) return null;

  const plugins = await commands.listPlugins();
  if (plugins.status === 'error') return plugins.error;
  const plugin = plugins.data.find((candidate) => candidate.id === BOOK_TRANSLATION_PLUGIN_ID);
  if (!plugin) return t('translationImport.pluginUnavailable');

  if (!plugin.enabled) {
    const enabled = await commands.setPluginEnabled(BOOK_TRANSLATION_PLUGIN_ID, true);
    if (enabled.status === 'error') return enabled.error;
  }

  await extensionStore.loadFromPlugins();
  return extensionStore.getFileHandler('chapter.novtrans')
    ? null
    : t('translationImport.editorUnavailable');
}
