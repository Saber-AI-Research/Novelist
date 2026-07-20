import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * [contract] services/new-file — IPC-orchestrated file creation.
 * Covers createScratchFile, createNewFileInProject, executeTemplate
 * (insert + new-file modes), and requestSaveCurrentAsTemplate.
 */

const { h } = vi.hoisted(() => {
  const cmd = {
    createScratchFile: vi.fn(),
    readFile: vi.fn(),
    registerOpenFile: vi.fn(async () => ({ status: 'ok' })),
    listDirectory: vi.fn(),
    createFile: vi.fn(),
    createFileWithBody: vi.fn(),
    computeDocumentKey: vi.fn(),
    writeManagedNameState: vi.fn(),
    readManagedNameState: vi.fn(),
    deleteManagedNameState: vi.fn(),
  };

  const projectState = {
    dirPath: null as null | string,
    enterSingleFileMode: vi.fn(),
    updateFiles: vi.fn(),
    expandFolder: vi.fn(async (_: string) => {}),
    refreshFolder: vi.fn(async (_: string) => {}),
  };

  const tabsState = {
    openTab: vi.fn(),
    activeTab: null as null | { filePath: string; fileName: string },
  };

  const uiState = {
    sidebarVisible: true,
    templateVisible: false,
    toggleTemplate: vi.fn(() => { uiState.templateVisible = !uiState.templateVisible; }),
  };

  const settingsState = {
    resolveNewFileDir: vi.fn((proj: string) => proj),
    recordLastUsedDir: vi.fn(async (_: string) => {}),
  };

  const newFileState = {
    template: 'Chapter {N}',
    detectFromFolder: true,
  };

  const templatesStoreMock = { read: vi.fn() };

  return { h: { cmd, projectState, tabsState, uiState, settingsState, newFileState, templatesStoreMock } };
});

vi.mock('$lib/ipc/commands', () => ({ commands: h.cmd }));

vi.mock('$lib/stores/project.svelte', () => ({
  projectStore: {
    get dirPath() { return h.projectState.dirPath; },
    enterSingleFileMode: () => h.projectState.enterSingleFileMode(),
    updateFiles: (f: any) => h.projectState.updateFiles(f),
    expandFolder: (p: string) => h.projectState.expandFolder(p),
    refreshFolder: (p: string) => h.projectState.refreshFolder(p),
  },
}));

vi.mock('$lib/stores/tabs.svelte', () => ({
  tabsStore: {
    openTab: (...a: any[]) => h.tabsState.openTab(...a),
    get activeTab() { return h.tabsState.activeTab; },
  },
}));

vi.mock('$lib/stores/ui.svelte', () => ({
  uiStore: {
    get sidebarVisible() { return h.uiState.sidebarVisible; },
    set sidebarVisible(v: boolean) { h.uiState.sidebarVisible = v; },
    get templateVisible() { return h.uiState.templateVisible; },
    toggleTemplate: () => h.uiState.toggleTemplate(),
  },
}));

vi.mock('$lib/stores/settings.svelte', () => ({
  settingsStore: {
    resolveNewFileDir: (p: string) => h.settingsState.resolveNewFileDir(p),
    recordLastUsedDir: (p: string) => h.settingsState.recordLastUsedDir(p),
  },
}));

vi.mock('$lib/stores/new-file-settings.svelte', () => ({
  newFileSettings: {
    get template() { return h.newFileState.template; },
    get detectFromFolder() { return h.newFileState.detectFromFolder; },
  },
}));

vi.mock('$lib/stores/templates.svelte', () => ({
  templatesStore: h.templatesStoreMock,
}));

import {
  createScratchFile,
  createNewFileInProject,
  currentFilenameTemplateRaw,
  executeTemplate,
  persistManagedNameEnrollment,
  requestSaveCurrentAsTemplate,
} from '$lib/services/new-file';
import { clearManagedNameCache, loadManagedName } from '$lib/services/managed-name-persistence';

const t = (k: string) => k;

