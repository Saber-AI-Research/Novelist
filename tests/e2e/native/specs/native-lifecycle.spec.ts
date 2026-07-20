import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TauriPage } from '@srsholmes/tauri-playwright';
import { expect, nativeEnv, test, type NativeApp } from '../fixtures/native-app';
import { computeContainedScreenshotCrop, dirtyConflictStatePreserved } from '../native-run-support.mjs';
import { runNativeStage } from '../native-timeouts';

const execFileAsync = promisify(execFile);
const A_NAME = '甲 初稿.md';
const B_NAME = '乙 修订.md';
const C_NAME = '丙 定稿.md';
const A_PATH = path.join(nativeEnv.projectDir, A_NAME);
const B_PATH = path.join(nativeEnv.projectDir, B_NAME);
const C_PATH = path.join(nativeEnv.projectDir, C_NAME);
const CHANNEL = {
  id: 'ghost-native',
  name: 'Native Ghost',
  platform: 'ghost',
  admin_url: 'https://native.invalid',
  api_key: 'native-test-key',
};

interface EditorSnapshot {
  content: string;
  storeContent: string;
  dirty: boolean;
  composing: boolean;
  filePath: string;
}

interface ImageMetrics {
  width: number;
  height: number;
  stats: {
    sampled: number;
    nonWhite: number;
    nonTransparent: number;
    red: number;
  };
}

interface NativePasteInfo {
  action_accepted: boolean;
  action_target_available: boolean;
  app_active: boolean;
  first_responder_accepted: boolean;
  first_responder_is_webview: boolean;
  untargeted_action_target_available: boolean;
  untargeted_action_target_is_webview: boolean;
  used_explicit_first_responder_target: boolean;
  window_key: boolean;
  window_number: number;
  webview_attached: boolean;
  webview_window_matches: boolean;
}

type SidecarSubdir = 'drafts' | 'naming' | 'publish';

interface RenameInventory {
  drafts: string[];
  naming: string[];
  publish: string[];
  journals: string[];
  assets: string[];
}

interface ActiveSidecarNames {
  drafts: string[];
  naming: string[];
  publish: string[];
}

interface ConflictCopyInventory {
  exact: Record<SidecarSubdir, string[]>;
  normalized: Record<SidecarSubdir, string[]>;
  counts: Record<SidecarSubdir, number>;
}

function activeSidecars(fileName: string) {
  return {
    draft: path.join(nativeEnv.projectDir, '.novelist/drafts', `${fileName}.draft.md`),
    recovery: path.join(nativeEnv.projectDir, '.novelist/drafts', `${fileName}.~recovery.draft.md`),
    naming: path.join(nativeEnv.projectDir, '.novelist/naming', `${fileName}.json`),
    publish: path.join(nativeEnv.projectDir, '.novelist/publish', `${fileName}.json`),
  };
}

async function editorSnapshot(page: TauriPage): Promise<EditorSnapshot> {
  return page.evaluate<EditorSnapshot>(`(async () => {
    const module = await import('/app/lib/stores/tabs.svelte.ts');
    const tab = module.tabsStore.activeTab;
    if (!tab) throw new Error('no active tab');
    const content = module.getEditorContent(tab.id);
    if (typeof content !== 'string') throw new Error('editor content unavailable');
    return {
      content,
      storeContent: tab.content,
      dirty: tab.isDirty,
      composing: module.tabsStore.isTabImeComposing(tab.id),
      filePath: tab.filePath,
    };
  })()`);
}

async function waitForEditorContent(page: TauriPage, expected: string): Promise<void> {
  await expect.poll(async () => (await editorSnapshot(page)).content, { timeout: 20_000 }).toBe(expected);
}

async function externalAtomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.native-external-${Date.now()}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

async function clearNativeEvents(page: TauriPage): Promise<void> {
  await page.evaluate(`(() => { window.__NOVELIST_NATIVE_E2E_EVENTS__ = []; return true; })()`);
}

async function waitForNativeEvent(page: TauriPage, kind: string, filePath: string): Promise<void> {
  await page.waitForFunction(
    `Array.isArray(window.__NOVELIST_NATIVE_E2E_EVENTS__) && window.__NOVELIST_NATIVE_E2E_EVENTS__.some((event) => event.kind === ${JSON.stringify(kind)} && event.path === ${JSON.stringify(filePath)})`,
    20_000,
  );
}

async function nativeEvents(page: TauriPage): Promise<Array<{ kind: string; path: string }>> {
  return page.evaluate(`window.__NOVELIST_NATIVE_E2E_EVENTS__ || []`);
}

