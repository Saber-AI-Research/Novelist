import type { FileEntry, ProjectConfig } from '$lib/ipc/commands';

class ProjectStore {
  dirPath = $state<string | null>(null);
  config = $state<ProjectConfig | null>(null);
  files = $state<FileEntry[]>([]);
  isLoading = $state(false);
  singleFileMode = $state(false);

  get isOpen() { return this.dirPath !== null || this.singleFileMode; }

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
    this.files = files;
    this.isLoading = false;
    this.singleFileMode = false;
  }

  updateFiles(files: FileEntry[]) { this.files = files; }

  close() {
    this.dirPath = null;
    this.config = null;
    this.files = [];
    this.singleFileMode = false;
  }
}

export const projectStore = new ProjectStore();