beforeEach(() => {
  clearManagedNameCache();
  Object.values(h.cmd).forEach((fn: any) => fn.mockReset?.());
  h.cmd.registerOpenFile.mockResolvedValue({ status: 'ok' });
  h.cmd.computeDocumentKey.mockImplementation((_project: string, path: string) => Promise.resolve({ status: 'ok', data: path.replace(/^\/proj\/?/, '') }));
  h.cmd.writeManagedNameState.mockResolvedValue({ status: 'ok', data: null });
  h.cmd.readManagedNameState.mockResolvedValue({ status: 'ok', data: null });
  h.cmd.deleteManagedNameState.mockResolvedValue({ status: 'ok', data: null });
  h.projectState.dirPath = null;
  h.projectState.enterSingleFileMode.mockClear();
  h.projectState.updateFiles.mockClear();
  h.projectState.expandFolder.mockClear();
  h.projectState.refreshFolder.mockClear();
  h.tabsState.openTab.mockClear();
  h.tabsState.activeTab = null;
  h.uiState.sidebarVisible = true;
  h.uiState.templateVisible = false;
  h.uiState.toggleTemplate.mockClear();
  h.settingsState.resolveNewFileDir.mockClear().mockImplementation((p: string) => p);
  h.settingsState.recordLastUsedDir.mockClear().mockResolvedValue(undefined);
  h.newFileState.template = 'Chapter {N}';
  h.newFileState.detectFromFolder = true;
  h.templatesStoreMock.read.mockReset();
});

