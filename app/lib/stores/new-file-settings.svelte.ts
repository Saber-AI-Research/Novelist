/**
 * Thin compatibility shim over `settingsStore`.
 *
 * The legacy surface (`newFileSettings.template`, `.detectFromFolder`,
 * `.autoRenameFromH1`) is kept so call sites don't all need to change at
 * once. All reads/writes go through the unified settings store.
 */
import { parseTemplate } from '$lib/utils/placeholder';
import { settingsStore } from '$lib/stores/settings.svelte';

class NewFileSettingsShim {
  get template(): string {
    return settingsStore.effective.new_file.template;
  }
  get detectFromFolder(): boolean {
    return settingsStore.effective.new_file.detect_from_folder;
  }
  get autoRenameFromH1(): boolean {
    return settingsStore.effective.new_file.auto_rename_from_h1;
  }

  setTemplate(template: string): void {
    if (!parseTemplate(template)) {
      throw new Error(`Invalid template: ${template}`);
    }
    void settingsStore.writeNewFile({ template });
  }

  setDetectFromFolder(value: boolean): void {
    void settingsStore.writeNewFile({ detect_from_folder: value });
  }

  setAutoRenameFromH1(value: boolean): void {
    void settingsStore.writeNewFile({ auto_rename_from_h1: value });
  }
}

export const newFileSettings = new NewFileSettingsShim();
