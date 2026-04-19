import { parseTemplate } from '$lib/utils/placeholder';

const STORAGE_KEY = 'novelist.newFileSettings.v1';

interface SettingsShape {
  template: string;
  detectFromFolder: boolean;
  autoRenameFromH1: boolean;
}

const DEFAULTS: SettingsShape = {
  template: 'Untitled {N}',
  detectFromFolder: true,
  autoRenameFromH1: true,
};

class NewFileSettingsStore {
  template = $state<string>(DEFAULTS.template);
  detectFromFolder = $state<boolean>(DEFAULTS.detectFromFolder);
  autoRenameFromH1 = $state<boolean>(DEFAULTS.autoRenameFromH1);

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.template = DEFAULTS.template;
        this.detectFromFolder = DEFAULTS.detectFromFolder;
        this.autoRenameFromH1 = DEFAULTS.autoRenameFromH1;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<SettingsShape>;
      this.template = parsed.template ?? DEFAULTS.template;
      this.detectFromFolder = parsed.detectFromFolder ?? DEFAULTS.detectFromFolder;
      this.autoRenameFromH1 = parsed.autoRenameFromH1 ?? DEFAULTS.autoRenameFromH1;
    } catch {
      this.template = DEFAULTS.template;
      this.detectFromFolder = DEFAULTS.detectFromFolder;
      this.autoRenameFromH1 = DEFAULTS.autoRenameFromH1;
    }
  }

  private persist(): void {
    const data: SettingsShape = {
      template: this.template,
      detectFromFolder: this.detectFromFolder,
      autoRenameFromH1: this.autoRenameFromH1,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  setTemplate(template: string): void {
    if (!parseTemplate(template)) {
      throw new Error(`Invalid template: ${template}`);
    }
    this.template = template;
    this.persist();
  }

  setDetectFromFolder(value: boolean): void {
    this.detectFromFolder = value;
    this.persist();
  }

  setAutoRenameFromH1(value: boolean): void {
    this.autoRenameFromH1 = value;
    this.persist();
  }
}

export const newFileSettings = new NewFileSettingsStore();

// Auto-load on module init
if (typeof localStorage !== 'undefined') {
  newFileSettings.load();
}