async function activeSidecarNames(nativeApp: NativeApp, filePath: string): Promise<ActiveSidecarNames> {
  const key = await nativeApp.command<string>('computeDocumentKey', [nativeEnv.projectDir, filePath]);
  const recoveryKey = await nativeApp.command<string>('computeDocumentKey', [
    nativeEnv.projectDir,
    `${filePath}.~recovery`,
  ]);
  return {
    drafts: [`${key}.draft.md`, `${recoveryKey}.draft.md`].sort(),
    naming: [`${key}.json`],
    publish: [`${key}.json`],
  };
}

async function renameInventory(): Promise<RenameInventory> {
  const novelistDir = path.join(nativeEnv.projectDir, '.novelist');
  const names = async (subdir: string): Promise<string[]> => {
    const dir = path.join(novelistDir, subdir);
    return existsSync(dir) ? (await readdir(dir)).sort() : [];
  };
  return {
    drafts: await names('drafts'),
    naming: await names('naming'),
    publish: await names('publish'),
    journals: await names('rename-migrations'),
    assets: await names('publish-assets'),
  };
}

function conflictCopyInventory(inventory: RenameInventory): ConflictCopyInventory {
  const patterns: Record<SidecarSubdir, RegExp> = {
    drafts: /\.conflict-[0-9a-f]{16}\.md$/,
    naming: /\.conflict-[0-9a-f]{16}\.json$/,
    publish: /\.conflict-[0-9a-f]{16}\.json$/,
  };
  const exact = Object.fromEntries(
    (Object.keys(patterns) as SidecarSubdir[]).map((subdir) => [
      subdir,
      inventory[subdir].filter((name) => patterns[subdir].test(name)),
    ]),
  ) as Record<SidecarSubdir, string[]>;
  const normalized = Object.fromEntries(
    (Object.keys(exact) as SidecarSubdir[]).map((subdir) => [
      subdir,
      exact[subdir].map((name) => name.normalize('NFC')).sort(),
    ]),
  ) as Record<SidecarSubdir, string[]>;
  return {
    exact,
    normalized,
    counts: {
      drafts: exact.drafts.length,
      naming: exact.naming.length,
      publish: exact.publish.length,
    },
  };
}

function temporarySidecarArtifacts(inventory: RenameInventory): string[] {
  return (Object.entries(inventory) as Array<[keyof RenameInventory, string[]]>).flatMap(([subdir, names]) =>
    names.filter((name) => name.endsWith('.novelist-tmp')).map((name) => `${subdir}/${name}`),
  );
}

function expectExactSidecarInventory(
  inventory: RenameInventory,
  active: ActiveSidecarNames,
  conflicts: ConflictCopyInventory,
  expectedAssets: string[],
): void {
  for (const subdir of ['drafts', 'naming', 'publish'] as const) {
    expect(inventory[subdir], `${subdir} exact inventory`).toEqual(
      [...active[subdir], ...conflicts.exact[subdir]].sort(),
    );
  }
  expect(inventory.assets, 'publish cover asset inventory').toEqual(expectedAssets);
  expect(inventory.journals, 'rename journal inventory').toEqual([]);
  expect(temporarySidecarArtifacts(inventory), 'sidecar temp inventory').toEqual([]);
}

async function openPublish(page: TauriPage): Promise<void> {
  await page.locator('.share-btn').click();
  await page.waitForSelector('.share-channel-name', 10_000);
  await page.locator('.share-channel-name').click();
  await page.waitForSelector('[data-testid="publish-cover-drop"]', 10_000);
}

async function closePublish(page: TauriPage): Promise<void> {
  await page.locator('.footer .ghost-btn').click();
  await page.waitForFunction(`document.querySelectorAll('[role="dialog"]').length === 0`, 10_000);
}

async function previewPixel(page: TauriPage): Promise<number[]> {
  await page.waitForFunction(
    `(() => {
    const image = document.querySelector('[data-testid="publish-cover-preview"]');
    return image instanceof HTMLImageElement && image.naturalWidth > 0 && image.naturalHeight > 0;
  })()`,
    20_000,
  );
  return page.evaluate<number[]>(`(() => {
    const image = document.querySelector('[data-testid="publish-cover-preview"]');
    if (!(image instanceof HTMLImageElement)) throw new Error('cover preview missing');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2d context unavailable');
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  })()`);
}

async function imageMetrics(args: string[]): Promise<ImageMetrics> {
  const { stdout } = await execFileAsync(nativeEnv.clipboardHelper, ['image-metrics', ...args]);
  return JSON.parse(stdout) as ImageMetrics;
}

