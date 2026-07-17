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
import type { ChannelConfig, FormDraft } from '../../../app/lib/ipc/commands';

export interface MockInvokeCall {
  command: string;
  args: Record<string, unknown>;
}

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
  browserErrors: string[];
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
    getRecentProjects: () => Promise<Array<{ path: string; name: string; pinned?: boolean }>>;
    seedRecentProjects: (list: Array<{ path: string; name: string; last_opened: string; pinned?: boolean; sort_order?: number | null }>) => Promise<void>;
    emitEvent: (event: string, payload: unknown) => Promise<void>;
    openProject: (dirPath: string, files: MockFileEntry[]) => Promise<void>;
    renameFile: (oldPath: string, newPath: string) => Promise<void>;
    setReadFileBlocked: (path: string, blocked: boolean) => Promise<void>;
    releaseNextBlockedRead: () => Promise<void>;
    failNextBlockedRead: (message: string) => Promise<void>;
    rejectBlockedRead: (message: string) => Promise<void>;
    setPublishChannels: (channels: ChannelConfig[]) => Promise<void>;
    setPublishDrafts: (forms: Record<string, FormDraft>) => Promise<void>;
    setPublishBlocked: (blocked: boolean) => Promise<void>;
    setPublishError: (message: string | null) => Promise<void>;
    setPublishDraftWritesBlocked: (blocked: boolean) => Promise<void>;
    setStyledConversionBlocked: (blocked: boolean) => Promise<void>;
    setStyledConversionError: (message: string | null) => Promise<void>;
    setStyledConversionHtml: (html: string | null) => Promise<void>;
    setStyledImageResults: (results: Record<string, { bytes: number[]; mime: string } | { error: string }>) => Promise<void>;
    setStyledImageHostSettings: (settings: {
      hosts: Array<Record<string, unknown>>;
      active_host_id: string | null;
      auto_on_paste: boolean;
    }) => Promise<void>;
    setStyledUploadResults: (results: Record<string, { url: string } | { error: string }>) => Promise<void>;
    getInvokeCalls: () => Promise<MockInvokeCall[]>;
    reset: () => Promise<void>;
  };
}>({
  browserErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    await use(errors);
  },

  app: async ({ page, browserErrors: _browserErrors }, use) => {
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
      async getRecentProjects() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.recentProjects);
      },
      async seedRecentProjects(list: Array<{ path: string; name: string; last_opened: string; pinned?: boolean; sort_order?: number | null }>) {
        await app.evaluate(
          (l) => (window as any).__TAURI_MOCK_STATE__.seedRecentProjects(l),
          list,
        );
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
      async setReadFileBlocked(path: string, blocked: boolean) {
        await app.evaluate(([filePath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setReadFileBlocked');
          if (typeof setter !== 'function') throw new Error('Read-file blocker unavailable');
          setter.call(state, filePath, value);
        }, [path, blocked] as const);
      },
      async releaseNextBlockedRead() {
        await app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const release: unknown = Reflect.get(state, 'releaseNextBlockedRead');
          if (typeof release !== 'function') throw new Error('Blocked read releaser unavailable');
          release.call(state);
        });
      },
      async failNextBlockedRead(message: string) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const fail: unknown = Reflect.get(state, 'failNextBlockedRead');
          if (typeof fail !== 'function') throw new Error('Blocked read failure control unavailable');
          fail.call(state, value);
        }, message);
      },
      async rejectBlockedRead(message: string) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const reject: unknown = Reflect.get(state, 'rejectBlockedRead');
          if (typeof reject !== 'function') throw new Error('Blocked read rejecter unavailable');
          reject.call(state, value);
        }, message);
      },
      async setPublishChannels(channels: ChannelConfig[]) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setPublishChannels');
          if (typeof setter !== 'function') throw new Error('Publish channel setter unavailable');
          setter.call(state, value);
        }, channels);
      },
      async setPublishDrafts(forms: Record<string, FormDraft>) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setPublishDrafts');
          if (typeof setter !== 'function') throw new Error('Publish draft setter unavailable');
          setter.call(state, value);
        }, forms);
      },
      async setPublishBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setPublishBlocked');
          if (typeof setter !== 'function') throw new Error('Publish blocker unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setPublishError(message: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setPublishError');
          if (typeof setter !== 'function') throw new Error('Publish error setter unavailable');
          setter.call(state, value);
        }, message);
      },
      async setPublishDraftWritesBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setPublishDraftWritesBlocked');
          if (typeof setter !== 'function') throw new Error('Publish draft write blocker unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setStyledConversionBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledConversionBlocked');
          if (typeof setter !== 'function') throw new Error('Styled conversion blocker unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setStyledConversionError(message: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledConversionError');
          if (typeof setter !== 'function') throw new Error('Styled conversion error setter unavailable');
          setter.call(state, value);
        }, message);
      },
      async setStyledConversionHtml(html: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledConversionHtml');
          if (typeof setter !== 'function') throw new Error('Styled conversion HTML setter unavailable');
          setter.call(state, value);
        }, html);
      },
      async setStyledImageResults(results: Record<string, { bytes: number[]; mime: string } | { error: string }>) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledImageResults');
          if (typeof setter !== 'function') throw new Error('Styled image result setter unavailable');
          setter.call(state, value);
        }, results);
      },
      async setStyledImageHostSettings(settings: {
        hosts: Array<Record<string, unknown>>;
        active_host_id: string | null;
        auto_on_paste: boolean;
      }) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledImageHostSettings');
          if (typeof setter !== 'function') throw new Error('Styled image-host settings setter unavailable');
          setter.call(state, value);
        }, settings);
      },
      async setStyledUploadResults(results: Record<string, { url: string } | { error: string }>) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setStyledUploadResults');
          if (typeof setter !== 'function') throw new Error('Styled upload result setter unavailable');
          setter.call(state, value);
        }, results);
      },
      async getInvokeCalls() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const calls: unknown = Reflect.get(state, 'invokeCalls');
          if (!Array.isArray(calls)) throw new Error('Invoke calls unavailable');
          return calls;
        });
      },
      async reset() {
        await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.reset());
      },
    };
    await use(helpers);
  },
});

export { expect };
