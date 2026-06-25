import { uiStore } from '$lib/stores/ui.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { commandRegistry } from '$lib/stores/commands.svelte';
import { shortcutsStore, matchesShortcut } from '$lib/stores/shortcuts.svelte';
import type { RecentProject } from '$lib/ipc/commands';

export type AppShortcutContext = {
  openNewWindow: () => void;
  saveActiveFile: () => void;
  toggleProjectSearch: () => void;
  getRecentProjects: () => RecentProject[];
  openProjectFromPath: (path: string) => void;
};

/**
 * True when the keystroke originates from a text input that is NOT the
 * CodeMirror editor — e.g. the AI composer textarea, a dialog field, or any
 * other `<input>/<textarea>/[contenteditable]`. The editor lives inside
 * `.cm-editor` and must keep its global shortcuts (formatting, save), so it
 * is explicitly excluded. Used to stop tab-cycling and customizable shortcuts
 * (close-tab, new-file, …) from leaking out of focused panels/dialogs.
 */
function isNonEditorTextInput(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.cm-editor')) return false;
  return !!el.closest('input, textarea, [contenteditable="true"]');
}

/**
 * Panel-scoped commands that must still fire while a non-editor text input is
 * focused — these are invoked precisely *from* the AI composer (start a fresh
 * session, save the chat), so the general non-editor-input suppression must not
 * swallow them.
 */
const INPUT_ALLOWED_COMMANDS = new Set<string>([
  'ai-talk-new-session',
  'ai-agent-new-session',
  'ai-talk-save-chat',
]);

/**
 * Build the global keydown handler. Handles non-customizable shortcuts
 * (new-window, save, project-search, zoom, Cmd+1-9, Escape-zen) inline,
 * then dispatches customizable ones through the command registry.
 *
 * Keeping routing on the command registry (rather than a parallel handler
 * map) means customizable shortcuts always invoke the same handler as the
 * command palette, with no chance of drift.
 */
export function createKeydownHandler(ctx: AppShortcutContext) {
  return function handleKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+Shift+N: new window
    if (mod && !e.altKey && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      ctx.openNewWindow();
      return;
    }

    // Cmd+S: save current file (works even when editor isn't focused)
    if (mod && !e.altKey && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      ctx.saveActiveFile();
      return;
    }

    // Cmd+Shift+F: project search
    if (mod && !e.altKey && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      ctx.toggleProjectSearch();
      return;
    }

    // Don't let tab-cycling or customizable shortcuts (close-tab, new-file,
    // formatting, …) leak into the main editor while a non-editor text input
    // is focused — e.g. the AI composer or a dialog field. Globals handled
    // above this point (save, zoom, new-window, project-search) stay active.
    const inNonEditorInput = isNonEditorTextInput(e);

    // Ctrl+Tab / Ctrl+Shift+Tab: cycle active pane's tab (next / previous).
    // Use ctrlKey specifically (not metaKey) because Cmd+Tab is reserved by
    // macOS for app switching and never reaches the webview.
    if (!inNonEditorInput && e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      tabsStore.cycleActiveTab(e.shiftKey ? -1 : 1);
      return;
    }

    // Escape: exit zen mode
    if (e.key === 'Escape' && uiStore.zenMode) {
      e.preventDefault();
      uiStore.toggleZen();
      return;
    }

    // Zoom (require no alt/shift so Cmd+Alt+- etc. can still be customized)
    if (mod && !e.altKey && !e.shiftKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      uiStore.zoomIn();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key === '-') {
      e.preventDefault();
      uiStore.zoomOut();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key === '0') {
      e.preventDefault();
      uiStore.resetZoom();
      return;
    }

    // Cmd+1~9: switch to recent project. MUST exclude alt/shift — otherwise
    // Cmd+Alt+1..5 (right-rail panels) gets swallowed here before the generic
    // loop ever sees it, and every right-panel toggle silently fails.
    if (mod && !e.altKey && !e.shiftKey && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      const recentProjects = ctx.getRecentProjects();
      if (idx < recentProjects.length) {
        const target = recentProjects[idx];
        if (target.path !== projectStore.dirPath) {
          e.preventDefault();
          ctx.openProjectFromPath(target.path);
        }
      }
      return;
    }

    // Customizable shortcuts — match against shortcutsStore, dispatch via
    // the command registry so palette and keyboard run the same handler. While
    // a non-editor input is focused we only allow panel-scoped commands (AI
    // composer session/save), suppressing the rest so they don't leak.
    for (const cmdId of shortcutsStore.allCommandIds) {
      if (inNonEditorInput && !INPUT_ALLOWED_COMMANDS.has(cmdId)) continue;
      const shortcut = shortcutsStore.get(cmdId);
      if (shortcut && matchesShortcut(e, shortcut)) {
        e.preventDefault();
        commandRegistry.execute(cmdId);
        return;
      }
    }
  };
}