async function assertActiveSidecars(fileName: string, expected: boolean): Promise<void> {
  for (const [kind, filePath] of Object.entries(activeSidecars(fileName))) {
    expect(existsSync(filePath), `${kind} active sidecar for ${fileName}`).toBe(expected);
  }
}

async function seedSidecars(nativeApp: NativeApp, filePath: string, label: 'A' | 'B'): Promise<void> {
  const key = await nativeApp.command<string>('computeDocumentKey', [nativeEnv.projectDir, filePath]);
  await nativeApp.command('writeDraftNote', [nativeEnv.projectDir, filePath, `draft-${label}-草稿`]);
  await nativeApp.command('writeDraftNote', [nativeEnv.projectDir, `${filePath}.~recovery`, `recovery-${label}-恢复`]);
  await nativeApp.command('writeManagedNameState', [
    nativeEnv.projectDir,
    filePath,
    {
      version: 1,
      status: 'managed',
      templateRaw: '第{N}章-{title}',
      currentH1: `${label} 标题`,
      documentKey: key,
    },
  ]);
  await nativeApp.command('writePublishFormDraft', [
    nativeEnv.projectDir,
    filePath,
    CHANNEL.id,
    {
      title: `${label} 发布标题`,
      tags: ['原生', '迁移'],
      excerpt: `${label} 摘要`,
      slug: `${label.toLowerCase()}-slug`,
      status: 'draft',
      destination: null,
    },
  ]);
  await nativeApp.command('persistPublishResult', [
    nativeEnv.projectDir,
    filePath,
    CHANNEL.id,
    {
      url: `https://native.invalid/${label.toLowerCase()}`,
      remote_id: `remote-${label}`,
      operation: 'created',
      provider_revision: {
        provider: 'ghost',
        updated_at: `2026-07-17T00:00:0${label === 'A' ? '2' : '1'}Z`,
      },
    },
  ]);
}

async function makeSourceNewer(sourceName: string, destinationName: string): Promise<void> {
  const source = activeSidecars(sourceName);
  const destination = activeSidecars(destinationName);
  for (const kind of Object.keys(source) as Array<keyof typeof source>) {
    const destinationStat = await stat(destination[kind]);
    const newer = new Date(destinationStat.mtimeMs + 5_000);
    await utimes(source[kind], newer, newer);
  }
}

async function renameThroughSidebar(page: TauriPage, from: string, to: string): Promise<void> {
  await page.getByTestId(`sidebar-file-${from}`).dblclick();
  await page.waitForSelector('[data-testid="sidebar-input"]', 10_000);
  await page.getByTestId('sidebar-input').fill(to);
  await page.getByTestId('sidebar-input').press('Enter');
  await page.waitForSelector(`[data-testid=${JSON.stringify(`sidebar-file-${to}`)}]`, 20_000);
}

