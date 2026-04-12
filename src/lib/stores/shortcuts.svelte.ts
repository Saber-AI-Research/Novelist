import { en } from '$lib/i18n/locales/en';

const SHORTCUTS_KEY = 'novelist-shortcuts';

/** Map commandId → i18n key for labels. */
const commandI18nKeys: Record<string, string> = {
  'toggle-sidebar': 'command.toggleSidebar',
  'toggle-outline': 'command.toggleOutline',
  'toggle-draft': 'command.toggleDraft',
  'toggle-snapshot': 'command.toggleSnapshot',
  'toggle-stats': 'command.toggleStats',
  'toggle-zen': 'command.toggleZen',
  'command-palette': 'command.commandPalette',
  'toggle-split': 'command.toggleSplit',
  'new-file': 'command.newFile',
  'export-project': 'command.exportProject',
  'close-tab': 'command.closeTab',
  'open-settings': 'command.openSettings',
  'go-to-line': 'command.goToLine',
  'editor-bold': 'command.bold',
  'editor-italic': 'command.italic',
  'editor-link': 'command.insertLink',
  'editor-heading': 'command.toggleHeading',
  'editor-code-inline': 'command.inlineCode',
  'editor-strikethrough': 'command.strikethrough',
};

const defaultShortcuts: Record<string, string> = {
  'toggle-sidebar': 'Cmd+Shift+B',
  'toggle-outline': 'Cmd+Shift+O',
  'toggle-draft': 'Cmd+Shift+D',
  'toggle-snapshot': 'Cmd+Shift+S',
  'toggle-stats': 'Cmd+Shift+T',
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

// Lazy reference to the i18n `t` function. We can't import it eagerly because
// the i18n module uses `$state` which only exists in the Svelte compile context.
let _t: ((key: string) => string) | null = null;

/** Resolve a command label — uses i18n `t()` if available, falls back to English. */
function resolveLabel(i18nKey: string): string {
  if (!_t) {
    try {
      // Vite supports dynamic import() but this getter is synchronous.
      // Instead, we rely on the eager import of `en` as fallback.
      // The Svelte compiler will have loaded i18n by the time components render.
      const val = en[i18nKey];
      return typeof val === 'string' ? val : i18nKey.split('.').pop() ?? i18nKey;
    } catch {
      return i18nKey.split('.').pop() ?? i18nKey;
    }
  }
  return _t(i18nKey);
}

/** Called by components to wire up the live i18n function. */
export function initShortcutsI18n(tFn: (key: string) => string) {
  _t = tFn;
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
    const result: Record<string, string> = {};
    for (const id of Object.keys(commandI18nKeys)) {
      result[id] = resolveLabel(commandI18nKeys[id]);
    }
    return result;
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
