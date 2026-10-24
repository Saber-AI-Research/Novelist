import { test, expect } from '../fixtures/app-fixture';
import type { Page } from '@playwright/test';
import type { ProjectConfig } from '../../../app/lib/ipc/commands';

const TRANSLATION_PROJECT_DIR = '/mock/book-translation';
const FIRST_CHAPTER_PATH = `${TRANSLATION_PROJECT_DIR}/翻译内容/0001.novtrans`;

const TRANSLATION_PROJECT_CONFIG: ProjectConfig = {
  project: {
    name: 'Demo Translation',
    type: 'book-translation',
    version: '1.0',
  },
  outline: { order: ['翻译内容/0001.novtrans', '翻译内容/0002.novtrans'] },
  writing: { daily_goal: 0, auto_save_minutes: 1 },
  plugins: { enabled: { 'book-translation': false } },
};

const FIRST_CHAPTER = JSON.stringify({
  schemaVersion: 1,
  book: {
    title: 'Demo Book',
    author: 'Demo Author',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
  },
  chapter: {
    id: 'chapter-0001',
    title: '第一章',
    volume: null,
    index: 1,
    total: 2,
    previousPath: null,
    nextPath: '翻译内容/0002.novtrans',
  },
  segments: [
    { id: 'segment-0001', source: 'Hello', translation: '', googleReference: null, llmReference: null },
    { id: 'segment-0002', source: '世界', translation: '', googleReference: null, llmReference: null },
  ],
});

type ImportOverrides = { title?: string; holdCreate?: boolean };

/**
 * Route the native file picker to the mock book, optionally rename the
 * inspected book, and optionally hold `create_book_translation_project` until
 * `window.__releaseCreate()` runs (calls are counted in `__createCalls`).
 */
async function overrideImportInvokes(app: Page, overrides: ImportOverrides = {}) {
  await app.evaluate(({ title, holdCreate }) => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__');
    if (!internals || typeof internals !== 'object') throw new Error('Tauri internals unavailable');
    const invoke = Reflect.get(internals, 'invoke');
    if (typeof invoke !== 'function') throw new Error('Tauri invoke unavailable');
    const boundInvoke = invoke.bind(internals) as (command: string, args: unknown) => Promise<unknown>;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    Reflect.set(window, '__releaseCreate', () => release());
    Reflect.set(window, '__createCalls', 0);
    Reflect.set(internals, 'invoke', async (command: string, args: unknown) => {
      if (command === 'plugin:dialog|open') return '/mock/books/demo.txt';
      if (command === 'inspect_literary_source' && title !== undefined) {
        const inspected = await boundInvoke(command, args);
        return { ...(inspected as object), title };
      }
      if (command === 'create_book_translation_project' && holdCreate) {
        Reflect.set(window, '__createCalls', Number(Reflect.get(window, '__createCalls')) + 1);
        await released;
      }
      return boundInvoke(command, args);
    });
  }, overrides);
}

