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
import {
  confirmManagedNameEnrollment,
  enableManagedNameForCreatedFile,
} from '$lib/services/managed-name-persistence';
import { hasCanonicalTitleToken } from '$lib/utils/managed-name';
import { extractFirstH1 } from '$lib/utils/h1';
import { pathDirname, pathStartsWithChild, pathsEqual } from '$lib/utils/path';

type T = (key: string, params?: Record<string, string | number>) => string;
export type ManagedNameEnrollmentOutcome = 'enrolled' | 'not-applicable' | 'failed';

function isMarkdownDocumentPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/**
 * Create a scratch file (single-file mode, no project). Opens it as the sole tab.
 */
export async function createScratchFile() {
  const result = await commands.createScratchFile();
  if (result.status === 'ok') {
    const filePath = result.data;
    const readResult = await commands.readFile(filePath);
    if (readResult.status === 'ok') {
      await projectStore.enterSingleFileMode();
      uiStore.sidebarVisible = false;
      tabsStore.openTab(filePath, readResult.data, { justCreated: true });
      await commands.registerOpenFile(filePath);
    }
  }
}

/**
 * Compute the smart proposed filename for a new file in `targetDir`,
 * applying the user's template (date/time macros + `{N}` numbering with
 * sibling-aware inference). Pure naming — does not create the file.
 *
 * If `ext` is provided and differs from the template's extension, the
 * resulting basename's extension is swapped (e.g. `.canvas`, `.kanban`).
 */
export async function proposeNewFileName(targetDir: string, ext?: string): Promise<string> {
  const filesResult = await commands.listDirectory(targetDir, null);
  const siblings = filesResult.status === 'ok'
    ? filesResult.data.filter(e => !e.is_dir).map(e => e.name)
    : [];

  const macroCtx = makeTemplateContext({
    activeFilePath: tabsStore.activeTab?.filePath ?? null,
    projectDir: projectStore.dirPath,
  });
  const resolvedTemplateRaw = resolveBody(newFileSettings.template, macroCtx);
  const userTemplate = parseTemplate(resolvedTemplateRaw) ?? parseTemplate('Untitled {N}')!;

  const proposedName = inferNextName(siblings, userTemplate);

  if (ext) {
    const dot = proposedName.lastIndexOf('.');
    const stem = dot > 0 ? proposedName.slice(0, dot) : proposedName;
    return stem + ext;
  }
  return proposedName;
}

/**
 * Resolve the user's current filename template (macros expanded) so callers
 * can gate managed-name enrollment on the exact source template string.
 *
 * Exported so Sidebar's inline header `+` and context-menu `New File` sites
 * can pass the same template that Cmd+N uses to `persistManagedNameEnrollment`,
 * preserving the canonical `{title}` token — never derived from the final
 * filename.
 */
export function currentFilenameTemplateRaw(): string {
  const macroCtx = makeTemplateContext({
    activeFilePath: tabsStore.activeTab?.filePath ?? null,
    projectDir: projectStore.dirPath,
  });
  return resolveBody(newFileSettings.template, macroCtx);
}

/**
 * Resolve the destination for the generic New File command.
 *
 * A pinned default remains authoritative. Otherwise, while a literary-study
 * chapter is active, create beside that chapter so Cmd+N and the sidebar
 * header `+` do not escape into a stale last-used folder or the project root.
 * The containment check is deliberate: an externally-opened `.litstudy` file
 * must never redirect project file creation outside the active project.
 */
export function resolveContextualNewFileDir(
  projectDir: string,
  activeFilePath: string | null,
): string {
  const configuredDir = settingsStore.resolveNewFileDir(projectDir);
  if (settingsStore.effective.new_file.default_dir) return configuredDir;
  if (!activeFilePath?.toLowerCase().endsWith('.litstudy')) return configuredDir;

  const chapterDir = pathDirname(activeFilePath);
  if (pathsEqual(chapterDir, projectDir) || pathStartsWithChild(chapterDir, projectDir)) {
    return chapterDir;
  }
  return configuredDir;
}

/**
 * Safe enrollment helper: enrolls managed naming for a freshly-created file
 * IFF `templateRaw` contains the exact canonical `{title}` token. On any
 * persistence failure the created file is NEVER deleted; instead a static
 * safe warning label is logged so on-disk paths never leak through log
 * telemetry.
 *
 * Exported so every new-file entry point (Cmd+N, template panel, Sidebar
 * header `+`, Sidebar context-menu `New File`) shares one enrollment gate
 * and one failure-handling contract.
 */
export async function persistManagedNameEnrollment(
  projectDir: string,
  filePath: string,
  templateRaw: string,
  currentH1: string,
  warningLabel: string,
): Promise<ManagedNameEnrollmentOutcome> {
  if (!hasCanonicalTitleToken(templateRaw) || !isMarkdownDocumentPath(filePath)) {
    return 'not-applicable';
  }
  let persisted = null;
  try {
    persisted = await enableManagedNameForCreatedFile(projectDir, filePath, templateRaw, currentH1);
  } catch {
    persisted = null;
  }
  if (persisted && await confirmManagedNameEnrollment(projectDir, filePath, persisted)) {
    return 'enrolled';
  }
  console.warn(warningLabel);
  return 'failed';
}

/**
 * Smart new-file creation inside the active project.
 *
 * Target folder resolves: pinned default > active `.litstudy` chapter folder
 * > last-used > project root. If the resolved dir has been deleted, falls back
 * to project root.
 *
 * Filename is derived from the user's template (`newFileSettings.template`)
 * combined with sibling-aware inference to pick the next chapter/numbering
 * slot.
 *
 * After a successful create:
 *  - records last-used-dir so the next Cmd+N lands here
 *  - eagerly refreshes the sidebar (the watcher will also fire)
 *  - opens the created file as a new tab
 */
export async function createNewFileInProject() {
  if (!projectStore.dirPath) return;

  let targetDir = resolveContextualNewFileDir(
    projectStore.dirPath,
    tabsStore.activeTab?.filePath ?? null,
  );
  const probe = await commands.listDirectory(targetDir, null);
  if (probe.status !== 'ok') {
    targetDir = projectStore.dirPath;
  }

  const templateRaw = currentFilenameTemplateRaw();
  const proposedName = await proposeNewFileName(targetDir);
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
    await persistManagedNameEnrollment(
      projectStore.dirPath,
      result.data,
      templateRaw,
      '',
      'Managed-name enrollment failed during new-file creation',
    );
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
      await persistManagedNameEnrollment(
        projectStore.dirPath,
        res.data,
        filenameTemplate,
        extractFirstH1(readResult.data) ?? '',
        'Managed-name enrollment failed during template file creation',
      );
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
