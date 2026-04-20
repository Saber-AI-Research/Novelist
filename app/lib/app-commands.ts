import type { EditorView } from '@codemirror/view';
import { commandRegistry } from '$lib/stores/commands.svelte';
import { shortcutsStore } from '$lib/stores/shortcuts.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import * as fmt from '$lib/editor/formatting';

/**
 * Bundle of App.svelte-local references the command handlers need.
 * Passed once into `registerAppCommands`.
 */
export type AppCommandContext = {
  t: (key: string) => string;
  getActiveEditorView: () => EditorView | null;
  renameCurrentFile: () => void;
  // High-level actions owned by App.svelte
  openNewWindow: () => void;
  handleNewFile: () => void;
  handleNewScratchFile: () => void;
  handleOpenDirectory: () => void;
  handleCloseTab: () => void;
  handleGoToLine: () => void;
  saveCurrentFileAsTemplate: () => void;
  // Dialog/palette toggles (own component-local $state)
  togglePalette: () => void;
  openMovePalette: () => void;
  toggleProjectSearch: () => void;
  openExportDialog: () => void;
  openNewProjectDialog: () => void;
  toggleMindmapOverlay: () => void;
  requestProjectSwitcher: () => void;
};

/**
 * Register every app-level command with the command palette. Called once
 * from App.svelte's onMount.
 */
