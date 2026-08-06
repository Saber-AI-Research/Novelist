import { test, expect } from '../fixtures/app-fixture';
import type { LiteraryStudyOverview, ProjectConfig } from '../../../app/lib/ipc/commands';

const PROJECT_DIR = '/mock/literary-study';
const CHAPTER_DIR = `${PROJECT_DIR}/学习内容`;

const PROJECT_CONFIG: ProjectConfig = {
  project: {
    name: 'The Analects Study',
    type: 'literary-study',
    version: '1.0',
  },
  outline: { order: [] },
  writing: { daily_goal: 0, auto_save_minutes: 1 },
  plugins: { enabled: { 'literary-commentary': true } },
};

const OVERVIEW: LiteraryStudyOverview = {
  schemaVersion: 3,
  sourcePath: '/mock/books/analects.txt',
  title: 'The Analects',
  author: 'Confucius',
  language: 'zh-CN',
  chapterCount: 2,
  completedChapters: 1,
  copiedCharacters: 8,
  totalCharacters: 16,
  mistakes: 2,
  pasted: 0,
  resumeChapterPath: '学习内容/Chapter Two.litstudy',
  importOptions: {
    directoryMode: 'by-volume',
    numberingMode: 'global',
    cleanChapterTitles: true,
  },
  chapters: [
    {
      id: 'chapter-0001',
      title: 'Chapter One',
      volume: 'Book I',
      index: 1,
      total: 2,
      relativePath: '学习内容/Chapter One.litstudy',
      sourceCharacters: 8,
      copiedCharacters: 8,
      mistakes: 1,
      pasted: 0,
      completed: true,
    },
    {
      id: 'chapter-0002',
      title: 'Chapter Two',
      volume: 'Book I',
      index: 2,
      total: 2,
      relativePath: '学习内容/Chapter Two.litstudy',
      sourceCharacters: 8,
      copiedCharacters: 0,
      mistakes: 1,
      pasted: 0,
      completed: false,
    },
  ],
};

