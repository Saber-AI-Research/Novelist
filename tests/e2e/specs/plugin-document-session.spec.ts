import type { Frame, Page } from '@playwright/test';
import { test, expect, type MockInvokeCall } from '../fixtures/app-fixture';
import type { MockFileEntry } from '../fixtures/mock-data';
import {
  allowOpaqueOriginPluginModules,
  capturePluginInbox,
  exposePluginPorts,
  pluginInbox,
} from '../fixtures/plugin-host';
import type { ProjectConfig } from '../../../app/lib/ipc/commands';

/**
 * [regression] Two panes showing the same `.novtrans` chapter must share one
 * document state: sequential edits in different panes both persist, stale
 * snapshots (sibling edit, reload) cannot write, and a racing local edit is
 * surfaced for explicit recovery instead of being dropped or marked saved.
 * Runs the real book-translation plugin inside the host's PluginFileEditor.
 */

const PROJECT_DIR = '/mock/plugin-session';
const CHAPTER_PATH = `${PROJECT_DIR}/翻译内容/0001.novtrans`;
const PLUGIN_IFRAME = 'iframe[title="Book Translation"]';

const PROJECT_CONFIG: ProjectConfig = {
  project: { name: 'Plugin Session', type: 'book-translation', version: '1.0' },
  outline: { order: ['翻译内容/0001.novtrans'] },
  writing: { daily_goal: 0, auto_save_minutes: 1 },
  plugins: { enabled: { 'book-translation': false } },
};

const CHAPTER = JSON.stringify({
  schemaVersion: 1,
  book: { title: 'Demo Book', author: 'Demo Author', sourceLanguage: 'en', targetLanguage: 'zh-CN' },
  chapter: {
    id: 'chapter-0001',
    title: '第一章',
    volume: null,
    index: 1,
    total: 1,
    previousPath: null,
    nextPath: null,
  },
  segments: [
    { id: 'segment-0001', source: 'Hello', translation: '', googleReference: null, llmReference: null },
    { id: 'segment-0002', source: 'World', translation: '', googleReference: null, llmReference: null },
  ],
});

interface CapturedFileOpen {
  documentId: string;
  revision: number;
  content: string;
}

interface SessionMockState {
  openProject(dirPath: string, files: MockFileEntry[]): Promise<void>;
  setProjectConfig(config: ProjectConfig): Promise<void>;
  setFileContent(path: string, content: string): Promise<void>;
  getInvokeCalls(): Promise<MockInvokeCall[]>;
}

function translations(content: string | null): string[] {
  if (!content) return [];
  const parsed = JSON.parse(content) as { segments: Array<{ translation: string }> };
  return parsed.segments.map((segment) => segment.translation);
}

function withSecondTranslation(content: string, translation: string): string {
  const parsed = JSON.parse(content) as { segments: Array<{ translation: string }> };
  parsed.segments[1].translation = translation;
  return JSON.stringify(parsed);
}

async function callTestApi(app: Page, name: string, arg?: string): Promise<void> {
  await app.evaluate(([method, value]) => {
    const api = Reflect.get(window, '__test_api__');
    if (!api || typeof api !== 'object') throw new Error('Test API unavailable');
    const fn = Reflect.get(api, method);
    if (typeof fn !== 'function') throw new Error(`${method} unavailable`);
    return fn(value);
  }, [name, arg] as const);
}

async function pluginFrame(app: Page, index: number): Promise<Frame> {
  const handle = await app.locator(PLUGIN_IFRAME).nth(index).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`Plugin iframe ${index} unavailable`);
  await expect(frame.getByTestId('book-translation-workspace')).toBeVisible();
  return frame;
}

/** Snapshots the host hands this pane: its own `file-open`s and sibling `file-sync`s. */
async function captureFileOpens(frame: Frame): Promise<void> {
  await capturePluginInbox(frame, ['file-open', 'file-sync']);
}

async function capturedFileOpens(frame: Frame): Promise<CapturedFileOpen[]> {
  return pluginInbox<CapturedFileOpen>(frame);
}

interface SaveResult {
  ok: boolean;
  saved: boolean;
  error: string | null;
}

/**
 * Post a `file-state` + `file-save` pair on the plugin's own host port and
 * resolve with the host's `file-save-result`. The host handles messages in
 * order, so the result is a barrier for both messages.
 */