describe('[contract] createScratchFile', () => {
  it('opens the scratch file as a single-file tab', async () => {
    h.cmd.createScratchFile.mockResolvedValue({ status: 'ok', data: '/tmp/scratch.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: 'body' });
    await createScratchFile();
    expect(h.projectState.enterSingleFileMode).toHaveBeenCalled();
    expect(h.uiState.sidebarVisible).toBe(false);
    expect(h.tabsState.openTab).toHaveBeenCalledWith('/tmp/scratch.md', 'body', { justCreated: true });
    expect(h.cmd.registerOpenFile).toHaveBeenCalledWith('/tmp/scratch.md');
  });

  it('aborts when createScratchFile fails', async () => {
    h.cmd.createScratchFile.mockResolvedValue({ status: 'error', error: 'denied' });
    await createScratchFile();
    expect(h.cmd.readFile).not.toHaveBeenCalled();
    expect(h.tabsState.openTab).not.toHaveBeenCalled();
  });

  it('aborts when readFile of the scratch file fails', async () => {
    h.cmd.createScratchFile.mockResolvedValue({ status: 'ok', data: '/tmp/scratch.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'error', error: 'denied' });
    await createScratchFile();
    expect(h.tabsState.openTab).not.toHaveBeenCalled();
  });
});

describe('[contract] createNewFileInProject', () => {
  it('no-ops when no project is open', async () => {
    await createNewFileInProject();
    expect(h.cmd.createFile).not.toHaveBeenCalled();
  });

  it('creates a file at the resolved target dir and opens it', async () => {
    h.projectState.dirPath = '/proj';
    h.settingsState.resolveNewFileDir.mockReturnValue('/proj');
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 1.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', 'Chapter 1.md');
    expect(h.settingsState.recordLastUsedDir).toHaveBeenCalledWith('/proj');
    expect(h.tabsState.openTab).toHaveBeenCalledWith('/proj/Chapter 1.md', '', { justCreated: true });
    expect(h.cmd.writeManagedNameState).not.toHaveBeenCalled();
  });

  it('enrolls managed naming for created files when template contains {title}', async () => {
    h.projectState.dirPath = '/proj';
    h.newFileState.template = '第{N}章-{title}';
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/第1章-Untitled.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.cmd.writeManagedNameState).toHaveBeenCalledWith('/proj', '/proj/第1章-Untitled.md', {
      version: 1,
      status: 'managed',
      templateRaw: '第{N}章-{title}',
      currentH1: '',
      documentKey: '第1章-Untitled.md',
    });
  });

  it('logs a safe warning without authorizing managed state when project enrollment write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.projectState.dirPath = '/proj';
      h.newFileState.template = '第{N}章-{title}';
      h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
      h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/第1章-Untitled.md' });
      h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
      h.cmd.writeManagedNameState.mockResolvedValue({ status: 'error', error: 'disk path /proj/secret.md' });

      await createNewFileInProject();

      expect(h.tabsState.openTab).toHaveBeenCalledWith('/proj/第1章-Untitled.md', '', { justCreated: true });
      expect(warn).toHaveBeenCalledWith('Managed-name enrollment failed during new-file creation');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/第1章-Untitled.md');
      await expect(loadManagedName('/proj', '/proj/第1章-Untitled.md')).resolves.toEqual({ kind: 'missing' });
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when project new-file template has no canonical title token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.projectState.dirPath = '/proj';
      h.newFileState.template = 'Chapter {N}';
      h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
      h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 1.md' });
      h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });

      await createNewFileInProject();

      expect(warn).not.toHaveBeenCalled();
      expect(h.cmd.writeManagedNameState).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to project root when the resolved dir probe fails', async () => {
    h.projectState.dirPath = '/proj';
    h.settingsState.resolveNewFileDir.mockReturnValue('/proj/deleted');
    // First probe of /proj/deleted fails → falls back to /proj.
    h.cmd.listDirectory
      .mockResolvedValueOnce({ status: 'error', error: 'missing' })
      .mockResolvedValueOnce({ status: 'ok', data: [] })
      .mockResolvedValueOnce({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 1.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', 'Chapter 1.md');
  });

  it('inferNextName sees siblings when detectFromFolder is true', async () => {
    h.projectState.dirPath = '/proj';
    h.newFileState.detectFromFolder = true;
    h.cmd.listDirectory
      .mockResolvedValueOnce({ status: 'ok', data: [] })
      .mockResolvedValueOnce({
        status: 'ok',
        data: [
          { name: 'Chapter 1.md', is_dir: false, path: '/proj/Chapter 1.md', size: 0, mtime: 0 },
          { name: 'Chapter 2.md', is_dir: false, path: '/proj/Chapter 2.md', size: 0, mtime: 0 },
        ],
      })
      .mockResolvedValueOnce({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 3.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', 'Chapter 3.md');
  });

  it('inferNextName always consults the sibling list — the legacy detectFromFolder flag is gone', async () => {
    // Folder-detection is now implicit (we always pass siblings); the toggle
    // was removed because templates with `{N}` already signal numbering intent.
    h.projectState.dirPath = '/proj';
    h.newFileState.detectFromFolder = false; // ignored
    h.cmd.listDirectory
      .mockResolvedValueOnce({ status: 'ok', data: [] })
      .mockResolvedValueOnce({
        status: 'ok',
        data: [
          { name: 'Chapter 1.md', is_dir: false, path: '/proj/Chapter 1.md', size: 0, mtime: 0 },
          { name: 'Chapter 2.md', is_dir: false, path: '/proj/Chapter 2.md', size: 0, mtime: 0 },
        ],
      })
      .mockResolvedValueOnce({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 3.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', 'Chapter 3.md');
  });

  it('refreshes a non-root target dir via expandFolder + refreshFolder', async () => {
    h.projectState.dirPath = '/proj';
    h.settingsState.resolveNewFileDir.mockReturnValue('/proj/sub');
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/sub/Chapter 1.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    expect(h.projectState.expandFolder).toHaveBeenCalledWith('/proj/sub');
    expect(h.projectState.refreshFolder).toHaveBeenCalledWith('/proj/sub');
    expect(h.projectState.updateFiles).not.toHaveBeenCalled();
  });

  it('returns early when createFile errors', async () => {
    h.projectState.dirPath = '/proj';
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.createFile.mockResolvedValue({ status: 'error', error: 'disk full' });
    await createNewFileInProject();
    expect(h.settingsState.recordLastUsedDir).not.toHaveBeenCalled();
    expect(h.tabsState.openTab).not.toHaveBeenCalled();
  });

  it('resolves {date:fmt} macros in the template before numbering', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 7, 14, 8, 32));
    try {
      h.projectState.dirPath = '/proj';
      h.newFileState.template = '{date:YYMMDD}-{N}';
      h.newFileState.detectFromFolder = true;
      h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
      h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/260507-1.md' });
      h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
      await createNewFileInProject();
      expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', '260507-1.md');
    } finally {
      // Restore template for subsequent tests
      h.newFileState.template = 'Chapter {N}';
      vi.useRealTimers();
    }
  });
});

describe('[contract] executeTemplate — insert mode', () => {
  function fakeView(doc = 'ab') {
    return {
      state: {
        doc: { toString: () => doc },
        selection: { main: { from: 1, to: 1 } },
      },
      dispatch: vi.fn(),
      focus: vi.fn(),
    };
  }

  it('dispatches the resolved body into the active selection', async () => {
    h.projectState.dirPath = '/proj';
    h.templatesStoreMock.read.mockResolvedValue({ body: 'Hello world' });
    const view = fakeView();
    const err = await executeTemplate(
      { id: 'x', name: 'X', source: 'project', mode: 'insert' } as any,
      () => view as any,
      t,
    );
    expect(err).toBeNull();
    expect(view.dispatch).toHaveBeenCalled();
    const call = view.dispatch.mock.calls[0][0];
    expect(call.changes).toEqual({ from: 1, to: 1, insert: 'Hello world' });
    // No $|$ anchor in the body → caret goes to end of insert (from + length).
    expect(call.selection).toEqual({ anchor: 1 + 'Hello world'.length });
    expect(view.focus).toHaveBeenCalled();
  });

  it('places caret at the $|$ anchor when present', async () => {
    h.projectState.dirPath = '/proj';
    h.templatesStoreMock.read.mockResolvedValue({ body: 'pre $|$ post' });
    const view = fakeView();
    await executeTemplate(
      { id: 'x', name: 'X', source: 'project', mode: 'insert' } as any,
      () => view as any,
      t,
    );
    const call = view.dispatch.mock.calls[0][0];
    // Body with anchor stripped: "pre  post" — anchor is at position 4.
    expect(call.changes.insert).toBe('pre  post');
    expect(call.selection.anchor).toBe(1 + 4);
  });

  it('returns the needActiveEditor key when no view', async () => {
    h.templatesStoreMock.read.mockResolvedValue({ body: 'x' });
    const err = await executeTemplate(
      { id: 'x', name: 'X', source: 'project', mode: 'insert' } as any,
      () => null,
      t,
    );
    expect(err).toBe('template.needActiveEditor');
  });

  it('returns the thrown error message as the error', async () => {
    h.templatesStoreMock.read.mockRejectedValue(new Error('disk read failed'));
    const err = await executeTemplate(
      { id: 'x', name: 'X', source: 'project', mode: 'insert' } as any,
      () => null,
      t,
    );
    expect(err).toBe('disk read failed');
  });
});

describe('[contract] executeTemplate — new-file mode', () => {
  it('returns needProject when no project is open', async () => {
    h.templatesStoreMock.read.mockResolvedValue({ body: 'x' });
    h.projectState.dirPath = null;
    const err = await executeTemplate(
      { id: 'x', name: 'X', source: 'project', mode: 'new-file' } as any,
      () => null,
      t,
    );
    expect(err).toBe('template.needProject');
  });

  it('creates a file + opens it with the resolved filename', async () => {
    h.projectState.dirPath = '/proj';
    h.templatesStoreMock.read.mockResolvedValue({ body: 'content' });
    h.cmd.createFileWithBody.mockResolvedValue({ status: 'ok', data: '/proj/MyTpl.md' });
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: 'content' });
    const err = await executeTemplate(
      {
        id: 'x',
        name: 'MyTpl',
        source: 'project',
        mode: 'new-file',
        defaultFilename: 'MyTpl.md',
      } as any,
      () => null,
      t,
    );
    expect(err).toBeNull();
    expect(h.cmd.createFileWithBody).toHaveBeenCalledWith('/proj', 'MyTpl.md', 'content');
    expect(h.tabsState.openTab).toHaveBeenCalledWith('/proj/MyTpl.md', 'content');
    expect(h.cmd.registerOpenFile).toHaveBeenCalledWith('/proj/MyTpl.md');
  });

  it('returns the error string when createFileWithBody fails', async () => {
    h.projectState.dirPath = '/proj';
    h.templatesStoreMock.read.mockResolvedValue({ body: 'content' });
    h.cmd.createFileWithBody.mockResolvedValue({ status: 'error', error: 'exists' });
    const err = await executeTemplate(
      { id: 'x', name: 'MyTpl', source: 'project', mode: 'new-file' } as any,
      () => null,
      t,
    );
    expect(err).toBe('exists');
  });

  it('falls back to <name>.md when no defaultFilename is given', async () => {
    h.projectState.dirPath = '/proj';
    h.templatesStoreMock.read.mockResolvedValue({ body: 'x' });
    h.cmd.createFileWithBody.mockResolvedValue({ status: 'ok', data: '/proj/Untitled.md' });
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: 'x' });
    await executeTemplate(
      { id: 'x', name: 'Untitled', source: 'project', mode: 'new-file' } as any,
      () => null,
      t,
    );
    expect(h.cmd.createFileWithBody).toHaveBeenCalledWith('/proj', 'Untitled.md', 'x');
  });

  it('logs a safe warning without authorizing managed state when template enrollment write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.projectState.dirPath = '/proj';
      h.templatesStoreMock.read.mockResolvedValue({ body: '# 开篇\n\ncontent' });
      h.cmd.createFileWithBody.mockResolvedValue({ status: 'ok', data: '/proj/第1章-开篇.md' });
      h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
      h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '# 开篇\n\ncontent' });
      h.cmd.writeManagedNameState.mockResolvedValue({ status: 'error', error: 'disk path /proj/secret.md' });

      const err = await executeTemplate(
        {
          id: 'x',
          name: 'Chapter',
          source: 'project',
          mode: 'new-file',
          defaultFilename: '第{N}章-{title}.md',
        } as any,
        () => null,
        t,
      );

      expect(err).toBeNull();
      expect(warn).toHaveBeenCalledWith('Managed-name enrollment failed during template file creation');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/第1章-开篇.md');
      await expect(loadManagedName('/proj', '/proj/第1章-开篇.md')).resolves.toEqual({ kind: 'missing' });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('[contract] persistManagedNameEnrollment (shared Sidebar + Cmd+N helper)', () => {
  it('enrolls managed naming when the source template contains canonical {title}', async () => {
    h.projectState.dirPath = '/proj';
    h.cmd.readManagedNameState.mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '第{N}章-{title}',
        currentH1: '',
        documentKey: 'chapter.md',
      },
    });
    await expect(persistManagedNameEnrollment(
      '/proj',
      '/proj/chapter.md',
      '第{N}章-{title}',
      '',
      'Managed-name enrollment failed during sidebar header new-file creation',
    )).resolves.toBe('enrolled');
    expect(h.cmd.writeManagedNameState).toHaveBeenCalledWith('/proj', '/proj/chapter.md', {
      version: 1,
      status: 'managed',
      templateRaw: '第{N}章-{title}',
      currentH1: '',
      documentKey: 'chapter.md',
    });
  });

  it('does not enroll when the source template lacks canonical {title}', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await persistManagedNameEnrollment(
        '/proj',
        '/proj/notes.md',
        'Chapter {N}',
        '',
        'Managed-name enrollment failed during sidebar header new-file creation',
      );
      expect(h.cmd.computeDocumentKey).not.toHaveBeenCalled();
      expect(h.cmd.writeManagedNameState).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    '/proj/board.kanban',
    '/proj/plot.canvas',
    '/proj/notes.txt',
    '/proj/plugin.json',
  ])('does not enroll non-Markdown file %s', async (filePath) => {
    await persistManagedNameEnrollment('/proj', filePath, '{title}', '', 'warning');
    expect(h.cmd.computeDocumentKey).not.toHaveBeenCalled();
    expect(h.cmd.writeManagedNameState).not.toHaveBeenCalled();
  });

  it('confirms successful enrollment through an authoritative persistence read', async () => {
    h.cmd.readManagedNameState.mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '{title}',
        currentH1: '',
        documentKey: 'chapter.md',
      },
    });
    await expect(
      persistManagedNameEnrollment('/proj', '/proj/chapter.md', '{title}', '', 'warning'),
    ).resolves.toBe('enrolled');
    expect(h.cmd.readManagedNameState).toHaveBeenCalledWith('/proj', '/proj/chapter.md');
  });

  it('reports failed enrollment when a successful write is not observable on read-back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.cmd.readManagedNameState.mockResolvedValueOnce({ status: 'ok', data: null });
      await expect(
        persistManagedNameEnrollment('/proj', '/proj/chapter.md', '{title}', '', 'safe warning'),
      ).resolves.toBe('failed');
      expect(warn).toHaveBeenCalledWith('safe warning');
      await expect(loadManagedName('/proj', '/proj/chapter.md')).resolves.toEqual({ kind: 'missing' });
    } finally {
      warn.mockRestore();
    }
  });

  it('uses the shared Markdown H1 parser when enrolling template-created files', async () => {
    h.projectState.dirPath = '/proj';
    const body = '```md\n# code sample\n```\n\n真实标题\n====\n';
    h.templatesStoreMock.read.mockResolvedValue({ body });
    h.cmd.createFileWithBody.mockResolvedValue({ status: 'ok', data: '/proj/真实标题.md' });
    h.cmd.listDirectory.mockResolvedValue({ status: 'ok', data: [] });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: body });
    h.cmd.readManagedNameState.mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '{title}',
        currentH1: '真实标题',
        documentKey: '真实标题.md',
      },
    });

    await executeTemplate(
      { id: 'x', name: 'Chapter', source: 'project', mode: 'new-file', defaultFilename: '{title}' } as any,
      () => null,
      t,
    );

    expect(h.cmd.writeManagedNameState).toHaveBeenCalledWith(
      '/proj',
      '/proj/真实标题.md',
      expect.objectContaining({ currentH1: '真实标题' }),
    );
  });

  it('rejects typo tokens like {Title} and { title } without enrollment', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await persistManagedNameEnrollment('/proj', '/proj/a.md', 'Chapter {Title}', '', 'w1');
      await persistManagedNameEnrollment('/proj', '/proj/b.md', 'Chapter { title }', '', 'w2');
      await persistManagedNameEnrollment('/proj', '/proj/c.md', 'Chapter {TITLE}', '', 'w3');
      expect(h.cmd.writeManagedNameState).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the static safe warning without leaking file paths when write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.cmd.writeManagedNameState.mockResolvedValue({ status: 'error', error: 'disk /proj/secret.md' });
      await persistManagedNameEnrollment(
        '/proj',
        '/proj/第1章-Untitled.md',
        '第{N}章-{title}',
        '',
        'Managed-name enrollment failed during sidebar header new-file creation',
      );
      expect(warn).toHaveBeenCalledWith('Managed-name enrollment failed during sidebar header new-file creation');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/第1章-Untitled.md');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('never throws even if enableManagedNameForCreatedFile rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.cmd.computeDocumentKey.mockRejectedValue(new Error('boom /proj/leak.md'));
      await expect(
        persistManagedNameEnrollment(
          '/proj',
          '/proj/chapter.md',
          '第{N}章-{title}',
          '',
          'Managed-name enrollment failed during sidebar context-menu new-file creation',
        ),
      ).resolves.toBe('failed');
      expect(warn).toHaveBeenCalledWith('Managed-name enrollment failed during sidebar context-menu new-file creation');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/leak.md');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('[contract] currentFilenameTemplateRaw (shared Sidebar + Cmd+N gate)', () => {
  it('returns the resolved newFileSettings template so Sidebar shares Cmd+N enrollment gate', () => {
    h.projectState.dirPath = '/proj';
    h.newFileState.template = '第{N}章-{title}';
    expect(currentFilenameTemplateRaw()).toBe('第{N}章-{title}');
  });

  it('preserves the exact literal {title} even when the raw template also has other tokens', () => {
    h.projectState.dirPath = '/proj';
    h.newFileState.template = '{date:YYYY}-{title}';
    const resolved = currentFilenameTemplateRaw();
    expect(resolved).toContain('{title}');
  });
});

