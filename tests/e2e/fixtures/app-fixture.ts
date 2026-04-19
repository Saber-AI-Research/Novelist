import { test as base, expect, type Page } from '@playwright/test';
import { buildTauriMockScript } from './tauri-mock';
import {
  MOCK_FILES,
  MOCK_FILE_CONTENTS,
  MOCK_RECENT_PROJECTS,
  MOCK_PROJECT_DIR,
  MOCK_PROJECT_CONFIG,
  type MockFileEntry,
} from './mock-data';

/**
 * Dispatch a synthetic keyboard event directly to the DOM,
 * bypassing browser shortcut interception.
 * Use this for shortcuts that browsers intercept (Meta+B, Meta+S, F11, etc.)
 */
async function dispatchKey(page: Page, key: string, opts: {
  metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
} = {}) {
  await page.evaluate(({ key, opts }) => {
    // Map key to proper KeyboardEvent.code
    const codeMap: Record<string, string> = {
      'F11': 'F11', 'F1': 'F1', 'F2': 'F2', 'F3': 'F3',
      'Escape': 'Escape', 'Enter': 'Enter', 'Tab': 'Tab',
      '\\': 'Backslash', '/': 'Slash', ',': 'Comma', '.': 'Period',
      '[': 'BracketLeft', ']': 'BracketRight',
    };
    const code = codeMap[key] ?? `Key${key.toUpperCase()}`;

    const event = new KeyboardEvent('keydown', {
      key,
      code,
      keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      metaKey: opts.metaKey ?? false,
      ctrlKey: opts.ctrlKey ?? false,
      shiftKey: opts.shiftKey ?? false,
      altKey: opts.altKey ?? false,
      bubbles: true,
      cancelable: true,
    });
    // App uses <svelte:window onkeydown=...> so dispatch on window
    window.dispatchEvent(event);
  }, { key, opts });
}

export const test = base.extend<{
  app: Page;
  /** Dispatch keyboard shortcut directly to DOM (bypasses browser interception) */
  appKeys: {
    press: (key: string, opts?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => Promise<void>;
  };
  mockState: {
    getWrittenFiles: () => Promise<Record<string, string>>;
    getCreatedFiles: () => Promise<string[]>;
    getDeletedFiles: () => Promise<string[]>;
    getFiles: () => Promise<MockFileEntry[]>;
    emitEvent: (event: string, payload: unknown) => Promise<void>;
    openProject: (dirPath: string, files: MockFileEntry[]) => Promise<void>;
    renameFile: (oldPath: string, newPath: string) => Promise<void>;
    reset: () => Promise<void>;
  };
}>({
  app: async ({ page }, use) => {
    await page.addInitScript({
      content: buildTauriMockScript({
        files: MOCK_FILES,
        fileContents: MOCK_FILE_CONTENTS,
        recentProjects: MOCK_RECENT_PROJECTS,
        projectDir: MOCK_PROJECT_DIR,
        projectConfig: MOCK_PROJECT_CONFIG,
      }),
    });

    await page.goto('/');
    await page.waitForSelector('#app > *', { timeout: 10000 });

    await use(page);
  },

  appKeys: async ({ app }, use) => {
    await use({
      press: (key, opts) => dispatchKey(app, key, opts ?? {}),
    });
  },

  mockState: async ({ app }, use) => {
    const helpers = {
      async getWrittenFiles() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.writtenFiles);
      },
      async getCreatedFiles() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.createdFiles);
      },
      async getDeletedFiles() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.deletedFiles);
      },
      async getFiles() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.files);
      },
      async emitEvent(event: string, payload: unknown) {
        await app.evaluate(
          ([e, p]) => (window as any).__TAURI_MOCK_STATE__.emitEvent(e, p),
          [event, payload] as const,
        );
      },
      async openProject(dirPath: string, files: MockFileEntry[]) {
        await app.evaluate(
          ([d, f]) => (window as any).__TAURI_MOCK_STATE__.openProject(d, f),
          [dirPath, files] as const,
        );
      },
      async renameFile(oldPath: string, newPath: string) {
        await app.evaluate(
          ([o, n]) => (window as any).__TAURI_MOCK_STATE__.renameFile(o, n),
          [oldPath, newPath] as const,
        );
      },
      async reset() {
        await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.reset());
      },
    };
    await use(helpers);
  },
});

export { expect };