async function postEditAndAwaitSave(frame: Frame, edit: CapturedFileOpen): Promise<SaveResult> {
  const message = { documentId: edit.documentId, revision: edit.revision, content: edit.content };
  return frame.evaluate((snapshot) => {
    const port = Reflect.get(window, '__NOVELIST_PLUGIN_PORT__') as MessagePort;
    const { promise, resolve } = Promise.withResolvers<SaveResult>();
    const onResult = (event: MessageEvent) => {
      if (event.data?.type !== 'file-save-result') return;
      if (event.data.documentId !== snapshot.documentId) return;
      port.removeEventListener('message', onResult);
      resolve({ ok: event.data.ok, saved: event.data.saved, error: event.data.error });
    };
    port.addEventListener('message', onResult);
    port.postMessage({ type: 'file-state', ...snapshot });
    port.postMessage({ type: 'file-save', ...snapshot });
    return promise;
  }, message);
}

/** Open the chapter in pane-1, split, and open the same file in pane-2. */
async function openChapterInBothPanes(app: Page, mockState: SessionMockState) {
  await mockState.openProject(PROJECT_DIR, [
    { name: '翻译内容', path: `${PROJECT_DIR}/翻译内容`, is_dir: true, size: 0 },
    { name: '0001.novtrans', path: CHAPTER_PATH, is_dir: false, size: CHAPTER.length },
  ]);
  await mockState.setProjectConfig(PROJECT_CONFIG);
  await mockState.setFileContent(CHAPTER_PATH, CHAPTER);
  await exposePluginPorts(app);
  await allowOpaqueOriginPluginModules(app);
  // Serve the real plugin from the dev server instead of the asset protocol.
  await app.evaluate(() => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__');
    const original = Reflect.get(internals, 'convertFileSrc') as (path: string, protocol?: string) => string;
    Reflect.set(internals, 'convertFileSrc', (path: string, protocol?: string) => (
      path.endsWith('/plugins/book-translation/index.html')
        ? '/plugins/book-translation/index.html'
        : original.call(internals, path, protocol)
    ));
  });

  await callTestApi(app, 'openProject', PROJECT_DIR);
  await expect.poll(async () => (await mockState.getInvokeCalls())
    .filter((call) => call.command === 'set_plugin_enabled'))
    .toContainEqual({ command: 'set_plugin_enabled', args: { pluginId: 'book-translation', enabled: true } });
  await callTestApi(app, 'openFile', CHAPTER_PATH);
  await pluginFrame(app, 0);

  await callTestApi(app, 'toggleSplit');
  await app.getByText(/Open a file in this pane|在此面板打开文件/).click();
  await callTestApi(app, 'openFile', CHAPTER_PATH);
  await expect(app.locator(PLUGIN_IFRAME)).toHaveCount(2);
  await expect(app.getByTestId('tab-0001.novtrans')).toHaveCount(2);
  const panes = { left: await pluginFrame(app, 0), right: await pluginFrame(app, 1) };
  // Host-side readiness: both PluginFileEditors finished the handshake.
  await expect(app.getByTestId('plugin-file-load-state')).toHaveCount(0);
  return panes;
}

test('[regression] plugin frames run in opaque origins and cannot script the host or each other', async ({ app, mockState }) => {
  const { left, right } = await openChapterInBothPanes(app, mockState);

  for (const frame of [left, right]) {
    expect(await frame.evaluate(() => self.origin)).toBe('null');
    // The exploit path of a compromised plugin: run code inside a sibling
    // plugin (whose messages the host would trust) or inside the host.
    expect(await frame.evaluate(() => {
      const reach = (target: Window) => {
        try {
          return String(target.document.title);
        } catch (error) {
          return (error as Error).name;
        }
      };
      return [...Array(window.parent.frames.length).keys()]
        .map((index) => window.parent.frames[index])
        .filter((sibling) => sibling !== window)
        .map(reach)
        .concat(reach(window.parent));
    })).toEqual(['SecurityError', 'SecurityError']);
  }
});