describe('[contract] requestSaveCurrentAsTemplate', () => {
  function fakeView(body = 'hello') {
    return {
      state: { doc: { toString: () => body } },
    };
  }

  it('no-ops when no project is open', () => {
    const onDialog = vi.fn();
    requestSaveCurrentAsTemplate(() => fakeView() as any, t, onDialog);
    expect(onDialog).not.toHaveBeenCalled();
  });

  it('no-ops when no active editor is available', () => {
    h.projectState.dirPath = '/proj';
    const onDialog = vi.fn();
    requestSaveCurrentAsTemplate(() => null, t, onDialog);
    expect(onDialog).not.toHaveBeenCalled();
  });

  it('opens the template panel and forwards a prefilled dialog', () => {
    h.projectState.dirPath = '/proj';
    h.tabsState.activeTab = { filePath: '/proj/a.md', fileName: 'a.md' };
    h.uiState.templateVisible = false;
    const onDialog = vi.fn();
    requestSaveCurrentAsTemplate(() => fakeView('body') as any, t, onDialog);
    expect(h.uiState.toggleTemplate).toHaveBeenCalled();
    expect(onDialog).toHaveBeenCalledWith({ name: 'a', body: 'body' });
  });

  it('does not re-toggle the panel when already visible', () => {
    h.projectState.dirPath = '/proj';
    h.tabsState.activeTab = { filePath: '/proj/a.md', fileName: 'a.md' };
    h.uiState.templateVisible = true;
    requestSaveCurrentAsTemplate(() => fakeView() as any, t, vi.fn());
    expect(h.uiState.toggleTemplate).not.toHaveBeenCalled();
  });

  it('uses the translation default when activeTab has no name', () => {
    h.projectState.dirPath = '/proj';
    h.tabsState.activeTab = null;
    const onDialog = vi.fn();
    requestSaveCurrentAsTemplate(() => fakeView() as any, t, onDialog);
    expect(onDialog).toHaveBeenCalledWith({ name: 'template.defaultNewName', body: 'hello' });
  });
});
