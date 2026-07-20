import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TauriPage } from '@srsholmes/tauri-playwright';
import { expect, nativeEnv, test } from '../fixtures/native-app';

const FILE_NAME = '甲 初稿.md';
const FILE_PATH = path.join(nativeEnv.projectDir, FILE_NAME);

async function externalAtomicWrite(content: string): Promise<void> {
  const tempPath = `${FILE_PATH}.rapid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, FILE_PATH);
}

async function editorContent(page: TauriPage): Promise<string> {
  return page.evaluate<string>(`(async () => {
    const module = await import('/app/lib/stores/tabs.svelte.ts');
    const tab = module.tabsStore.activeTab;
    if (!tab) throw new Error('no active tab');
    const content = module.getEditorContent(tab.id);
    if (typeof content !== 'string') throw new Error('editor content unavailable');
    return content;
  })()`);
}

test('rapid external v1 v2 v3 writes converge once in real WKWebView', async ({ nativeApp }) => {
  const { page } = nativeApp;
  await expect.poll(
    () => page.evaluate<string | null>(`(async () => {
      const module = await import('/app/lib/stores/project.svelte.ts');
      return module.projectStore.dirPath;
    })()`),
    { timeout: 30_000 },
  ).toBe(nativeEnv.projectDir);

  const fileSelector = `[data-testid=${JSON.stringify(`sidebar-file-${FILE_NAME}`)}]`;
  await expect.poll(() => page.count(fileSelector), { timeout: 20_000 }).toBe(1);
  await page.getByTestId(`sidebar-file-${FILE_NAME}`).click();
  await page.waitForSelector('.cm-editor', 20_000);
  await page.evaluate(`(() => { window.__NOVELIST_NATIVE_E2E_EVENTS__ = []; return true; })()`);

  const v1 = '# 甲 初稿\n快速版本 v1。\n';
  const v2 = '# 甲 初稿\n快速版本 v2。\n';
  const v3 = '# 甲 初稿\n快速版本 v3。\n';
  await externalAtomicWrite(v1);
  await new Promise(resolve => setTimeout(resolve, 25));
  await externalAtomicWrite(v2);
  await new Promise(resolve => setTimeout(resolve, 25));
  await externalAtomicWrite(v3);

  await expect.poll(() => editorContent(page), { timeout: 20_000 }).toBe(v3);
  await new Promise(resolve => setTimeout(resolve, 1_250));
  const events = await page.evaluate<Array<{ kind: string; path: string }>>(
    `window.__NOVELIST_NATIVE_E2E_EVENTS__ || []`,
  );
  expect(events.filter(event => event.kind === 'reload' && event.path === FILE_PATH)).toHaveLength(1);
  expect(events.filter(event => event.kind === 'conflict' && event.path === FILE_PATH)).toHaveLength(0);
  expect(await editorContent(page)).toBe(v3);
  await nativeApp.log(
    'rapid_reload_versions=v1,v2,v3',
    'rapid_reload_effective_count=1',
    'rapid_reload_conflicts=0',
    `rapid_reload_final=${JSON.stringify(v3)}`,
  );
});