test('real WKWebView native clipboard, watcher, conflict, and rename lifecycle', async ({ nativeApp }) => {
  const { page } = nativeApp;
  expect(process.platform).toBe('darwin');
  await runNativeStage(
    'project',
    60_000,
    async () => {
      try {
        await expect
          .poll(
            () =>
              page.evaluate<string | null>(`(async () => {
          const module = await import('/app/lib/stores/project.svelte.ts');
          return module.projectStore.dirPath;
        })()`),
            { timeout: 30_000 },
          )
          .toBe(nativeEnv.projectDir);
      } catch (error) {
        const snapshot = await page.evaluate(`(async () => {
        const module = await import('/app/lib/stores/project.svelte.ts');
        return {
          url: window.location.href,
          projectDir: module.projectStore.dirPath,
          events: window.__NOVELIST_NATIVE_E2E_EVENTS__ || [],
          body: document.body.innerText.slice(0, 2000),
        };
      })()`);
        const pending = await nativeApp.command<string[]>('getPendingOpenProjects');
        await nativeApp.log(
          `cold_open_snapshot=${JSON.stringify(snapshot)}`,
          `cold_open_pending_after_timeout=${JSON.stringify(pending)}`,
        );
        throw error;
      }
      const fileSelector = `[data-testid=${JSON.stringify(`sidebar-file-${A_NAME}`)}]`;
      await expect.poll(() => page.count(fileSelector), { timeout: 20_000 }).toBe(1);
      await page.waitForSelector(fileSelector, 20_000);
      await page.getByTestId(`sidebar-file-${A_NAME}`).click();
      await page.waitForSelector('.cm-editor', 20_000);
      await nativeApp.log(`initial_project_opened=${nativeEnv.projectDir}`);
    },
    nativeApp.log,
  );

  const { assetsDir, assets, assetBytes } = await runNativeStage(
    'clipboard',
    45_000,
    async () => {
      await nativeApp.command('setPublishSettings', [{ channels: [CHANNEL] }]);
      await openPublish(page);
      await execFileAsync(nativeEnv.clipboardHelper, ['write-png', nativeEnv.pngPath]);
      const clipboardImage = await nativeApp.command<{
        bytes: number[];
        mime: string;
        width: number;
        height: number;
      }>('readClipboardImage');
      expect(clipboardImage).toMatchObject({
        mime: 'image/png',
        width: 1,
        height: 1,
      });
      await page.getByTestId('publish-cover-drop').focus();
      expect(
        await page.evaluate<boolean>(`(() => {
      const tile = document.querySelector('[data-testid="publish-cover-drop"]');
      if (!(tile instanceof HTMLElement)) throw new Error('cover tile missing');
      window.__NOVELIST_NATIVE_PASTE_COUNT__ = 0;
      tile.addEventListener('paste', () => {
        window.__NOVELIST_NATIVE_PASTE_COUNT__ += 1;
      }, { capture: true });
      return document.activeElement === tile;
    })()`),
      ).toBe(true);
      let nativePaste: NativePasteInfo | undefined;
      let pasteEvidence: string;
      if (process.env.NOVELIST_NATIVE_MODE === 'nonvisual-behavior') {
        nativePaste = await page.evaluate<NativePasteInfo>(
          `window.__TAURI_INTERNALS__.invoke('perform_e2e_native_paste', {})`,
        );
        pasteEvidence = `native_paste_path=direct AppKit diagnostic action=${JSON.stringify(nativePaste)}`;
      } else {
        const nativeCommandV = await page.evaluate<Record<string, unknown>>(
          `window.__TAURI_INTERNALS__.invoke('perform_e2e_native_command_v', {})`,
        );
        pasteEvidence = `native_paste_path=AppKit NSEvent Command+V action=${JSON.stringify(nativeCommandV)}`;
      }
      if (nativePaste) {
        expect(nativePaste).toMatchObject({
          action_accepted: true,
          action_target_available: true,
          first_responder_accepted: true,
          first_responder_is_webview: true,
          webview_attached: true,
          webview_window_matches: true,
        });
      }
      if (nativePaste) expect(nativePaste.window_number).toBeGreaterThan(0);
      await expect
        .poll(() => page.evaluate<number>(`window.__NOVELIST_NATIVE_PASTE_COUNT__ || 0`), { timeout: 20_000 })
        .toBe(1);
      expect(await previewPixel(page)).toEqual([255, 0, 0, 255]);

      const publishPathA = activeSidecars(A_NAME).publish;
      await expect.poll(() => existsSync(publishPathA), { timeout: 20_000 }).toBe(true);
      const sidecar = JSON.parse(await readFile(publishPathA, 'utf8'));
      const cover = sidecar.channels[CHANNEL.id].cover;
      expect(cover.content_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(cover).toMatchObject({ extension: 'png', mime: 'image/png' });
      const assetsDir = path.join(nativeEnv.projectDir, '.novelist/publish-assets');
      const assets = (await readdir(assetsDir)).filter((name) => /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(name));
      expect(assets).toEqual([`${cover.content_hash}.png`]);
      const assetBytes = await readFile(path.join(assetsDir, assets[0]));
      expect([...assetBytes]).toEqual(clipboardImage.bytes);
      expect(cover.bytes).toBe(assetBytes.length);
      const restored = await nativeApp.command<{
        bytes: number[];
        filename: string;
      }>('loadPublishCover', [nativeEnv.projectDir, A_PATH, CHANNEL.id]);
      expect(restored.filename).toBe(assets[0]);
      expect(restored.bytes).toEqual([...assetBytes]);
      expect(existsSync(path.join(nativeEnv.projectDir, '.novelist/images'))).toBe(false);
      await closePublish(page);
      await openPublish(page);
      expect(await previewPixel(page)).toEqual([255, 0, 0, 255]);
      await closePublish(page);
      await nativeApp.log(
        'clipboard_png_flavors=public.png,public.tiff',
        `clipboard_rust_read=${clipboardImage.width}x${clipboardImage.height} bytes=${clipboardImage.bytes.length}`,
        pasteEvidence,
        'native_paste_event_count=1',
        'cover_pixels=[255,0,0,255]',
        `cover_hash=${cover.content_hash}`,
        `cover_asset=${path.join(assetsDir, assets[0])}`,
        `cover_asset_count=${assets.length}`,
        `cover_sidecar=${publishPathA}`,
        'cover_restored_after_close_reopen=true',
        'legacy_images_dir_exists=false',
      );
      return { assetsDir, assets, assetBytes };
    },
    nativeApp.log,
  );

  let lastWindowPreparation: Record<string, unknown> | null = null;
  try {
    await runNativeStage(
      'window_prepare',
      15_000,
      async () => {
        if (process.env.NOVELIST_NATIVE_MODE === 'nonvisual-behavior') {
          lastWindowPreparation = await page.evaluate<Record<string, unknown>>(`(async () => {
          const info = await window.__TAURI_INTERNALS__.invoke('capture_e2e_webview_snapshot', {
            path: ${JSON.stringify(nativeEnv.screenshotPath)},
            prepareOnly: true,
          });
          return { ...info, document_visibility: document.visibilityState };
        })()`);
          await nativeApp.log(`window_prepare_nonvisual=${JSON.stringify(lastWindowPreparation)}`);
          return;
        }
        await expect
          .poll(
            async () => {
              lastWindowPreparation = await page.evaluate<Record<string, unknown>>(`(async () => {
          const info = await window.__TAURI_INTERNALS__.invoke('capture_e2e_webview_snapshot', {
            path: ${JSON.stringify(nativeEnv.screenshotPath)},
            prepareOnly: true,
          });
          return { ...info, document_visibility: document.visibilityState };
        })()`);
              return lastWindowPreparation;
            },
            { timeout: 10_000 },
          )
          .toMatchObject({
            app_active: true,
            window_visible: true,
            window_miniaturized: false,
            window_on_active_space: true,
            window_key: true,
            window_main: true,
            window_occluded: false,
            webview_hidden: false,
            webview_attached: true,
            webview_window_matches: true,
            document_visibility: 'visible',
          });
      },
      nativeApp.log,
    );
  } catch (error) {
    await nativeApp.log(`window_prepare_failure=${JSON.stringify(lastWindowPreparation)}`);
    throw error;
  }

  await runNativeStage(
    'watcher',
    60_000,
    async () => {
      const initialContent = (await editorSnapshot(page)).content;
      const imeExternal = '# 甲 初稿\n外部合成期间写入。\n';
      await clearNativeEvents(page);
      await page.locator('.cm-content').focus();
      await page.evaluate(`(async () => {
      const tabs = await import('/app/lib/stores/tabs.svelte.ts');
      const ime = await import('/app/lib/editor/ime-guard.ts');
      const tab = tabs.tabsStore.activeTab;
      const view = tab && tabs.getEditorView(tab.id);
      if (!view) throw new Error('active editor view missing');
      ime.setNativeE2eComposition(view, true);
      return true;
    })()`);
      await expect
        .poll(async () => (await editorSnapshot(page)).composing, {
          timeout: 10_000,
        })
        .toBe(true);
      await externalAtomicWrite(A_PATH, imeExternal);
      await waitForNativeEvent(page, 'notify', A_PATH);
      await waitForNativeEvent(page, 'ime-deferred', A_PATH);
      expect((await editorSnapshot(page)).content).toBe(initialContent);
      await page.evaluate(`(async () => {
      const tabs = await import('/app/lib/stores/tabs.svelte.ts');
      const ime = await import('/app/lib/editor/ime-guard.ts');
      const tab = tabs.tabsStore.activeTab;
      const view = tab && tabs.getEditorView(tab.id);
      if (!view) throw new Error('active editor view missing');
      ime.setNativeE2eComposition(view, false);
      return true;
    })()`);
      try {
        await waitForEditorContent(page, imeExternal);
      } catch (error) {
        await nativeApp.log(
          `ime_failure_events=${JSON.stringify(await nativeEvents(page))}`,
          `ime_failure_editor=${JSON.stringify(await editorSnapshot(page))}`,
          `ime_failure_disk=${JSON.stringify(await nativeApp.command('readFile', [A_PATH]))}`,
        );
        throw error;
      }

      await nativeApp.command('stopFileWatcher');
      await nativeApp.command('registerOpenFile', [A_PATH]);
      await clearNativeEvents(page);
      const polledExternal = '# 甲 初稿\n轮询回退最新内容。\n';
      await externalAtomicWrite(A_PATH, polledExternal);
      await waitForNativeEvent(page, 'poll', A_PATH);
      await waitForEditorContent(page, polledExternal);
      await nativeApp.command('startFileWatcher', [nativeEnv.projectDir]);

      await clearNativeEvents(page);
      await page.locator('.cm-content').focus();
      await page.keyboard.insertText('\n本地未保存内容');
      await expect
        .poll(
          async () => {
            const snapshot = await editorSnapshot(page);
            return snapshot.dirty && snapshot.content.includes('本地未保存内容');
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      const dirtySnapshot = await editorSnapshot(page);
      const expectedDirtyConflictState = {
        editorContent: dirtySnapshot.content,
        storeContent: polledExternal,
        filePath: A_PATH,
      };
      expect(dirtySnapshot).toMatchObject({
        storeContent: polledExternal,
        dirty: true,
        composing: false,
        filePath: A_PATH,
      });
      expect(dirtySnapshot.content).toContain('本地未保存内容');
      expect(dirtySnapshot.content).not.toBe(polledExternal);
      await nativeApp.log(`dirty_snapshot_before_conflict=${JSON.stringify(dirtySnapshot)}`);
      const dirtyExternal = '# 甲 初稿\n外部冲突内容。\n';
      await externalAtomicWrite(A_PATH, dirtyExternal);
      await page.waitForSelector('[role="dialog"]', 20_000);
      await waitForNativeEvent(page, 'conflict', A_PATH);
      const unresolvedSnapshot = await editorSnapshot(page);
      expect(dirtyConflictStatePreserved(dirtySnapshot, unresolvedSnapshot, expectedDirtyConflictState)).toBe(true);
      const unresolvedEvents = await nativeEvents(page);
      expect(unresolvedEvents.filter((event) => event.kind === 'conflict')).toEqual([
        { kind: 'conflict', path: A_PATH },
      ]);
      await page.evaluate(`(() => {
      const buttons = document.querySelectorAll('[role="dialog"] button');
      if (buttons.length !== 2) throw new Error('conflict actions missing');
      buttons[1].click();
      return true;
    })()`);
      await expect
        .poll(() => editorSnapshot(page), { timeout: 20_000 })
        .toMatchObject({
          content: dirtyExternal,
          storeContent: dirtyExternal,
          dirty: false,
          composing: false,
          filePath: A_PATH,
        });
      const resolvedSnapshot = await editorSnapshot(page);
      expect(resolvedSnapshot.content).toBe(resolvedSnapshot.storeContent);
      expect((await nativeEvents(page)).filter((event) => event.kind === 'conflict')).toEqual([
        { kind: 'conflict', path: A_PATH },
      ]);
      await nativeApp.log(
        'watcher_notify_ime_deferred=true',
        `watcher_ime_content_preserved=${JSON.stringify(initialContent)}`,
        `watcher_ime_converged=${JSON.stringify(imeExternal)}`,
        `poll_fallback_converged=${JSON.stringify(polledExternal)}`,
        `dirty_content_preserved=${JSON.stringify(dirtySnapshot.content)}`,
        `dirty_store_content_preserved=${JSON.stringify(dirtySnapshot.storeContent)}`,
        `dirty_unresolved_snapshot=${JSON.stringify(unresolvedSnapshot)}`,
        'dirty_store_pre_edit_snapshot_preserved=true',
        'dirty_state_preserved_until_resolution=true',
        'dirty_conflict_visible=true',
        'dirty_conflict_event_count=1',
        `dirty_conflict_resolved_to=${JSON.stringify(dirtyExternal)}`,
        'dirty_conflict_resolution_converged=true dirty=false',
        `watcher_events=${JSON.stringify(await nativeEvents(page))}`,
      );
    },
    nativeApp.log,
  );

  await runNativeStage(
    'rename',
    60_000,
    async () => {
      await writeFile(B_PATH, '# 乙 修订\n临时冲突元数据所有者。\n', 'utf8');
      await seedSidecars(nativeApp, B_PATH, 'B');
      await rm(B_PATH);
      await expect
        .poll(() => page.count(`[data-testid=${JSON.stringify(`sidebar-file-${B_NAME}`)}]`), {
          timeout: 20_000,
        })
        .toBe(0);
      await seedSidecars(nativeApp, A_PATH, 'A');
      await makeSourceNewer(A_NAME, B_NAME);
      await renameThroughSidebar(page, A_NAME, B_NAME);
      expect(existsSync(A_PATH)).toBe(false);
      expect(existsSync(B_PATH)).toBe(true);
      await assertActiveSidecars(A_NAME, false);
      await assertActiveSidecars(B_NAME, true);
      const activeA = await activeSidecarNames(nativeApp, A_PATH);
      const activeB = await activeSidecarNames(nativeApp, B_PATH);
      const activeC = await activeSidecarNames(nativeApp, C_PATH);
      const aToBInventory = await renameInventory();
      const aToBConflicts = conflictCopyInventory(aToBInventory);
      expect(aToBConflicts.counts).toEqual({
        drafts: 2,
        naming: 1,
        publish: 1,
      });
      expectExactSidecarInventory(aToBInventory, activeB, aToBConflicts, assets);
      for (const subdir of ['drafts', 'naming', 'publish'] as const) {
        expect(aToBInventory[subdir]).not.toEqual(expect.arrayContaining(activeA[subdir]));
      }

      await writeFile(activeSidecars(B_NAME).naming, '{malformed native retry fixture', 'utf8');
      await renameThroughSidebar(page, B_NAME, C_NAME);
      expect(existsSync(B_PATH)).toBe(false);
      expect(existsSync(C_PATH)).toBe(true);
      expect(existsSync(activeSidecars(B_NAME).naming)).toBe(true);
      expect(existsSync(activeSidecars(C_NAME).naming)).toBe(false);
      const beforeRetryInventory = await renameInventory();
      const beforeRetryConflicts = conflictCopyInventory(beforeRetryInventory);
      expect(beforeRetryConflicts.exact).toEqual(aToBConflicts.exact);
      expect(beforeRetryConflicts.normalized).toEqual(aToBConflicts.normalized);
      expect(beforeRetryConflicts.counts).toEqual(aToBConflicts.counts);
      expect(beforeRetryInventory.journals).toHaveLength(1);
      expect(beforeRetryInventory.journals[0]).toMatch(/^[0-9a-f]{32}\.json$/);
      expect(temporarySidecarArtifacts(beforeRetryInventory)).toEqual([]);
      expect(beforeRetryInventory.assets).toEqual(assets);
      const bKey = await nativeApp.command<string>('computeDocumentKey', [nativeEnv.projectDir, B_PATH]);
      await nativeApp.command('writeManagedNameState', [
        nativeEnv.projectDir,
        B_PATH,
        {
          version: 1,
          status: 'managed',
          templateRaw: '第{N}章-{title}',
          currentH1: 'A 标题',
          documentKey: bKey,
        },
      ]);
      const retry = await nativeApp.command<{
        new_path: string;
        migration: {
          status: string;
          migrated: number;
          conflicts: number;
          errors: string[];
        };
      }>('renameItem', [nativeEnv.projectDir, B_PATH, C_NAME, false]);
      expect(retry.new_path).toBe(C_PATH);
      expect(retry.migration).toEqual({
        status: 'idempotent_retry',
        migrated: 1,
        conflicts: 0,
        errors: [],
      });
      await assertActiveSidecars(A_NAME, false);
      await assertActiveSidecars(B_NAME, false);
      await assertActiveSidecars(C_NAME, true);

      expect(await nativeApp.command('readDraftNote', [nativeEnv.projectDir, C_PATH])).toBe('draft-A-草稿');
      expect(await nativeApp.command('readDraftNote', [nativeEnv.projectDir, `${C_PATH}.~recovery`])).toBe(
        'recovery-A-恢复',
      );
      const managed = await nativeApp.command<{
        documentKey: string;
        currentH1: string;
      }>('readManagedNameState', [nativeEnv.projectDir, C_PATH]);
      expect(managed).toMatchObject({
        documentKey: C_NAME,
        currentH1: 'A 标题',
      });
      const forms = await nativeApp.command<{
        forms: Record<string, { title: string }>;
      }>('readPublishFormDrafts', [nativeEnv.projectDir, C_PATH]);
      expect(forms.forms[CHANNEL.id].title).toBe('A 发布标题');
      const remote = await nativeApp.command<{ post_id: string }>('readPublishRemoteState', [
        nativeEnv.projectDir,
        C_PATH,
        CHANNEL.id,
      ]);
      expect(remote.post_id).toBe('remote-A');
      const finalCover = await nativeApp.command<{
        filename: string;
        bytes: number[];
      }>('loadPublishCover', [nativeEnv.projectDir, C_PATH, CHANNEL.id]);
      expect(finalCover.filename).toBe(assets[0]);
      expect(finalCover.bytes).toEqual([...assetBytes]);
      const finalInventory = await renameInventory();
      const finalConflicts = conflictCopyInventory(finalInventory);
      expect(finalConflicts.exact).toEqual(beforeRetryConflicts.exact);
      expect(finalConflicts.normalized).toEqual(beforeRetryConflicts.normalized);
      expect(finalConflicts.counts).toEqual(beforeRetryConflicts.counts);
      expectExactSidecarInventory(finalInventory, activeC, finalConflicts, assets);
      for (const stale of [activeA, activeB]) {
        for (const subdir of ['drafts', 'naming', 'publish'] as const) {
          expect(finalInventory[subdir]).not.toEqual(expect.arrayContaining(stale[subdir]));
        }
      }
      await nativeApp.log(
        `rename_a_to_b_conflicts=${JSON.stringify(aToBConflicts.counts)}`,
        'rename_b_to_c_initial_metadata_error=naming malformed source retained',
        `rename_retry_status=${retry.migration.status} migrated=${retry.migration.migrated} conflicts=${retry.migration.conflicts}`,
        'active_a_sidecars=false',
        'active_b_sidecars=false',
        `active_c_sidecars=true key=${C_NAME}`,
        'c_draft_restored=draft-A-草稿',
        'c_recovery_restored=recovery-A-恢复',
        `c_naming_restored=${managed.documentKey}`,
        `c_publish_form_restored=${forms.forms[CHANNEL.id].title}`,
        `c_publish_remote_restored=${remote.post_id}`,
        `c_publish_cover_restored=${finalCover.filename}`,
        `rename_conflict_exact_stable=${JSON.stringify(finalConflicts.exact)}`,
        `rename_conflict_normalized_stable=${JSON.stringify(finalConflicts.normalized)}`,
        `rename_final_inventory=${JSON.stringify(finalInventory)}`,
        `publish_asset_count_after_rename=${finalInventory.assets.length}`,
        `rename_journal_residue=${JSON.stringify(finalInventory.journals)}`,
      );
    },
    nativeApp.log,
  );

  if (nativeEnv.artifactRequirement === 'not_required') {
    await nativeApp.log('artifact=not_required');
    return;
  }

  await openPublish(page);
  expect(await previewPixel(page)).toEqual([255, 0, 0, 255]);
  const capture = await page.evaluate<{
    cover: { x: number; y: number; width: number; height: number };
    innerHeight: number;
    innerWidth: number;
  }>(`(() => {
      const cover = document.querySelector('[data-testid="publish-cover-preview"]');
      if (!(cover instanceof HTMLImageElement)) throw new Error('cover preview missing');
      if (!cover.complete || cover.naturalWidth <= 0 || cover.naturalHeight <= 0) {
        throw new Error('cover preview is not loaded');
      }
      cover.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = cover.getBoundingClientRect();
      const naturalAspect = cover.naturalWidth / cover.naturalHeight;
      const boxAspect = rect.width / rect.height;
      const painted = naturalAspect >= boxAspect
        ? {
            x: rect.x,
            y: rect.y + (rect.height - rect.width / naturalAspect) / 2,
            width: rect.width,
            height: rect.width / naturalAspect,
          }
        : {
            x: rect.x + (rect.width - rect.height * naturalAspect) / 2,
            y: rect.y,
            width: rect.height * naturalAspect,
            height: rect.height,
          };
      return {
        cover: painted,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
      };
    })()`);
  const nativeCapture = await runNativeStage(
    'snapshot',
    15_000,
    () =>
      page.evaluate(`(async () => {
    const visibilityBefore = document.visibilityState;
    const preparation = await window.__TAURI_INTERNALS__.invoke('capture_e2e_webview_snapshot', {
      path: ${JSON.stringify(nativeEnv.screenshotPath)},
      prepareOnly: true,
    });
    if (document.visibilityState !== 'visible') {
      throw new Error('snapshot visibility unavailable: document.visibilityState=' + document.visibilityState);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    const result = await window.__TAURI_INTERNALS__.invoke('capture_e2e_webview_snapshot', {
      path: ${JSON.stringify(nativeEnv.screenshotPath)},
      prepareOnly: false,
    });
    return { visibilityBefore, visibilityAfter: document.visibilityState, preparation, result };
  })()`),
    nativeApp.log,
  );
  const screenshot = await readFile(nativeEnv.screenshotPath);
  expect([...screenshot.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const wholeMetrics = await imageMetrics([nativeEnv.screenshotPath]);
  const geometry = computeContainedScreenshotCrop(wholeMetrics, capture, capture.cover);
  const coverMetrics = await imageMetrics([
    nativeEnv.screenshotPath,
    String(geometry.crop.x),
    String(geometry.crop.y),
    String(geometry.crop.width),
    String(geometry.crop.height),
  ]);
  await nativeApp.log(
    `screenshot_metrics=${JSON.stringify(wholeMetrics)}`,
    `screenshot_cover_metrics=${JSON.stringify(coverMetrics)}`,
    `screenshot_cover_geometry=${JSON.stringify(geometry)}`,
    `native_pdf_capture=${JSON.stringify(nativeCapture)}`,
    `clipboard_evidence=${nativeEnv.screenshotPath}`,
  );
  expect(wholeMetrics.stats.nonWhite / wholeMetrics.stats.sampled).toBeGreaterThan(0.02);
  expect(coverMetrics.stats.nonTransparent).toBe(coverMetrics.stats.sampled);
  expect(coverMetrics.stats.red / coverMetrics.stats.sampled).toBeGreaterThan(0.5);
  await closePublish(page);
});
