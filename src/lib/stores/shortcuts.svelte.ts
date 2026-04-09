const SHORTCUTS_KEY = 'novelist-shortcuts';

const defaultShortcuts: Record<string, string> = {
  'toggle-sidebar': 'Cmd+B',
  'toggle-outline': 'Cmd+Shift+O',
  'toggle-draft': 'Cmd+Shift+D',
  'toggle-zen': 'F11',
  'command-palette': 'Cmd+Shift+P',
  'toggle-split': 'Cmd+\\',
  'new-file': 'Cmd+N',
  'export-project': 'Cmd+P',
  'close-tab': 'Cmd+W',
  'open-settings': 'Cmd+,',
  'go-to-line': 'Cmd+G',
};

const commandLabels: Record<string, string> = {
  'toggle-sidebar': 'Toggle Sidebar',
  'toggle-outline': 'Toggle Outline',
  'toggle-draft': 'Toggle Draft Note',
  'toggle-zen': 'Toggle Zen Mode',
  'command-palette': 'Command Palette',
  'toggle-split': 'Toggle Split View',
  'new-file': 'New File',
  'export-project': 'Export Project',
  'close-tab': 'Close Tab',
  'open-settings': 'Open Settings',
  'go-to-line': 'Go to Line',
};

function loadOverrides(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SHORTCUTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

function saveOverrides(overrides: Record<string, string>) {
  localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(overrides));
}

class ShortcutsStore {
  overrides = $state<Record<string, string>>(loadOverrides());

  get(commandId: string): string {
    return this.overrides[commandId] ?? defaultShortcuts[commandId] ?? '';
  }

  set(commandId: string, shortcut: string) {
    this.overrides = { ...this.overrides, [commandId]: shortcut };
    saveOverrides(this.overrides);
  }

  reset(commandId: string) {
    const { [commandId]: _, ...rest } = this.overrides;
    this.overrides = rest;
    saveOverrides(this.overrides);
  }

  resetAll() {
    this.overrides = {};
    saveOverrides({});
  }

  get defaults(): Record<string, string> {
    return defaultShortcuts;
  }

  get labels(): Record<string, string> {
    return commandLabels;
  }

  get allCommandIds(): string[] {
    return Object.keys(defaultShortcuts);
  }

  isCustomized(commandId: string): boolean {
    return commandId in this.overrides;
  }
}

export const shortcutsStore = new ShortcutsStore();
