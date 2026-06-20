import { isScratchFile } from './scratch';

export interface ExportFileSource {
  is_dir: boolean;
  name: string;
  path: string;
}

export interface ExportActiveTab {
  filePath: string;
}

/**
 * Resolve which file paths the export/format-converter should hand to pandoc.
 *
 * - **Project mode** (`projectDir` set): every markdown file in the project,
 *   concatenated into one document (book compile).
 * - **Standalone / single-file mode** (`projectDir` is null): the active tab's
 *   file. The Rust `export_project` command only needs a list of file paths, so
 *   no project directory is required — this is what makes export work when a
 *   file is opened on its own. A scratch file isn't on disk yet, so it's
 *   excluded (the caller surfaces a "save first" message).
 */
export function collectExportFiles(
  projectDir: string | null,
  projectFiles: readonly ExportFileSource[],
  activeTab: ExportActiveTab | null | undefined,
): string[] {
  if (projectDir) {
    return projectFiles
      .filter((f) => !f.is_dir && (f.name.endsWith('.md') || f.name.endsWith('.markdown')))
      .map((f) => f.path);
  }
  if (activeTab && activeTab.filePath && !isScratchFile(activeTab.filePath)) {
    return [activeTab.filePath];
  }
  return [];
}
