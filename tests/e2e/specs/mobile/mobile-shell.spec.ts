import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../../fixtures/mock-data';

// Playwright's Node runner provides Buffer; the app tsconfig deliberately has
// no Node types (same scoped declaration as publish-cover.spec.ts).
declare const Buffer: {
  from(bytes: Uint8Array): unknown;
};

/**
 * Valid STORED project archive (346 bytes, fixed timestamps) with
 * `.novelist/project.toml` (`name = "旧稿"`) and a CJK chapter
 * `第一章.md` = "# 第一章\n\n雨夜里，旧稿重新开始。\n". Generated once with
 * Python's zipfile; the native importer itself is covered by Rust tests.
 */
const PROJECT_ZIP_BASE64 =
  'UEsDBBQAAAAAAABgXF1i5VtTOQAAADkAAAAWAAAALm5vdmVsaXN0L3Byb2plY3QudG9tbFtwcm9qZWN0XQpuYW1lID0gIuaXp+eovyIKdHlwZSA9ICJub3ZlbCIKdmVyc2lvbiA9ICIxLjAiClBLAwQUAAAIAAAAYFxd0uzuri8AAAAvAAAADAAAAOesrOS4gOeroC5tZCMg56ys5LiA56ugCgrpm6jlpJzph4zvvIzml6fnqL/ph43mlrDlvIDlp4vjgIIKUEsBAhQDFAAAAAAAAGBcXWLlW1M5AAAAOQAAABYAAAAAAAAAAAAAAIABAAAAAC5ub3ZlbGlzdC9wcm9qZWN0LnRvbWxQSwECFAMUAAAIAAAAYFxd0uzuri8AAAAvAAAADAAAAAAAAAAAAAAAgAFtAAAA56ys5LiA56ugLm1kUEsFBgAAAAACAAIAfgAAAMYAAAAAAA==';

/**
 * Mobile touch shell (runs in the iphone / ipad / ipad-landscape /
 * android-phone Playwright projects with `mockPlatform` ios/android).
 * Browser mocks prove the frontend state machine and IPC requests only;
 * on-screen keyboards, IME/dictation, native share sheets and OS
 * backgrounding still need the real-device checklist.
 */

const CHAPTER_1 = `${MOCK_PROJECT_DIR}/Chapter 1.md`;

/** Test seams installed by App.svelte and the Tauri mock. */
type ShellTestWindow = Window & {
  __test_api__: {
    getActiveEditor(): { filePath: string; view: { state: { doc: { toString(): string } } } } | null;
    setActiveEditorDocument(content: string, selection: { anchor: number; head: number }): Promise<void>;
  };
  __TAURI_MOCK_STATE__: { sharedFiles: Array<{ path: string; mimeType: string }> };
};

/** Viewports below 1024px wide use the sidebar drawer and overlay panels. */
function isCompact(app: Page): boolean {
  return (app.viewportSize()?.width ?? 0) < 1024;
}

function activeFilePath(app: Page): Promise<string | null> {
  return app.evaluate(() => (window as unknown as ShellTestWindow).__test_api__.getActiveEditor()?.filePath ?? null);
}

function activeDocument(app: Page): Promise<string | null> {
  return app.evaluate(() => (window as unknown as ShellTestWindow).__test_api__.getActiveEditor()?.view.state.doc.toString() ?? null);
}

function setActiveDocument(app: Page, content: string, anchor: number, head: number): Promise<void> {
  return app.evaluate(
    ({ content, anchor, head }) => (window as unknown as ShellTestWindow).__test_api__
      .setActiveEditorDocument(content, { anchor, head }),
    { content, anchor, head },
  );
}

async function openLibraryProject(app: Page) {
  await app.getByTestId('library-project-0').tap();
  await expect(app.getByTestId('app-layout')).toBeVisible();
  await expect(app.getByTestId('mobile-toolbar')).toBeVisible();
}

