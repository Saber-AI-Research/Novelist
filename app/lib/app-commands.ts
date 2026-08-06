import type { EditorView } from '@codemirror/view';
import { commandRegistry } from '$lib/stores/commands.svelte';
import { shortcutsStore } from '$lib/stores/shortcuts.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { extensionStore } from '$lib/stores/extensions.svelte';
import { aiTalkSessions } from '$lib/components/ai-talk/sessions.svelte';
import { requestAiAgentNewSession } from '$lib/components/ai-agent/new-session-requests';
import * as fmt from '$lib/editor/formatting';
import { applyBlockTransform, type BlockTransformTarget } from '$lib/editor/block-transform';
import { deleteCurrentParagraph } from '$lib/editor/delete-paragraph';
import { i18n, t as tFn, tIn } from '$lib/i18n';
import { pathDirname } from '$lib/utils/path';

export const BLOCK_TRANSFORM_COMMANDS = [
  { id: 'editor-block-paragraph', target: 'paragraph', labelKey: 'command.blockParagraph' },
  { id: 'editor-block-heading-1', target: 'heading-1', labelKey: 'command.blockHeading1' },
  { id: 'editor-block-heading-2', target: 'heading-2', labelKey: 'command.blockHeading2' },
  { id: 'editor-block-heading-3', target: 'heading-3', labelKey: 'command.blockHeading3' },
  { id: 'editor-block-heading-4', target: 'heading-4', labelKey: 'command.blockHeading4' },
  { id: 'editor-block-heading-5', target: 'heading-5', labelKey: 'command.blockHeading5' },
  { id: 'editor-block-heading-6', target: 'heading-6', labelKey: 'command.blockHeading6' },
  { id: 'editor-block-quote', target: 'quote', labelKey: 'command.blockQuote' },
  { id: 'editor-block-unordered-list', target: 'unordered-list', labelKey: 'command.blockUnorderedList' },
  { id: 'editor-block-ordered-list', target: 'ordered-list', labelKey: 'command.blockOrderedList' },
  { id: 'editor-block-task-list', target: 'task-list', labelKey: 'command.blockTaskList' },
  { id: 'editor-block-code-fence', target: 'code-fence', labelKey: 'command.blockCodeFence' },
] as const satisfies ReadonlyArray<{
  id: string;
  target: BlockTransformTarget;
  labelKey: string;
}>;

/**
 * Bundle of App.svelte-local references the command handlers need.
 * Passed once into `registerAppCommands`.
 */
