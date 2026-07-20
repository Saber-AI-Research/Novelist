import { isScratchFile } from './scratch';
import { compareByMode } from './file-sort';

export interface ExportFileSource {
  is_dir: boolean;
  name: string;
  path: string;
  children?: readonly ExportFileSource[];
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
    const files: string[] = [];
    const visit = (entries: readonly ExportFileSource[]) => {
      for (const entry of [...entries].sort((a, b) => compareByMode(a, b, 'numeric-asc'))) {
        if (entry.is_dir) {
          if (entry.children) visit(entry.children);
        } else if (/\.(?:md|markdown)$/i.test(entry.name)) {
          files.push(entry.path);
        }
      }
    };
    visit(projectFiles);
    return files;
  }
  if (activeTab && activeTab.filePath && !isScratchFile(activeTab.filePath)) {
    return [activeTab.filePath];
  }
  return [];
}