test.describe('[regression] shared plugin document sessions', () => {
  test('keeps sequential edits from both split panes and marks both tabs saved', async ({ app, mockState }) => {
    const { left, right } = await openChapterInBothPanes(app, mockState);

    await left.getByTestId('book-translation-translation-segment-0001').fill('左侧译文');
    await expect.poll(async () => translations(await mockState.getFileContent(CHAPTER_PATH)))
      .toEqual(['左侧译文', '']);
    await expect(right.getByTestId('book-translation-translation-segment-0001')).toHaveValue('左侧译文');

    await right.getByTestId('book-translation-translation-segment-0002').fill('右侧译文');
    await expect.poll(async () => translations(await mockState.getFileContent(CHAPTER_PATH)))
      .toEqual(['左侧译文', '右侧译文']);
    await expect(left.getByTestId('book-translation-translation-segment-0002')).toHaveValue('右侧译文');
    await expect(right.locator('.save-state.saved')).toBeVisible();
    await expect(app.locator('[data-testid="tab-0001.novtrans"] .dirty-dot')).toHaveCount(0);
  });

  test('ignores a reload-rotated token instead of restoring old content', async ({ app, mockState }) => {
    const { left, right } = await openChapterInBothPanes(app, mockState);
    await captureFileOpens(left);
    await right.getByTestId('book-translation-translation-segment-0001').fill('旧译文');
    await expect.poll(async () => translations(await mockState.getFileContent(CHAPTER_PATH)))
      .toEqual(['旧译文', '']);
    await expect.poll(async () => (await capturedFileOpens(left)).length).toBe(1);
    const [beforeReload] = await capturedFileOpens(left);
    await expect(app.locator('[data-testid="tab-0001.novtrans"] .dirty-dot')).toHaveCount(0);

    const external = withSecondTranslation(beforeReload.content, 'NEW DISK CONTENT');
    await mockState.setFileContent(CHAPTER_PATH, external);
    await mockState.emitEvent('file-changed', { path: CHAPTER_PATH });
    await expect(left.getByTestId('book-translation-translation-segment-0002')).toHaveValue('NEW DISK CONTENT');

    await expect(postEditAndAwaitSave(left, beforeReload)).resolves.toEqual({
      ok: false,
      saved: false,
      error: 'Plugin document is no longer current',
    });
    await expect(left.getByTestId('book-translation-translation-segment-0002')).toHaveValue('NEW DISK CONTENT');
    await expect(right.getByTestId('book-translation-translation-segment-0002')).toHaveValue('NEW DISK CONTENT');
    expect(await mockState.getFileContent(CHAPTER_PATH)).toBe(external);
    await expect(app.locator('[data-testid="tab-0001.novtrans"] .dirty-dot')).toHaveCount(0);
    await expect(app.getByTestId('plugin-file-conflict')).toHaveCount(0);
  });

  test('surfaces a racing stale edit and restores it only on request', async ({ app, mockState }) => {
    const { left, right } = await openChapterInBothPanes(app, mockState);
    await captureFileOpens(right);
    await left.getByTestId('book-translation-translation-segment-0001').fill('左');
    await left.getByTestId('book-translation-translation-segment-0001').fill('左侧');
    await expect.poll(async () => (await capturedFileOpens(right)).length).toBe(2);
    await expect.poll(async () => translations(await mockState.getFileContent(CHAPTER_PATH)))
      .toEqual(['左侧', '']);

    // The right pane edited a snapshot the left pane had already replaced.
    const [stale] = await capturedFileOpens(right);
    const racedEdit = withSecondTranslation(stale.content, '冲突的右侧译文');
    await expect(postEditAndAwaitSave(right, { ...stale, content: racedEdit })).resolves
      .toMatchObject({ ok: false, saved: false });

    const banner = app.getByTestId('plugin-file-conflict');
    await expect(banner).toHaveCount(1);
    expect(translations(await mockState.getFileContent(CHAPTER_PATH))).toEqual(['左侧', '']);
    await expect(right.getByTestId('book-translation-translation-segment-0002')).toHaveValue('');

    await app.getByTestId('plugin-file-conflict-restore').click();
    await expect(banner).toHaveCount(0);
    await expect.poll(async () => translations(await mockState.getFileContent(CHAPTER_PATH)))
      .toEqual(['左', '冲突的右侧译文']);
    await expect(left.getByTestId('book-translation-translation-segment-0002')).toHaveValue('冲突的右侧译文');
    await expect(right.getByTestId('book-translation-translation-segment-0002')).toHaveValue('冲突的右侧译文');
    await expect(app.locator('[data-testid="tab-0001.novtrans"] .dirty-dot')).toHaveCount(0);
  });
});