async function openChapter(app: Page, fileName = 'Chapter 1.md', projectDir = MOCK_PROJECT_DIR) {
  // With no restored file the drawer opens by itself on compact layouts;
  // wide iPads dock the sidebar.
  await app.getByTestId(`sidebar-file-${fileName}`).tap();
  await expect.poll(() => activeFilePath(app)).toBe(`${projectDir}/${fileName}`);
}

async function blurEditor(app: Page) {
  await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function setVisibility(app: Page, state: 'hidden' | 'visible') {
  await app.evaluate((next) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => next });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('mobile shell', () => {
  test('boots with native mobile capabilities and a library-first welcome', async ({ app, mockPlatform }) => {
    await expect(app.locator('html')).toHaveAttribute('data-mobile', 'true');
    await expect(app.locator('html')).toHaveAttribute('data-os', mockPlatform);
    await expect(app.getByTestId('platform-init-error')).toHaveCount(0);
    await expect(app.getByTestId('welcome-library-list')).toBeVisible();
    await expect(app.getByTestId('library-project-0')).toContainText('Test Novel');
    // Desktop-only entry points (arbitrary folders, desktop file paths,
    // scratch files that need a Save As dialog) are absent.
    await expect(app.getByTestId('welcome-open-folder')).toHaveCount(0);
    await expect(app.getByTestId('welcome-open-file')).toHaveCount(0);
    await expect(app.getByTestId('welcome-new-file')).toHaveCount(0);
    await expect(app.getByTestId('welcome-import-project')).toBeVisible();
  });

  test('opens a chapter from the drawer and formats it without losing the caret', async ({ app }) => {
    await openLibraryProject(app);
    await openChapter(app);
    if (isCompact(app)) await expect(app.getByTestId('sidebar-drawer-scrim')).toHaveCount(0);

    await setActiveDocument(app, '你好 world', 0, 2);
    await expect(app.getByTestId('format-toolbar')).toBeVisible();

    await app.getByTestId('format-editor-bold').tap();
    await expect.poll(() => activeDocument(app)).toBe('**你好** world');
    expect(await app.evaluate(() => !!document.activeElement?.closest('.cm-editor'))).toBe(true);

    await app.getByTestId('format-editor-cjk-quotes').tap();
    await expect.poll(() => activeDocument(app)).toContain('「');

    await app.getByTestId('format-editor-undo').tap();
    await app.getByTestId('format-editor-undo').tap();
    await expect.poll(() => activeDocument(app)).toBe('你好 world');
  });

  test('AI Talk opens as a sheet (or docked panel on wide iPads) with an accessible close', async ({ app }) => {
    await openLibraryProject(app);
    await openChapter(app);
    await blurEditor(app);

    await app.getByTestId('panel-toggle-ai-talk').tap();
    await expect(app.getByTestId('ai-talk-panel')).toBeVisible();
    if (isCompact(app)) {
      const sheet = app.getByTestId('panel-sheet');
      await expect(sheet).toBeVisible();
      await sheet.getByTestId('panel-sheet-close').tap();
      await expect(sheet).toHaveCount(0);
    } else {
      await expect(app.getByTestId('panel-sheet')).toHaveCount(0);
      await app.getByTestId('panel-toggle-ai-talk').tap();
    }
    await expect(app.getByTestId('ai-talk-panel')).toHaveCount(0);
  });

  test('a panel chip tapped with the file drawer open dismisses the drawer', async ({ app }) => {
    test.skip(!isCompact(app), 'wide iPads dock the sidebar; there is no drawer');
    await openLibraryProject(app);
    await openChapter(app);
    await blurEditor(app);

    await app.getByTestId('mobile-files-button').tap();
    await expect(app.getByTestId('sidebar-drawer-scrim')).toBeVisible();
    await app.getByTestId('toggle-snapshot').tap();
    await expect(app.getByTestId('sidebar-drawer-scrim')).toHaveCount(0);
    await expect(app.getByTestId('panel-sheet')).toBeVisible();
  });

  test('a bundled template inserted from the panel lands in the open chapter without the caret anchor', async ({ app }) => {
    await openLibraryProject(app);
    await openChapter(app);
    await setActiveDocument(app, '# 第一章\n\n', 7, 7);
    await blurEditor(app);

    await app.getByTestId('toggle-template').tap();
    await expect(app.getByTestId('template-panel')).toBeVisible();
    await app.getByTestId('template-row-bundled-chapter-skeleton').tap();

    await expect.poll(() => activeFilePath(app)).toBe(CHAPTER_1);
    await expect.poll(() => activeDocument(app)).toMatch(/^# 第一章\n\n[\s\S]*场景[\s\S]*冲突[\s\S]*转折/);
    expect(await activeDocument(app)).not.toContain('$|$');
  });

  test('the command palette hides desktop-only commands', async ({ app }) => {
    await openLibraryProject(app);
    await blurEditor(app);
    await app.getByTestId('mobile-palette').tap();
    const input = app.getByTestId('palette-input');
    await expect(input).toBeVisible();

    for (const desktopOnly of ['New Window', 'Toggle Split View', 'Open Directory', 'Check for Updates']) {
      await input.fill(desktopOnly);
      await expect(app.locator('[data-testid^="palette-result-"]')).toHaveCount(0);
    }
    await input.fill('Import File into Project');
    await expect(app.getByTestId('palette-result-0')).toBeVisible();
  });

  test('backgrounding the app flushes the edited chapter', async ({ app, mockState }) => {
    await openLibraryProject(app);
    await openChapter(app);
    await setActiveDocument(app, '# 第一章\n\n离线写下的段落。\n', 0, 0);
    await app.locator('.cm-content').press('End');
    await app.keyboard.type('续写');

    await setVisibility(app, 'hidden');
    await expect.poll(async () => (await mockState.getWrittenFiles())[CHAPTER_1] ?? '').toContain('续写');
    await setVisibility(app, 'visible');
  });

  test('exports the project as a zip through the native share sheet', async ({ app }) => {
    await openLibraryProject(app);
    await blurEditor(app);
    await app.getByTestId('mobile-palette').tap();
    await app.getByTestId('palette-input').fill('Export Project');
    await app.getByTestId('palette-result-0').tap();

    await app.getByTestId('export-share-project-zip').tap();
    await expect.poll(() => app.evaluate(() => (window as unknown as ShellTestWindow).__TAURI_MOCK_STATE__.sharedFiles))
      .toEqual([{ path: '/mock/cache/exports/novelist-test-project-20261028-120000.zip', mimeType: 'application/zip' }]);
  });

  test('imports a project archive from the welcome screen and opens its chapter', async ({ app }) => {
    const chooser = app.waitForEvent('filechooser');
    await app.getByTestId('welcome-import-project').tap();
    await (await chooser).setFiles({
      name: 'Old Draft.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from(Uint8Array.from(atob(PROJECT_ZIP_BASE64), (ch) => ch.charCodeAt(0))) as never,
    });

    // The imported project opens with its chapter in the file tree; the
    // drawer is already open on compact layouts because no file was restored.
    // The library folder name is chosen by the importer, so the root is read
    // from the opened chapter rather than pinned.
    await expect(app.getByTestId('app-layout')).toBeVisible();
    await app.getByTestId('sidebar-file-第一章.md').tap();
    await expect.poll(() => activeFilePath(app)).toMatch(/\/第一章\.md$/);
    const chapterPath = (await activeFilePath(app))!;
    const importedRoot = chapterPath.slice(0, -'/第一章.md'.length);
    expect(importedRoot).not.toBe(MOCK_PROJECT_DIR);
    await expect.poll(() => activeDocument(app)).toBe('# 第一章\n\n雨夜里，旧稿重新开始。\n');

    // It is now a library project, displayed under its project.toml name
    // (not the archive or folder name).
    await blurEditor(app);
    if (isCompact(app)) await app.getByTestId('mobile-files-button').tap();
    await app.getByTestId('sidebar-switch-btn').tap();
    const imported = app.getByTestId('project-switcher-library-0');
    await expect(imported).toContainText('旧稿');
    await expect(imported).not.toContainText('Old Draft');
    // …and it is the project currently open (switcher check mark).
    await expect(imported).toContainText('✓');
  });
});
