import type { EditorView } from '@codemirror/view';
import { commands, type TemplateFileSummary } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
import { templatesStore } from '$lib/stores/templates.svelte';
import { parseTemplate, inferNextName } from '$lib/utils/placeholder';
import { makeTemplateContext, resolveBody, extractCursorAnchor, resolveFilename } from '$lib/utils/template-tokens';

type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * Create a scratch file (single-file mode, no project). Opens it as the sole tab.
 */
export async function createScratchFile() {
  const result = await commands.createScratchFile();
  if (result.status === 'ok') {
    const filePath = result.data;
    const readResult = await commands.readFile(filePath);
    if (readResult.status === 'ok') {
      projectStore.enterSingleFileMode();
      uiStore.sidebarVisible = false;
      tabsStore.openTab(filePath, readResult.data, { justCreated: true });
      await commands.registerOpenFile(filePath);
    }
  }
}

/**
 * Smart new-file creation inside the active project.
 *
 * Target folder resolves: pinned default > last-used > project root. If the
 * resolved dir has been deleted, falls back to project root.
 *
 * Filename is derived from the user's template (`newFileSettings.template`)
 * combined with optional sibling detection (`detectFromFolder`) to pick the
 * next chapter/numbering slot.
 *
 * After a successful create:
 *  - records last-used-dir so the next Cmd+N lands here
 *  - eagerly refreshes the sidebar (the watcher will also fire)
 *  - opens the created file as a new tab
 */
export async function createNewFileInProject() {
  if (!projectStore.dirPath) return;

  let targetDir = settingsStore.resolveNewFileDir(projectStore.dirPath);
  const probe = await commands.listDirectory(targetDir, null);
  if (probe.status !== 'ok') {
    targetDir = projectStore.dirPath;
  }

  const filesResult = await commands.listDirectory(targetDir, null);
  const siblings = filesResult.status === 'ok'
    ? filesResult.data.filter(e => !e.is_dir).map(e => e.name)
    : [];

  const userTemplate = parseTemplate(newFileSettings.template) ?? parseTemplate('Untitled {N}')!;

  const proposedName = newFileSettings.detectFromFolder
    ? inferNextName(siblings, userTemplate)
    : inferNextName([], userTemplate);

  const result = await commands.createFile(targetDir, proposedName);
  if (result.status !== 'ok') return;

  void settingsStore.recordLastUsedDir(targetDir);

  if (targetDir === projectStore.dirPath) {
    const after = await commands.listDirectory(targetDir, null);
    if (after.status === 'ok') projectStore.updateFiles(after.data);
  } else {
    await projectStore.expandFolder(targetDir);
    await projectStore.refreshFolder(targetDir);
  }

  const readResult = await commands.readFile(result.data);
  if (readResult.status === 'ok') {
    tabsStore.openTab(result.data, readResult.data, { justCreated: true });
    await commands.registerOpenFile(result.data);
  }
}

/**
 * Execute a template row the user clicked in TemplatePanel. Returns an
 * error message on failure, or null on success. Handles both modes:
 *
 *  - `insert`   → dispatches a single change into the active editor,
 *                 placing the caret at the template's `$|$` anchor (or
 *                 after the inserted text when the template has no anchor).
 *  - `new-file` → creates `<projectRoot>/<resolvedFilename>` via Rust and
 *                 opens the result as a new tab. Project root for now —
 *                 flat-directory storage, see the design spec.
 */
export async function executeTemplate(
  summary: TemplateFileSummary,
  getActiveEditorView: () => EditorView | null,
  t: T,
): Promise<string | null> {
  try {
    const full = await templatesStore.read(summary.source, summary.id, projectStore.dirPath);
    const ctx = makeTemplateContext({
      activeFilePath: tabsStore.activeTab?.filePath ?? null,
      projectDir: projectStore.dirPath,
    });
    if (summary.mode === 'insert') {
      const resolved = resolveBody(full.body, ctx);
      const { body: text, anchor } = extractCursorAnchor(resolved);
      const view = getActiveEditorView();
      if (!view) return t('template.needActiveEditor');
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + (anchor >= 0 ? anchor : text.length) },
      });
      view.focus();
      return null;
    }
    // new-file
    if (!projectStore.dirPath) return t('template.needProject');
    const filenameTemplate = summary.defaultFilename ?? `${summary.name}.md`;
    const filename = resolveFilename(filenameTemplate, ctx);
    const resolvedBody = resolveBody(full.body, ctx);
    const res = await commands.createFileWithBody(projectStore.dirPath, filename, resolvedBody);
    if (res.status !== 'ok') return String(res.error);
    const after = await commands.listDirectory(projectStore.dirPath, null);
    if (after.status === 'ok') projectStore.updateFiles(after.data);
    const readResult = await commands.readFile(res.data);
    if (readResult.status === 'ok') {
      tabsStore.openTab(res.data, readResult.data);
      await commands.registerOpenFile(res.data);
    }
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/**
 * "Save current file as template": opens the TemplatePanel (if closed) and
 * hands a prefilled dialog request back to App.svelte via the callback.
 */
export function requestSaveCurrentAsTemplate(
  getActiveEditorView: () => EditorView | null,
  t: T,
  onRequestDialog: (prefill: { name: string; body: string }) => void,
) {
  if (!projectStore.dirPath) return;
  const view = getActiveEditorView();
  if (!view) return;
  const active = tabsStore.activeTab;
  const body = view.state.doc.toString();
  const stem = (() => {
    const n = active?.fileName ?? '';
    const dot = n.lastIndexOf('.');
    return dot > 0 ? n.slice(0, dot) : n;
  })();
  if (!uiStore.templateVisible) uiStore.toggleTemplate();
  onRequestDialog({ name: stem || t('template.defaultNewName'), body });
}
