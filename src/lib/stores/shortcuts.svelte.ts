const SHORTCUTS_KEY = 'novelist-shortcuts';

const defaultShortcuts: Record<string, string> = {
  'toggle-sidebar': 'Cmd+Shift+B',
  'toggle-outline': 'Cmd+Shift+O',
  'toggle-draft': 'Cmd+Shift+D',
  'toggle-snapshot': 'Cmd+Shift+S',
  'toggle-stats': 'Cmd+Shift+T',
  'toggle-mindmap': 'Cmd+Shift+M',
  'toggle-zen': 'F11',
  'command-palette': 'Cmd+Shift+P',
  'toggle-split': 'Cmd+\\',
  'new-file': 'Cmd+N',
  'export-project': 'Cmd+P',
  'close-tab': 'Cmd+W',
  'open-settings': 'Cmd+,',
  'go-to-line': 'Cmd+G',

  // Editor formatting shortcuts
  'editor-bold': 'Cmd+B',
  'editor-italic': 'Cmd+I',
  'editor-link': 'Cmd+K',
  'editor-heading': 'Cmd+H',
  'editor-code-inline': 'Cmd+E',
  'editor-strikethrough': 'Cmd+Shift+X',
};

const commandLabels: Record<string, string> = {
  'toggle-sidebar': 'Toggle Sidebar',
  'toggle-outline': 'Toggle Outline',
  'toggle-draft': 'Toggle Draft Note',
  'toggle-snapshot': 'Toggle Snapshots',
  'toggle-stats': 'Toggle Writing Stats',
  'toggle-mindmap': 'Toggle Mindmap',
  'toggle-zen': 'Toggle Zen Mode',
  'command-palette': 'Command Palette',
  'toggle-split': 'Toggle Split View',
  'new-file': 'New File',
  'export-project': 'Export Project',
  'close-tab': 'Close Tab',
  'open-settings': 'Open Settings',
  'go-to-line': 'Go to Line',

  // Editor formatting
  'editor-bold': 'Bold',
  'editor-italic': 'Italic',
  'editor-link': 'Insert Link',
  'editor-heading': 'Toggle Heading',
  'editor-code-inline': 'Inline Code',
  'editor-strikethrough': 'Strikethrough',
};

/** Command IDs that are editor-formatting actions (used to group in Settings). */
export const editorCommandIds = [
  'editor-bold',
  'editor-italic',
  'editor-link',
  'editor-heading',
  'editor-code-inline',
  'editor-strikethrough',
];

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

/**
 * Match a KeyboardEvent against a shortcut string like "Cmd+Shift+O" or "F11".
 * Returns true if the event matches.
 */
export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false;

  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1).map(m => m.toLowerCase()));

  const needsCmd = modifiers.has('cmd');
  const needsShift = modifiers.has('shift');
  const needsAlt = modifiers.has('alt');

  const mod = e.metaKey || e.ctrlKey;

  if (needsCmd !== mod) return false;
  if (needsShift !== e.shiftKey) return false;
  if (needsAlt !== e.altKey) return false;

  // Normalize the event key for comparison
  let eventKey = e.key;
  if (eventKey === ' ') eventKey = 'Space';

  // Case-insensitive key match
  return eventKey.toLowerCase() === key.toLowerCase();
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

  /** App-level command IDs (for grouping in Settings). */
  get appCommandIds(): string[] {
    return Object.keys(defaultShortcuts).filter(id => !editorCommandIds.includes(id));
  }

  isCustomized(commandId: string): boolean {
    return commandId in this.overrides;
  }
}

export const shortcutsStore = new ShortcutsStore();
