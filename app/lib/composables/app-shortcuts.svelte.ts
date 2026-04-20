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
    if (mod && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      ctx.openNewWindow();
      return;
    }

    // Cmd+S: save current file (works even when editor isn't focused)
    if (mod && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      ctx.saveActiveFile();
      return;
    }

    // Cmd+Shift+F: project search
    if (mod && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      ctx.toggleProjectSearch();
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: cycle active pane's tab (next / previous).
    // Use ctrlKey specifically (not metaKey) because Cmd+Tab is reserved by
    // macOS for app switching and never reaches the webview.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
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

    // Zoom
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      uiStore.zoomIn();
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      uiStore.zoomOut();
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      uiStore.resetZoom();
      return;
    }

    // Cmd+1~9: switch to recent project
    if (mod && !e.shiftKey && e.key >= '1' && e.key <= '9') {
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
    // the command registry so palette and keyboard run the same handler.
    for (const cmdId of shortcutsStore.allCommandIds) {
      const shortcut = shortcutsStore.get(cmdId);
      if (shortcut && matchesShortcut(e, shortcut)) {
        e.preventDefault();
        commandRegistry.execute(cmdId);
        return;
      }
    }
  };
}
