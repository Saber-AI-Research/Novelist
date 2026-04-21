import { en } from '$lib/i18n/locales/en';

const SHORTCUTS_KEY = 'novelist-shortcuts';

/** Map commandId → i18n key for labels. */
const commandI18nKeys: Record<string, string> = {
  'toggle-sidebar': 'command.toggleSidebar',
  'toggle-outline': 'command.toggleOutline',
  'toggle-draft': 'command.toggleDraft',
  'toggle-snapshot': 'command.toggleSnapshot',
  'toggle-stats': 'command.toggleStats',
  'toggle-template': 'command.toggleTemplate',
  'save-current-as-template': 'command.saveCurrentAsTemplate',
  'toggle-zen': 'command.toggleZen',
  'command-palette': 'command.commandPalette',
  'toggle-split': 'command.toggleSplit',
  'new-file': 'command.newFile',
  'open-directory': 'command.openDirectory',
  'export-project': 'command.exportProject',
  'close-tab': 'command.closeTab',
  'rename-file': 'command.renameFile',
  'move-file': 'command.moveFile',
  'open-settings': 'command.openSettings',
  'go-to-line': 'command.goToLine',
  'editor-bold': 'command.bold',
  'editor-italic': 'command.italic',
  'editor-link': 'command.insertLink',
  'editor-heading': 'command.toggleHeading',
  'editor-code-inline': 'command.inlineCode',
  'editor-strikethrough': 'command.strikethrough',
  'toggle-mindmap': 'command.toggleMindmap',
  'toggle-ai-talk': 'command.toggleAiTalk',
  'toggle-ai-agent': 'command.toggleAiAgent',
  'ai-talk-new-session': 'command.aiTalkNewSession',
  'ai-agent-new-session': 'command.aiAgentNewSession',
  'ai-talk-save-chat': 'command.aiTalkSaveChat',
};

/**
 * Right-panel toggles share a single modifier combo (`Cmd+Alt+<digit>`), with
 * the digit matching the button's vertical position in the right rail.
 *
 * Why not letter shortcuts (the old `Cmd+Shift+O/D/S/T` scheme):
 *   - `Cmd+Shift+S` overlaps with "Save As" semantics in most apps.
 *   - `Cmd+Shift+T` is "reopen closed tab" in every browser.
 *   - Letters are arbitrary (T for Stats? S for Snapshot?) — users have to
 *     memorize mappings instead of reading them off the UI.
 *
 * Why not `Cmd+Shift+<digit>`: on macOS, `Cmd+Shift+3/4/5` are reserved by the
 * OS for screenshots, which would silently eat the shortcut.
 *
 * `Cmd+Alt+1..5` is free on macOS and Windows/Linux, scales (new panels get
 * 6, 7, …), and groups cleanly in Settings > Shortcuts.
 */
const defaultShortcuts: Record<string, string> = {
  'toggle-sidebar': 'Cmd+Shift+B',
  'toggle-outline': 'Cmd+Alt+1',
  'toggle-draft': 'Cmd+Alt+2',
  'toggle-snapshot': 'Cmd+Alt+3',
  'toggle-stats': 'Cmd+Alt+4',
  'toggle-template': 'Cmd+Alt+5',
  'save-current-as-template': '',
  'toggle-zen': 'Cmd+Alt+Z',
  'command-palette': 'Cmd+Shift+P',
  'toggle-split': 'Cmd+\\',
  'new-file': 'Cmd+N',
  'open-directory': 'Cmd+O',
  'export-project': 'Cmd+P',
  'close-tab': 'Cmd+W',
  'rename-file': 'Cmd+Shift+R',
  'move-file': 'Cmd+M',
  'open-settings': 'Cmd+,',
  'go-to-line': 'Cmd+G',
  'toggle-mindmap': 'Cmd+Shift+M',

  // AI panels — native built-in right-side panels.
  // Letters chosen to avoid OS/browser conflicts:
  //   Cmd+Shift+L (talk/Language/Letters) for AI Talk
  //   Cmd+Shift+I (agent/Intelligence)    for AI Agent
  'toggle-ai-talk': 'Cmd+Shift+L',
  'toggle-ai-agent': 'Cmd+Shift+I',
  // Panel-internal session shortcuts (only fire while the panel owns focus
  // — router checks this in app-shortcuts). Using Cmd+Alt+N keeps Cmd+N
  // (new file) free.
  'ai-talk-new-session': 'Cmd+Alt+N',
  'ai-agent-new-session': 'Cmd+Alt+Shift+N',
  'ai-talk-save-chat': 'Cmd+Alt+S',

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

  if (eventKey.toLowerCase() === key.toLowerCase()) return true;

  // macOS: Option+<digit/letter> produces special glyphs in e.key (⌥1 → "¡",
  // ⌥a → "å"). Fall back to e.code so the physical-key shortcut still matches.
  const code = (e as KeyboardEvent & { code?: string }).code;
  if (code) {
    if (/^[0-9]$/.test(key) && code === `Digit${key}`) return true;
    if (/^[a-zA-Z]$/.test(key) && code === `Key${key.toUpperCase()}`) return true;
  }
  return false;
}

const IS_MAC = typeof navigator !== 'undefined'
  && /mac|iphone|ipad|ipod/i.test(navigator.userAgent || '');

/**
 * Render a canonical shortcut string ("Cmd+Alt+1") in a platform-native way:
 *   - macOS: Apple symbols in Apple order — "⌥⌘1", "⇧⌘P"
 *   - Other: Cmd is shown as "Ctrl" — "Ctrl+Alt+1"
 *
 * Shortcuts are always STORED in the canonical "Cmd+Alt+Key" form; this
 * helper is only for display.
 */
export function formatShortcut(shortcut: string): string {
  if (!shortcut) return '';
  const parts = shortcut.split('+');
  const rawKey = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map(m => m.toLowerCase()));

  const keyLabel =
    rawKey === 'Space' ? '␣' :
    rawKey === 'ArrowUp' ? '↑' :
    rawKey === 'ArrowDown' ? '↓' :
    rawKey === 'ArrowLeft' ? '←' :
    rawKey === 'ArrowRight' ? '→' :
    rawKey === 'Escape' ? 'Esc' :
    rawKey;

  if (IS_MAC) {
    // Apple order: Control ⌃ · Option ⌥ · Shift ⇧ · Command ⌘ · Key — no separators
    let s = '';
    if (mods.has('ctrl')) s += '⌃';
    if (mods.has('alt')) s += '⌥';
    if (mods.has('shift')) s += '⇧';
    if (mods.has('cmd')) s += '⌘';
    return s + keyLabel;
  }

  const out: string[] = [];
  if (mods.has('cmd') || mods.has('ctrl')) out.push('Ctrl');
  if (mods.has('alt')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  out.push(keyLabel);
  return out.join('+');
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
