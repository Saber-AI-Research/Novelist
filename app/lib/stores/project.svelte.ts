import type { FileEntry, ProjectConfig } from '$lib/ipc/commands';
import { commands } from '$lib/ipc/commands';
import type { SortMode } from '$lib/utils/file-sort';
import { settingsStore } from '$lib/stores/settings.svelte';

const VALID_SORT_MODES: readonly SortMode[] = [
  'name-asc', 'name-desc', 'numeric-asc', 'numeric-desc', 'mtime-asc', 'mtime-desc',
];

function coerceSortMode(value: string): SortMode {
  return (VALID_SORT_MODES as readonly string[]).includes(value)
    ? (value as SortMode)
    : 'numeric-asc';
}

export interface FileNode extends FileEntry {
  /** undefined = children never loaded; [] = loaded but empty. */
  children?: FileNode[];
  expanded: boolean;
  loading: boolean;
  /** UI-only: set during dragover on this folder so the component can highlight it. */
  dragOver?: boolean;
}

function toNode(entry: FileEntry): FileNode {
  return { ...entry, expanded: false, loading: false };
}

/** Walk the tree depth-first and return the first FileNode with the given path. */
function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

class ProjectStore {
  dirPath = $state<string | null>(null);
  config = $state<ProjectConfig | null>(null);
  files = $state<FileNode[]>([]);
  isLoading = $state(false);
  singleFileMode = $state(false);

  /** Reads from the unified settings store so project/global overlay is respected. */
  get sortMode(): SortMode {
    return coerceSortMode(settingsStore.effective.view.sort_mode);
  }

  get showHiddenFiles(): boolean {
    return settingsStore.effective.view.show_hidden_files;
  }

  get isOpen() { return this.dirPath !== null || this.singleFileMode; }

  /** Persists to the current scope (project file if open, global otherwise). */
  setSortMode(mode: SortMode) {
    void settingsStore.writeView({ sort_mode: mode });
  }

  get name() {
    if (this.config) return this.config.project.name;
    if (this.dirPath) {
      const parts = this.dirPath.split('/');
      return parts[parts.length - 1] || 'Untitled';
    }
    return 'No Project';
  }

  enterSingleFileMode() {
    this.singleFileMode = true;
    this.dirPath = null;
    this.config = null;
    this.files = [];
  }

  setProject(dirPath: string, config: ProjectConfig | null, files: FileEntry[]) {
    this.dirPath = dirPath;
    this.config = config;
    this.files = files.map(toNode);
    this.isLoading = false;
    this.singleFileMode = false;
    // Kick off the settings load; UI reads reactively from `settingsStore`
    // so no awaiting is needed here.
    void settingsStore.load(dirPath);
  }

  /** Replace the project-root children. Used by legacy callers; preserves expansion state of still-present folders. */
  updateFiles(files: FileEntry[]) {
    const prev = new Map(this.files.map(n => [n.path, n]));
    this.files = files.map(e => {
      const existing = prev.get(e.path);
      if (existing && existing.is_dir && e.is_dir) {
        return { ...e, children: existing.children, expanded: existing.expanded, loading: false };
      }
      return toNode(e);
    });
  }

  close() {
    this.dirPath = null;
    this.config = null;
    this.files = [];
    this.singleFileMode = false;
    // Drop back to global-only settings.
    void settingsStore.load(null);
  }

  /** Find a folder node anywhere in the tree. */
  findFolder(path: string): FileNode | undefined {
    const n = findNode(this.files, path);
    return n && n.is_dir ? n : undefined;
  }

  /** Expand a folder, loading its children the first time. */
  async expandFolder(path: string): Promise<void> {
    const node = this.findFolder(path);
    if (!node) return;
    if (node.children === undefined) {
      node.loading = true;
      const result = await commands.listDirectory(path, this.showHiddenFiles);
      if (result.status === 'ok') {
        node.children = result.data.map(toNode);
      } else {
        node.children = [];
      }
      node.loading = false;
    }
    node.expanded = true;
  }

  collapseFolder(path: string): void {
    const node = this.findFolder(path);
    if (node) node.expanded = false;
  }

  /** Re-fetch children for a previously-loaded folder (used by file watcher + post-move). */
  async refreshFolder(path: string): Promise<void> {
    // Project root is represented by `this.files` (no wrapper node).
    if (path === this.dirPath) {
      const result = await commands.listDirectory(path, this.showHiddenFiles);
      if (result.status === 'ok') this.updateFiles(result.data);
      return;
    }
    const node = this.findFolder(path);
    if (!node || node.children === undefined) return; // not loaded -> nothing to refresh
    const result = await commands.listDirectory(path, this.showHiddenFiles);
    if (result.status !== 'ok') return;
    const prev = new Map(node.children.map(n => [n.path, n]));
    node.children = result.data.map(e => {
      const existing = prev.get(e.path);
      if (existing && existing.is_dir && e.is_dir) {
        return { ...e, children: existing.children, expanded: existing.expanded, loading: false };
      }
      return toNode(e);
    });
  }
}

export const projectStore = new ProjectStore();
