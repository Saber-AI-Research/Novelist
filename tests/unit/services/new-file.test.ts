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
  executeTemplate,
  requestSaveCurrentAsTemplate,
} from '$lib/services/new-file';

const t = (k: string) => k;

beforeEach(() => {
  Object.values(h.cmd).forEach((fn: any) => fn.mockReset?.());
  h.cmd.registerOpenFile.mockResolvedValue({ status: 'ok' });
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

  it('inferNextName uses an empty sibling list when detectFromFolder is false', async () => {
    h.projectState.dirPath = '/proj';
    h.newFileState.detectFromFolder = false;
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
    h.cmd.createFile.mockResolvedValue({ status: 'ok', data: '/proj/Chapter 1.md' });
    h.cmd.readFile.mockResolvedValue({ status: 'ok', data: '' });
    await createNewFileInProject();
    // With siblings ignored, we propose "Chapter 1" again.
    expect(h.cmd.createFile).toHaveBeenCalledWith('/proj', 'Chapter 1.md');
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