async function openImportDialog(app: Page) {
  await app.getByRole('button', { name: 'New Project', exact: true }).click();
  await app.getByTestId('new-project-category-book-translation').click();
  const template = app.getByTestId('new-project-template-book-translation');
  await expect(template).toBeVisible();
  await template.dblclick();
  const dialog = app.getByTestId('translation-import-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('Book translation projects', () => {
  test('imports a book with explicit source and target languages', async ({ app, mockState }) => {
    const dialog = await openImportDialog(app);
    await overrideImportInvokes(app, { title: 'Fate/Zero' });

    await dialog.getByTestId('translation-import-source').click();
    await expect(dialog.getByTestId('translation-import-preview')).toContainText('Hello');
    // A title with a path separator becomes a valid single folder name.
    await expect(dialog.getByTestId('translation-import-project-name')).toHaveValue('Fate-Zero');
    await dialog.getByTestId('translation-import-source-language').selectOption('en');
    await dialog.getByTestId('translation-import-target-language').selectOption('ja');
    await dialog.getByTestId('translation-import-parent-dir').fill('/mock/home/Documents');
    await dialog.getByTestId('translation-import-submit').click();

    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'create_book_translation_project')).toHaveLength(1);
    const [create] = (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'create_book_translation_project');
    expect(create.args.request).toMatchObject({
      projectName: 'Fate-Zero',
      parentDir: '/mock/home/Documents',
      title: 'Fate/Zero',
      sourceLanguage: 'en',
      targetLanguage: 'ja',
    });
    await expect(app.getByTestId('tab-0001.novtrans')).toBeVisible();
  });

  test('rejects a typed project name containing a path separator', async ({ app, mockState }) => {
    const dialog = await openImportDialog(app);
    await overrideImportInvokes(app);
    await dialog.getByTestId('translation-import-source').click();
    await expect(dialog.getByTestId('translation-import-preview')).toContainText('Hello');
    await dialog.getByTestId('translation-import-parent-dir').fill('/mock/home/Documents');

    await dialog.getByTestId('translation-import-project-name').fill('../escape');
    await expect(dialog.getByTestId('translation-import-submit')).toBeDisabled();
    await app.keyboard.press('Meta+Enter');
    expect((await mockState.getInvokeCalls())
      .filter((call) => call.command === 'create_book_translation_project')).toEqual([]);

    await dialog.getByTestId('translation-import-project-name').fill('My Translation');
    await expect(dialog.getByTestId('translation-import-submit')).toBeEnabled();
  });

  test('cannot be closed or resubmitted while the project is being created', async ({ app, mockState }) => {
    const dialog = await openImportDialog(app);
    await overrideImportInvokes(app, { holdCreate: true });
    await dialog.getByTestId('translation-import-source').click();
    await expect(dialog.getByTestId('translation-import-preview')).toContainText('Hello');
    await dialog.getByTestId('translation-import-parent-dir').fill('/mock/home/Documents');
    await dialog.getByTestId('translation-import-submit').click();
    await expect.poll(() => app.evaluate(() => Reflect.get(window, '__createCalls'))).toBe(1);

    await app.keyboard.press('Escape');
    await app.keyboard.press('Meta+Enter');
    await app.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    const cancelButtons = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancelButtons).toHaveCount(2);
    for (const button of await cancelButtons.all()) await expect(button).toBeDisabled();
    await expect(dialog.getByTestId('translation-import-submit')).toBeDisabled();
    expect(await app.evaluate(() => Reflect.get(window, '__createCalls'))).toBe(1);

    await app.evaluate(() => (Reflect.get(window, '__releaseCreate') as () => void)());
    await expect(dialog).not.toBeVisible();
    await expect(app.getByTestId('tab-0001.novtrans')).toBeVisible();
    expect((await mockState.getInvokeCalls())
      .filter((call) => call.command === 'create_book_translation_project')).toHaveLength(1);
  });

  test('discards an imported chapter read after switching away and back to the project', async ({ app, mockState }) => {
    const projectPath = '/mock/home/Documents/Import Race';
    const chapterPath = `${projectPath}/翻译内容/0001.novtrans`;
    await app.getByRole('button', { name: 'New Project', exact: true }).click();
    await app.getByTestId('new-project-template-book-translation').dblclick();
    const dialog = app.getByTestId('translation-import-dialog');
    await app.evaluate(() => {
      const tauri = Reflect.get(window, '__TAURI_INTERNALS__');
      if (!tauri || typeof tauri !== 'object') throw new Error('Tauri internals unavailable');
      const originalInvoke = Reflect.get(tauri, 'invoke');
      if (typeof originalInvoke !== 'function') throw new Error('Tauri invoke unavailable');
      Reflect.set(tauri, 'invoke', (command: string, args: unknown) => command === 'plugin:dialog|open'
        ? Promise.resolve('/mock/books/demo.txt')
        : originalInvoke.call(tauri, command, args));
    });
    await dialog.getByTestId('translation-import-source').click();
    await expect(dialog.getByTestId('translation-import-preview')).toContainText('Hello');
    await dialog.getByTestId('translation-import-project-name').fill('Import Race');
    await dialog.getByTestId('translation-import-parent-dir').fill('/mock/home/Documents');
    await mockState.setFileContent(chapterPath, FIRST_CHAPTER);
    await mockState.setReadFileBlocked(chapterPath, true);
    await dialog.getByTestId('translation-import-submit').click();
    try {
      await expect.poll(async () => (await mockState.getInvokeCalls()).filter((call) =>
        call.command === 'read_file' && call.args.path === chapterPath).length).toBe(1);
      // Exercise a new generation of the same path, not only a different path.
      await app.evaluate(async (sourcePath) => {
        const api = Reflect.get(window, '__test_api__');
        if (!api || typeof api !== 'object') throw new Error('Test API unavailable');
        const openProject = Reflect.get(api, 'openProject');
        if (typeof openProject !== 'function') throw new Error('openProject unavailable');
        await openProject('/mock/another-project');
        await openProject(sourcePath);
      }, projectPath);
      await mockState.setReadFileBlocked(chapterPath, false);
      await expect(dialog).not.toBeVisible();
      await expect(app.getByTestId('tab-0001.novtrans')).toHaveCount(0);
      expect((await mockState.getInvokeCalls()).filter((call) =>
        call.command === 'register_open_file' && call.args.path === chapterPath)).toEqual([]);
    } finally {
      await mockState.setReadFileBlocked(chapterPath, false);
    }
  });

  test('enables the plugin and opens the first chapter of a translation project', async ({ app, mockState }) => {
    const files = [
      { name: '翻译内容', path: `${TRANSLATION_PROJECT_DIR}/翻译内容`, is_dir: true, size: 0 },
      { name: '0001.novtrans', path: FIRST_CHAPTER_PATH, is_dir: false, size: FIRST_CHAPTER.length },
    ];
    await mockState.openProject(TRANSLATION_PROJECT_DIR, files);
    await mockState.setProjectConfig(TRANSLATION_PROJECT_CONFIG);
    await mockState.setFileContent(FIRST_CHAPTER_PATH, FIRST_CHAPTER);

    await app.evaluate((path) => {
      const api = Reflect.get(window, '__test_api__');
      if (!api || typeof api !== 'object') throw new Error('Test API unavailable');
      const openProject = Reflect.get(api, 'openProject');
      if (typeof openProject !== 'function') throw new Error('openProject unavailable');
      return openProject(path);
    }, TRANSLATION_PROJECT_DIR);
    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter((call) => call.command === 'set_plugin_enabled'))
      .toContainEqual({
        command: 'set_plugin_enabled',
        args: { pluginId: 'book-translation', enabled: true },
      });

    await app.evaluate((path) => {
      const api = Reflect.get(window, '__test_api__');
      if (!api || typeof api !== 'object') throw new Error('Test API unavailable');
      const openFile = Reflect.get(api, 'openFile');
      if (typeof openFile !== 'function') throw new Error('openFile unavailable');
      return openFile(path);
    }, FIRST_CHAPTER_PATH);
    await expect(app.getByTestId('tab-0001.novtrans')).toBeVisible();
  });
});