test.describe('Literary commentary projects', () => {
  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('offers literary commentary as a first-class project type before plugins load', async ({
    app,
    browserErrors,
  }) => {
    await app.getByRole('button', { name: 'New Project', exact: true }).click();
    await app.waitForTimeout(250);
    expect(browserErrors).toEqual([]);

    const literaryCategory = app.getByTestId('new-project-category-literary-study');
    await expect(literaryCategory).toBeVisible();
    await literaryCategory.click();

    const literaryTemplate = app.getByTestId('new-project-template-literary-commentary');
    await expect(literaryTemplate).toBeVisible();
    await literaryTemplate.click();
    await app.getByRole('button', { name: 'Choose Book', exact: true }).click();

    await expect(app.getByTestId('literary-import-dialog')).toBeVisible();
    await expect(app.getByRole('heading', {
      name: 'Create Literary Commentary Project',
    })).toBeVisible();
  });

  test('keeps the import actions reachable below a bounded preview', async ({
    app,
    browserErrors,
  }) => {
    await app.setViewportSize({ width: 900, height: 600 });
    await app.getByRole('button', { name: 'New Project', exact: true }).click();
    await app.getByTestId('new-project-category-literary-study').click();
    await app.getByTestId('new-project-template-literary-commentary').click();
    await app.getByRole('button', { name: 'Choose Book', exact: true }).click();

    await app.evaluate(() => {
      const tauri = (window as any).__TAURI_INTERNALS__;
      const invoke = tauri.invoke.bind(tauri);
      tauri.invoke = (command: string, args: unknown) => command === 'plugin:dialog|open'
        ? Promise.resolve('/mock/books/demo.txt')
        : invoke(command, args);
    });
    await app.getByRole('button', { name: 'Choose EPUB / TXT', exact: true }).click();

    const dialog = app.getByTestId('literary-import-dialog');
    const footer = app.getByTestId('literary-import-footer');
    const submit = app.getByTestId('literary-import-submit');
    await expect(app.getByRole('textbox', { name: 'Chapter preview' })).toBeVisible();
    const directoryMode = app.getByTestId('literary-directory-mode');
    const numberingMode = app.getByTestId('literary-numbering-mode');
    await expect(directoryMode).toHaveValue('by-volume');
    await expect(numberingMode).toHaveValue('global');
    await numberingMode.selectOption('per-volume');
    await directoryMode.selectOption('flat');
    await expect(numberingMode).toBeDisabled();
    await expect(numberingMode).toHaveValue('global');
    await directoryMode.selectOption('by-volume');
    await expect(numberingMode).toBeEnabled();
    await expect(dialog).toBeInViewport();
    await expect(footer).toBeInViewport();
    await expect(submit).toBeVisible();
    await expect(submit).toBeInViewport();
    expect(browserErrors).toEqual([]);
  });

  test('auto-enables the editor and exposes progress plus book replacement in the side panel', async ({
    app,
    mockState,
    browserErrors,
  }) => {
    const files = [
      { name: '学习内容', path: CHAPTER_DIR, is_dir: true, size: 0 },
      {
        name: 'Chapter One.litstudy',
        path: `${CHAPTER_DIR}/Chapter One.litstudy`,
        is_dir: false,
        size: 256,
      },
      {
        name: 'Chapter Two.litstudy',
        path: `${CHAPTER_DIR}/Chapter Two.litstudy`,
        is_dir: false,
        size: 256,
      },
    ];
    await mockState.openProject(PROJECT_DIR, files);
    await mockState.setProjectConfig(PROJECT_CONFIG);
    await mockState.setLiteraryOverview(OVERVIEW);

    await app.evaluate((path) => (window as any).__test_api__.openProject(path), PROJECT_DIR);
    await expect(app.getByTestId('app-layout')).toBeVisible();
    await expect(app.getByTestId('toggle-literary-study')).toBeVisible();

    const enableCalls = (await mockState.getInvokeCalls()).filter(
      (call) => call.command === 'set_plugin_enabled',
    );
    expect(enableCalls).toEqual([{
      command: 'set_plugin_enabled',
      args: { pluginId: 'literary-commentary', enabled: true },
    }]);

    await app.getByTestId('toggle-literary-study').click();
    await app.waitForTimeout(250);
    expect(browserErrors).toEqual([]);
    const panel = app.getByTestId('literary-study-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('The Analects');
    await expect(panel).toContainText('1 of 2 chapters');
    await expect(panel).toContainText('Chapter One');
    await expect(panel).toContainText('Chapter Two');

    await panel.getByPlaceholder('Search chapters').fill('Two');
    await expect(panel).not.toContainText('Chapter One');
    await expect(panel).toContainText('Chapter Two');

    await app.getByTestId('literary-replace-book').click();
    await expect(app.getByTestId('literary-import-dialog')).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Replace Imported Book' })).toBeVisible();
  });

  test('creates new files beside the active literary chapter, not in a stale directory', async ({
    app,
    mockState,
    browserErrors,
  }) => {
    const volumeDir = `${CHAPTER_DIR}/Book I`;
    const chapterPath = `${volumeDir}/Chapter One.litstudy`;
    const staleDir = `${PROJECT_DIR}/其他目录`;
    const files = [
      { name: '学习内容', path: CHAPTER_DIR, is_dir: true, size: 0 },
      { name: 'Book I', path: volumeDir, is_dir: true, size: 0 },
      { name: '其他目录', path: staleDir, is_dir: true, size: 0 },
      { name: 'Chapter One.litstudy', path: chapterPath, is_dir: false, size: 256 },
    ];
    await mockState.openProject(PROJECT_DIR, files);
    await mockState.setProjectConfig(PROJECT_CONFIG);
    await mockState.setFileContent(chapterPath, JSON.stringify({
      schemaVersion: 1,
      book: { title: 'The Analects', author: 'Confucius', language: 'zh-CN' },
      chapter: {
        id: 'chapter-0001', title: 'Chapter One', volume: 'Book I', index: 1, total: 1,
        previousPath: null, nextPath: null,
      },
      source: '学而时习之，不亦说乎？',
      sourceCursor: 0,
      insertions: [],
      stats: { correct: 0, mistakes: 0, pasted: 0, startedAt: null, completedAt: null },
    }));
    await app.evaluate(([projectDir, lastUsedDir]) => {
      localStorage.setItem(
        `__novelist_mock_project_settings__:${projectDir}`,
        JSON.stringify({
          view: {},
          new_file: { last_used_dir: lastUsedDir },
          plugins: { enabled: { 'literary-commentary': true } },
        }),
      );
    }, [PROJECT_DIR, staleDir] as const);

    await app.evaluate(async ([projectDir, filePath]) => {
      await (window as any).__test_api__.openProject(projectDir);
      await (window as any).__test_api__.openFile(filePath);
    }, [PROJECT_DIR, chapterPath] as const);
    await expect(app.getByTestId('tab-Chapter One.litstudy')).toBeVisible();

    await app.evaluate(() => (window as any).__test_api__.newFile());
    await expect.poll(async () => {
      const calls = await mockState.getInvokeCalls();
      return calls.findLast((call) => call.command === 'create_file')?.args.parentDir;
    }).toBe(volumeDir);

    await app.evaluate(async (filePath) => {
      await (window as any).__test_api__.openFile(filePath);
    }, chapterPath);
    await app.getByTestId('sidebar-new-file').click();
    await app.getByTestId('sidebar-input').press('Enter');
    await expect.poll(async () => {
      const calls = await mockState.getInvokeCalls();
      return calls.filter((call) => call.command === 'create_file').at(-1)?.args.parentDir;
    }).toBe(volumeDir);

    await app.getByTestId('sidebar-files').click({ button: 'right', position: { x: 8, y: 300 } });
    await expect(app.getByTestId('sidebar-view-new-literary-commentary')).toHaveCount(0);
    expect(browserErrors).toEqual([]);
  });
});
