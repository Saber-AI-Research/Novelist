import type { FileEntry, ProjectConfig } from '$lib/ipc/commands';
import { commands } from '$lib/ipc/commands';
import type { SortMode } from '$lib/utils/file-sort';
import { settingsStore } from '$lib/stores/settings.svelte';
import { flushProjectSwitch } from '$lib/services/project-switch-coordinator';
import { pathBasename } from '$lib/utils/path';

const VALID_SORT_MODES: readonly SortMode[] = [
  'name-asc', 'name-desc',
  'numeric-asc', 'numeric-desc',
  'mtime-asc', 'mtime-desc',
  'ctime-asc', 'ctime-desc',
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
  generation = $state(0);

  /** Reads from the unified settings store so project/global overlay is respected. */
  get sortMode(): SortMode {
    return coerceSortMode(settingsStore.effective.view.sort_mode);
  }

  get showHiddenFiles(): boolean {
    return settingsStore.effective.view.show_hidden_files;
  }

  get wrapFileNames(): boolean {
    return settingsStore.effective.view.wrap_file_names;
  }

  get sidebarFontSize(): number {
    return settingsStore.effective.view.sidebar_font_size;
  }

  get isOpen() { return this.dirPath !== null || this.singleFileMode; }

  /** Persists to the current scope (project file if open, global otherwise). */
  setSortMode(mode: SortMode) {
    void settingsStore.writeView({ sort_mode: mode });
  }

  get name() {
    if (this.config) return this.config.project.name;
    if (this.dirPath) {
      return pathBasename(this.dirPath) || 'Untitled';
    }
    return 'No Project';
  }

  async enterSingleFileMode(): Promise<void> {
    const previousProjectDir = this.dirPath;
    await this.flushProjectSwitchProviders(previousProjectDir, null);
    this.singleFileMode = true;
    this.dirPath = null;
    this.config = null;
    this.files = [];
  }

  async setProject(
    dirPath: string,
    config: ProjectConfig | null,
    files: FileEntry[],
    generation?: number,
    providersPrepared = false,
  ): Promise<boolean> {
    const nextGeneration = generation ?? this.generation + 1;
    if (nextGeneration <= this.generation) return false;
    const previousProjectDir = this.dirPath;
    if (previousProjectDir !== dirPath && !providersPrepared) {
      await this.flushProjectSwitchProviders(previousProjectDir, dirPath);
    }
    if (nextGeneration <= this.generation) return false;
    this.dirPath = dirPath;
    this.generation = nextGeneration;
    this.config = config;
    this.files = files.map(toNode);
    this.isLoading = false;
    this.singleFileMode = false;
    return true;
  }

  async prepareProjectSwitch(nextProjectDir: string | null): Promise<void> {
    const previousProjectDir = this.dirPath;
    if (previousProjectDir !== nextProjectDir || this.singleFileMode) {
      await this.flushProjectSwitchProviders(previousProjectDir, nextProjectDir);
    }
  }

  private async flushProjectSwitchProviders(
    previousProjectDir: string | null,
    nextProjectDir: string | null,
  ): Promise<void> {
    await flushProjectSwitch(previousProjectDir, nextProjectDir);
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

  async close(): Promise<void> {
    const previousProjectDir = this.dirPath;
    const wasSingleFileMode = this.singleFileMode;
    if (previousProjectDir !== null || wasSingleFileMode) {
      await this.flushProjectSwitchProviders(previousProjectDir, null);
    }
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

  /**
   * Expand a folder and every descendant folder, lazily loading children as
   * needed. Width-first traversal so the UI grows top-down. The provided
   * `path` is treated as the subtree root: pass `dirPath` to expand the whole
   * project, or any folder path to expand only that branch.
   */
  async expandFolderRecursive(path: string): Promise<void> {
    const roots = path === this.dirPath ? this.files : [this.findFolder(path)].filter(Boolean) as FileNode[];
    const queue: FileNode[] = [];
    for (const r of roots) if (r.is_dir) queue.push(r);

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (node.children === undefined) {
        await this.expandFolder(node.path);
      } else {
        node.expanded = true;
      }
      if (node.children) {
        for (const child of node.children) if (child.is_dir) queue.push(child);
      }
    }
  }

  /**
   * Collapse a folder and every already-loaded descendant. Does not unload
   * children — re-expansion is instant.
   */
  collapseFolderRecursive(path: string): void {
    const roots = path === this.dirPath ? this.files : [this.findFolder(path)].filter(Boolean) as FileNode[];
    const stack: FileNode[] = [];
    for (const r of roots) if (r.is_dir) stack.push(r);

    while (stack.length > 0) {
      const node = stack.pop()!;
      node.expanded = false;
      if (node.children) {
        for (const child of node.children) if (child.is_dir) stack.push(child);
      }
    }
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

  /** Re-fetch the root plus all folders whose children have already been loaded. */
  async refreshLoadedFolders(): Promise<void> {
    if (!this.dirPath) return;
    const paths = new Set<string>();
    function walk(nodes: FileNode[]) {
      for (const n of nodes) {
        if (!n.is_dir) continue;
        if (n.children !== undefined) {
          paths.add(n.path);
          walk(n.children);
        }
      }
    }
    walk(this.files);
    for (const path of paths) {
      await this.refreshFolder(path);
    }
    await this.refreshFolder(this.dirPath);
  }
}

export const projectStore = new ProjectStore();