export type AppCommandContext = {
  t: (key: string) => string;
  getActiveEditorView: () => EditorView | null;
  renameCurrentFile: () => void;
  deleteCurrentFile: () => void;
  // High-level actions owned by App.svelte
  openNewWindow: () => void;
  handleNewFile: () => void;
  handleNewScratchFile: () => void;
  handleOpenFile: () => void;
  handleOpenDirectory: () => void;
  handleOpenContainingFolder: () => void;
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

  /**
   * Register a palette command resolved from an i18n key. Always
   * populates `secondaryLabel` with the alternate-language string so
   * users can search via either Chinese or English regardless of
   * current locale. Falls back to a plain `label` when no key is
   * available.
   */
  function reg(opts: {
    id: string;
    labelKey?: string;
    label?: string;
    shortcut?: string;
    handler: () => void;
  }) {
    let label: string;
    let secondaryLabelFn: (() => string | undefined) | undefined;
    if (opts.labelKey) {
      const key = opts.labelKey;
      label = tFn(key);
      // Resolved lazily at palette render time so the alternate-locale
      // chunk has time to finish preloading after app boot.
      secondaryLabelFn = () => {
        const otherLocale = i18n.locale === 'zh-CN' ? 'en' : 'zh-CN';
        const alt = tIn(otherLocale, key);
        if (alt && alt !== label && alt !== key) return alt;
        return undefined;
      };
    } else {
      label = opts.label ?? opts.id;
    }
    commandRegistry.register({
      id: opts.id,
      label,
      secondaryLabelFn,
      shortcut: opts.shortcut,
      handler: opts.handler,
    });
  }
  // Suppress unused-variable lint for `t` — kept on `ctx` for any
  // future register call that wants the active-locale label only.
  void t;

  reg({ id: 'new-window', labelKey: 'command.newWindow', shortcut: 'Cmd+Shift+N', handler: ctx.openNewWindow });
  reg({ id: 'toggle-sidebar', labelKey: 'command.toggleSidebar', shortcut: shortcutsStore.get('toggle-sidebar'), handler: () => uiStore.toggleSidebar() });
  reg({ id: 'toggle-outline', labelKey: 'command.toggleOutline', shortcut: shortcutsStore.get('toggle-outline'), handler: () => uiStore.toggleOutline() });
  reg({ id: 'toggle-zen', labelKey: 'command.toggleZen', shortcut: shortcutsStore.get('toggle-zen'), handler: () => uiStore.toggleZen() });
  reg({ id: 'toggle-draft', labelKey: 'command.toggleDraft', shortcut: shortcutsStore.get('toggle-draft'), handler: () => uiStore.toggleDraft() });
  reg({ id: 'toggle-snapshot', labelKey: 'command.toggleSnapshot', shortcut: shortcutsStore.get('toggle-snapshot'), handler: () => uiStore.toggleSnapshot() });
  reg({ id: 'toggle-stats', labelKey: 'command.toggleStats', shortcut: shortcutsStore.get('toggle-stats'), handler: () => uiStore.toggleStats() });
  reg({ id: 'toggle-template', labelKey: 'command.toggleTemplate', shortcut: shortcutsStore.get('toggle-template'), handler: () => uiStore.toggleTemplate() });
  reg({ id: 'save-current-as-template', labelKey: 'command.saveCurrentAsTemplate', shortcut: shortcutsStore.get('save-current-as-template'), handler: ctx.saveCurrentFileAsTemplate });
  reg({ id: 'command-palette', labelKey: 'command.commandPalette', shortcut: shortcutsStore.get('command-palette'), handler: ctx.togglePalette });
  reg({ id: 'move-file', labelKey: 'command.moveFile', shortcut: shortcutsStore.get('move-file'), handler: () => {
    if (tabsStore.activeTab && projectStore.dirPath) ctx.openMovePalette();
  }});
  reg({ id: 'project-search', labelKey: 'command.projectSearch', shortcut: 'Cmd+Shift+F', handler: ctx.toggleProjectSearch });
  reg({
    id: 'image-host.upload-all',
    labelKey: 'command.imageHostUploadAll',
    handler: () => {
      void uploadAllLocalImagesCommand(getActiveEditorView());
    },
  });
  reg({ id: 'toggle-split', labelKey: 'command.toggleSplit', shortcut: shortcutsStore.get('toggle-split'), handler: () => tabsStore.toggleSplit() });
  reg({ id: 'new-file', labelKey: 'command.newFile', shortcut: shortcutsStore.get('new-file'), handler: () => {
    projectStore.dirPath ? ctx.handleNewFile() : ctx.handleNewScratchFile();
  }});
  reg({ id: 'new-project', labelKey: 'command.newProject', handler: ctx.openNewProjectDialog });
  reg({ id: 'switch-project', labelKey: 'command.switchProject', handler: ctx.requestProjectSwitcher });
  reg({ id: 'open-file', labelKey: 'command.openFile', shortcut: shortcutsStore.get('open-file'), handler: ctx.handleOpenFile });
  reg({ id: 'open-directory', labelKey: 'command.openDirectory', shortcut: shortcutsStore.get('open-directory'), handler: ctx.handleOpenDirectory });
  reg({ id: 'open-containing-folder', labelKey: 'command.openContainingFolder', handler: ctx.handleOpenContainingFolder });
  reg({ id: 'export-project', labelKey: 'command.exportProject', shortcut: shortcutsStore.get('export-project'), handler: ctx.openExportDialog });
  reg({ id: 'close-tab', labelKey: 'command.closeTab', shortcut: shortcutsStore.get('close-tab'), handler: ctx.handleCloseTab });
  reg({ id: 'rename-file', labelKey: 'command.renameFile', shortcut: shortcutsStore.get('rename-file'), handler: ctx.renameCurrentFile });
  reg({ id: 'delete-current-file', labelKey: 'command.deleteCurrentFile', handler: ctx.deleteCurrentFile });
  reg({ id: 'open-settings', labelKey: 'command.openSettings', shortcut: shortcutsStore.get('open-settings'), handler: () => uiStore.toggleSettings() });
  reg({ id: 'go-to-line', labelKey: 'command.goToLine', shortcut: shortcutsStore.get('go-to-line'), handler: ctx.handleGoToLine });
  reg({ id: 'toggle-mindmap', labelKey: 'command.toggleMindmap', shortcut: shortcutsStore.get('toggle-mindmap'), handler: ctx.toggleMindmapOverlay });

  // AI panels — toggle the right-side panel; session helpers open the
  // panel first, then perform the action. Save-chat dispatches a DOM
  // event the active panel listens for (keeps the save flow inside the
  // Impl component so its status toast fires as usual).
  reg({
    id: 'toggle-ai-talk',
    labelKey: 'command.toggleAiTalk',
    shortcut: shortcutsStore.get('toggle-ai-talk'),
    handler: () => extensionStore.togglePanel('ai-talk'),
  });
  reg({
    id: 'toggle-ai-agent',
    labelKey: 'command.toggleAiAgent',
    shortcut: shortcutsStore.get('toggle-ai-agent'),
    handler: () => extensionStore.togglePanel('ai-agent'),
  });
  reg({
    id: 'ai-talk-new-session',
    labelKey: 'command.aiTalkNewSession',
    shortcut: shortcutsStore.get('ai-talk-new-session'),
    handler: () => {
      if (extensionStore.activePanelId !== 'ai-talk') extensionStore.openPanel('ai-talk');
      aiTalkSessions.create();
    },
  });
  reg({
    id: 'ai-agent-new-session',
    labelKey: 'command.aiAgentNewSession',
    shortcut: shortcutsStore.get('ai-agent-new-session'),
    handler: () => {
      if (extensionStore.activePanelId !== 'ai-agent') extensionStore.openPanel('ai-agent');
      requestAiAgentNewSession(projectStore.dirPath);
    },
  });
  reg({
    id: 'ai-talk-save-chat',
    labelKey: 'command.aiTalkSaveChat',
    shortcut: shortcutsStore.get('ai-talk-save-chat'),
    handler: () => {
      // Delegate to the panel so its save-status toast fires.
      window.dispatchEvent(new CustomEvent('novelist:ai-talk:save-chat'));
    },
  });

  // Editor formatting commands
  reg({ id: 'editor-bold', labelKey: 'command.bold', shortcut: shortcutsStore.get('editor-bold'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '**');
  }});
  reg({ id: 'editor-italic', labelKey: 'command.italic', shortcut: shortcutsStore.get('editor-italic'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '*');
  }});
  reg({ id: 'editor-link', labelKey: 'command.insertLink', shortcut: shortcutsStore.get('editor-link'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.wrapSelection(view, '[', '](url)');
  }});
  reg({ id: 'editor-heading', labelKey: 'command.toggleHeading', shortcut: shortcutsStore.get('editor-heading'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleLinePrefix(view, '#');
  }});
  reg({ id: 'editor-code-inline', labelKey: 'command.inlineCode', shortcut: shortcutsStore.get('editor-code-inline'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '`');
  }});
  reg({ id: 'editor-strikethrough', labelKey: 'command.strikethrough', shortcut: shortcutsStore.get('editor-strikethrough'), handler: () => {
    const view = getActiveEditorView(); if (view) fmt.toggleWrap(view, '~~');
  }});
  reg({ id: 'editor-delete-paragraph', labelKey: 'command.deleteParagraph', handler: () => {
    const view = getActiveEditorView(); if (view) deleteCurrentParagraph(view);
  }});
  for (const command of BLOCK_TRANSFORM_COMMANDS) {
    reg({
      id: command.id,
      labelKey: command.labelKey,
      handler: () => {
        const view = getActiveEditorView();
        if (view) applyBlockTransform(view, command.target);
      },
    });
  }

  // Chinese text tools
  reg({ id: 'chinese-s2t', labelKey: 'command.simplifiedToTraditional', handler: async () => {
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
  reg({ id: 'chinese-t2s', labelKey: 'command.traditionalToSimplified', handler: async () => {
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
  reg({ id: 'chinese-pinyin', labelKey: 'command.generatePinyin', handler: async () => {
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
  reg({ id: 'copy-rich-text', labelKey: 'command.copyRichText', handler: async () => {
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
  reg({ id: 'copy-plain-text', labelKey: 'command.copyPlainText', handler: async () => {
    const view = getActiveEditorView();
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const text = from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
    const { markdownToPlainText } = await import('$lib/utils/markdown-copy');
    const plain = markdownToPlainText(text);
    await navigator.clipboard.writeText(plain);
  }});

  // Diagnostics
  reg({ id: 'run-benchmark', labelKey: 'command.runBenchmark', handler: async () => {
    const { runBenchmark } = await import('$lib/utils/benchmark');
    const result = await runBenchmark(150000);
    alert(result);
  }});
  reg({ id: 'run-scroll-test', labelKey: 'command.runScrollTest', handler: async () => {
    const { runScrollEditTest } = await import('$lib/utils/scroll-edit-test');
    const result = await runScrollEditTest();
    alert(result);
  }});
  // Developer Mode: F12 opens the native WebView DevTools. Gated at
  // handler-time — a no-op until the user enables Developer Mode in
  // Settings, so the command/shortcut stays registered without leaking
  // the inspector to ordinary users.
  reg({ id: 'toggle-devtools', labelKey: 'command.toggleDevtools', shortcut: shortcutsStore.get('toggle-devtools'), handler: async () => {
    if (!uiStore.developerMode) return;
    const { commands } = await import('$lib/ipc/commands');
    await commands.openDevtools();
  }});
  reg({ id: 'check-for-updates', labelKey: 'command.checkForUpdates', handler: async () => {
    const { checkForUpdates } = await import('$lib/updater');
    try {
      await checkForUpdates(false);
    } catch (e) {
      console.warn('[updater] manual check dispatch failed:', e);
    }
  }});
  reg({ id: 'install-cli-shim', labelKey: 'command.installCliShim', handler: async () => {
    const { runInstallCliShim } = await import('$lib/services/cli-shim');
    await runInstallCliShim(t);
  }});
}

/**
 * Find every local image reference in the active document, upload each
 * to the active host, and apply URL replacements in a single CodeMirror
 * transaction. Surfaces a summary toast via the `image-host-toast`
 * window event (consumed by `App.svelte` to render).
 */
async function uploadAllLocalImagesCommand(view: EditorView | null): Promise<void> {
  if (!view) return;
  const docText = view.state.doc.toString();
  const docPath = tabsStore.activeTab?.filePath ?? null;
  const docDir = docPath ? pathDirname(docPath) : (projectStore.dirPath ?? '');
  if (!docDir) {
    window.dispatchEvent(new CustomEvent('image-host-toast', {
      detail: { kind: 'error', message: 'Open a saved file before running upload-all.' },
    }));
    return;
  }
  try {
    const { uploadAllInDocument } = await import('$lib/services/image-host');
    const report = await uploadAllInDocument(docText, {
      baseDir: docDir,
    });
    if (report.successes.length === 0 && report.failures.length === 0) {
      window.dispatchEvent(new CustomEvent('image-host-toast', {
        detail: { kind: 'info', message: 'No local images to upload.' },
      }));
      return;
    }
    // Build one transaction with every replacement.
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (const { original, url } of report.successes) {
      // Find every occurrence of the original ref in the doc text and
      // replace just the URL portion of each `![alt](original)` match.
      const re = new RegExp(`!\\[([^\\]]*)\\]\\(${escapeRegExp(original)}(\\s+"[^"]*")?\\)`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(docText)) !== null) {
        const matchStart = m.index;
        const oldSrcStart = matchStart + 2 + m[1].length + 2;
        const oldSrcEnd = oldSrcStart + original.length;
        changes.push({ from: oldSrcStart, to: oldSrcEnd, insert: url });
      }
    }
    if (changes.length > 0) {
      view.dispatch({ changes });
    }
    const total = report.successes.length + report.failures.length;
    const msg = report.failures.length === 0
      ? `Uploaded ${report.successes.length} image(s).`
      : `${report.successes.length}/${total} uploaded; ${report.failures.length} failed.`;
    window.dispatchEvent(new CustomEvent('image-host-toast', {
      detail: { kind: report.failures.length === 0 ? 'success' : 'warn', message: msg },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('image-host-toast', {
      detail: { kind: 'error', message: e instanceof Error ? e.message : String(e) },
    }));
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