export function registerAppCommands(ctx: AppCommandContext) {
  const { t, getActiveEditorView } = ctx;

  commandRegistry.register({ id: 'new-window', label: t('command.newWindow'), shortcut: 'Cmd+Shift+N', handler: ctx.openNewWindow });
  commandRegistry.register({ id: 'toggle-sidebar', label: t('command.toggleSidebar'), shortcut: shortcutsStore.get('toggle-sidebar'), handler: () => uiStore.toggleSidebar() });
  commandRegistry.register({ id: 'toggle-outline', label: t('command.toggleOutline'), shortcut: shortcutsStore.get('toggle-outline'), handler: () => uiStore.toggleOutline() });
  commandRegistry.register({ id: 'toggle-zen', label: t('command.toggleZen'), shortcut: shortcutsStore.get('toggle-zen'), handler: () => uiStore.toggleZen() });
  commandRegistry.register({ id: 'toggle-draft', label: t('command.toggleDraft'), shortcut: shortcutsStore.get('toggle-draft'), handler: () => uiStore.toggleDraft() });
  commandRegistry.register({ id: 'toggle-snapshot', label: t('command.toggleSnapshot'), shortcut: shortcutsStore.get('toggle-snapshot'), handler: () => uiStore.toggleSnapshot() });
  commandRegistry.register({ id: 'toggle-stats', label: t('command.toggleStats'), shortcut: shortcutsStore.get('toggle-stats'), handler: () => uiStore.toggleStats() });
  commandRegistry.register({ id: 'toggle-template', label: t('command.toggleTemplate'), shortcut: shortcutsStore.get('toggle-template'), handler: () => uiStore.toggleTemplate() });
  commandRegistry.register({ id: 'save-current-as-template', label: t('command.saveCurrentAsTemplate'), shortcut: shortcutsStore.get('save-current-as-template'), handler: ctx.saveCurrentFileAsTemplate });
  commandRegistry.register({ id: 'command-palette', label: t('command.commandPalette'), shortcut: shortcutsStore.get('command-palette'), handler: ctx.togglePalette });
  commandRegistry.register({ id: 'move-file', label: t('command.moveFile'), shortcut: shortcutsStore.get('move-file'), handler: () => {
    if (tabsStore.activeTab && projectStore.dirPath) ctx.openMovePalette();
  }});
  commandRegistry.register({ id: 'project-search', label: t('command.projectSearch'), shortcut: 'Cmd+Shift+F', handler: ctx.toggleProjectSearch });
  commandRegistry.register({ id: 'toggle-split', label: t('command.toggleSplit'), shortcut: shortcutsStore.get('toggle-split'), handler: () => tabsStore.toggleSplit() });
  commandRegistry.register({ id: 'new-file', label: t('command.newFile'), shortcut: shortcutsStore.get('new-file'), handler: () => {
    projectStore.dirPath ? ctx.handleNewFile() : ctx.handleNewScratchFile();
  }});
  commandRegistry.register({ id: 'new-project', label: t('command.newProject'), handler: ctx.openNewProjectDialog });
  commandRegistry.register({ id: 'switch-project', label: t('command.switchProject'), handler: ctx.requestProjectSwitcher });
  commandRegistry.register({ id: 'open-directory', label: t('command.openDirectory'), shortcut: shortcutsStore.get('open-directory'), handler: ctx.handleOpenDirectory });
  commandRegistry.register({ id: 'export-project', label: t('command.exportProject'), shortcut: shortcutsStore.get('export-project'), handler: ctx.openExportDialog });
  commandRegistry.register({ id: 'close-tab', label: t('command.closeTab'), shortcut: shortcutsStore.get('close-tab'), handler: ctx.handleCloseTab });
  commandRegistry.register({ id: 'rename-file', label: t('command.renameFile'), shortcut: shortcutsStore.get('rename-file'), handler: ctx.renameCurrentFile });
  commandRegistry.register({ id: 'open-settings', label: t('command.openSettings'), shortcut: shortcutsStore.get('open-settings'), handler: () => uiStore.toggleSettings() });
  commandRegistry.register({ id: 'go-to-line', label: t('command.goToLine'), shortcut: shortcutsStore.get('go-to-line'), handler: ctx.handleGoToLine });
  commandRegistry.register({ id: 'toggle-mindmap', label: t('command.toggleMindmap'), shortcut: shortcutsStore.get('toggle-mindmap'), handler: ctx.toggleMindmapOverlay });

  // Editor formatting commands
  commandRegistry.register({ id: 'editor-bold', label: t('command.bold'), shortcut: shortcutsStore.get('editor-bold'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '**');
  }});
  commandRegistry.register({ id: 'editor-italic', label: t('command.italic'), shortcut: shortcutsStore.get('editor-italic'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '*');
  }});
  commandRegistry.register({ id: 'editor-link', label: t('command.insertLink'), shortcut: shortcutsStore.get('editor-link'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.wrapSelection(view, '[', '](url)');
  }});
  commandRegistry.register({ id: 'editor-heading', label: t('command.toggleHeading'), shortcut: shortcutsStore.get('editor-heading'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleLinePrefix(view, '#');
  }});
  commandRegistry.register({ id: 'editor-code-inline', label: t('command.inlineCode'), shortcut: shortcutsStore.get('editor-code-inline'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '`');
  }});
  commandRegistry.register({ id: 'editor-strikethrough', label: t('command.strikethrough'), shortcut: shortcutsStore.get('editor-strikethrough'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '~~');
  }});

  // Chinese text tools
  commandRegistry.register({ id: 'chinese-s2t', label: t('command.simplifiedToTraditional'), handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    const { simplifiedToTraditional } = await import('$lib/utils/chinese');
    const converted = await simplifiedToTraditional(text);
    if (from === to) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: converted } });
    } else {
      view.dispatch({
        changes: { from, to, insert: converted },
        selection: { anchor: from, head: from + converted.length },
      });
    }
  }});
  commandRegistry.register({ id: 'chinese-t2s', label: t('command.traditionalToSimplified'), handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    const { traditionalToSimplified } = await import('$lib/utils/chinese');
    const converted = await traditionalToSimplified(text);
    if (from === to) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: converted } });
    } else {
      view.dispatch({
        changes: { from, to, insert: converted },
        selection: { anchor: from, head: from + converted.length },
      });
    }
  }});
  commandRegistry.register({ id: 'chinese-pinyin', label: t('command.generatePinyin'), handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const text = view.state.sliceDoc(from, to);
    const { toPinyin } = await import('$lib/utils/chinese');
    const pinyinText = await toPinyin(text);
    await navigator.clipboard.writeText(pinyinText);
  }});

  // Rich/plain text copy
  commandRegistry.register({ id: 'copy-rich-text', label: t('command.copyRichText'), handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    const { markdownToHtml } = await import('$lib/utils/markdown-copy');
    const html = markdownToHtml(text);
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  }});
  commandRegistry.register({ id: 'copy-plain-text', label: t('command.copyPlainText'), handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    const { markdownToPlainText } = await import('$lib/utils/markdown-copy');
    const plain = markdownToPlainText(text);
    await navigator.clipboard.writeText(plain);
  }});

  // Diagnostics
  commandRegistry.register({ id: 'run-benchmark', label: t('command.runBenchmark'), handler: async () => {
    const { runBenchmark } = await import('$lib/utils/benchmark');
    const result = await runBenchmark(150000);
    alert(result);
  }});
  commandRegistry.register({ id: 'run-release-benchmark', label: t('command.runReleaseBenchmark'), handler: async () => {
    const { runReleaseBenchmark } = await import('$lib/utils/benchmark');
    const result = await runReleaseBenchmark();
    alert(result);
  }});
  commandRegistry.register({ id: 'run-scroll-test', label: t('command.runScrollTest'), handler: async () => {
    const { runScrollEditTest } = await import('$lib/utils/scroll-edit-test');
    const result = await runScrollEditTest();
    alert(result);
  }});
  commandRegistry.register({ id: 'check-for-updates', label: t('command.checkForUpdates'), handler: async () => {
    const { checkForUpdates } = await import('$lib/updater');
    checkForUpdates(false);
  }});
}
