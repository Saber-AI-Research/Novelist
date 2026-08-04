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
import type {
  ChannelConfig,
  FormDraft,
  LiteraryStudyOverview,
  ProjectConfig,
  PublishResult,
  RemoteIdentity,
} from '../../../app/lib/ipc/commands';

export interface MockInvokeCall {
  command: string;
  args: Record<string, unknown>;
}

export interface FixtureResidue {
  localStorageKeys: string[];
  sessionStorageKeys: string[];
  cacheKeys: string[];
  writtenFileCount: number;
  createdFileCount: number;
  deletedFileCount: number;
  invokeCallCount: number;
  unhandledCommandCount: number;
  aiSessionCount: number;
  publishDraftCount: number;
  publishRemoteCount: number;
  publishCoverAssetCount: number;
  publishCoverRefCount: number;
  publishChannelCount: number;
  publishResponseCount: number;
  templateCount: number;
  scaffoldedPluginCount: number;
  eventListenerCount: number;
  pendingWaiterCount: number;
  updaterResponseCount: number;
  updaterCheckCount: number;
}

const EMPTY_FIXTURE_RESIDUE: FixtureResidue = {
  localStorageKeys: [],
  sessionStorageKeys: [],
  cacheKeys: [],
  writtenFileCount: 0,
  createdFileCount: 0,
  deletedFileCount: 0,
  invokeCallCount: 0,
  unhandledCommandCount: 0,
  aiSessionCount: 0,
  publishDraftCount: 0,
  publishRemoteCount: 0,
  publishCoverAssetCount: 0,
  publishCoverRefCount: 0,
  publishChannelCount: 0,
  publishResponseCount: 0,
  templateCount: 0,
  scaffoldedPluginCount: 0,
  eventListenerCount: 0,
  pendingWaiterCount: 0,
  updaterResponseCount: 0,
  updaterCheckCount: 0,
};

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
  browserErrors: string[];
  clipboardCapture: {
    start: () => Promise<void>;
    startDeferred: () => Promise<void>;
    startRejected: (message: string) => Promise<void>;
    releaseNext: () => Promise<void>;
    getWrites: () => Promise<string[]>;
  };
  _task23Isolation: void;
  /** Dispatch keyboard shortcut directly to DOM (bypasses browser interception) */
   appKeys: {
     press: (key: string, opts?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => Promise<void>;
     pressMod: (key: string) => Promise<void>;
   };
  mockState: {
    getWrittenFiles: () => Promise<Record<string, string>>;
    getCreatedFiles: () => Promise<string[]>;
    getDeletedFiles: () => Promise<string[]>;
    getFiles: () => Promise<MockFileEntry[]>;
    getRecentProjects: () => Promise<Array<{ path: string; name: string; pinned?: boolean }>>;
    seedRecentProjects: (list: Array<{ path: string; name: string; last_opened: string; pinned?: boolean; sort_order?: number | null }>) => Promise<void>;
    emitEvent: (event: string, payload: unknown, targetLabel?: string) => Promise<void>;
    openProject: (dirPath: string, files: MockFileEntry[]) => Promise<void>;
    setProjectConfig: (config: ProjectConfig) => Promise<void>;
    setLiteraryOverview: (overview: LiteraryStudyOverview) => Promise<void>;
    renameFile: (oldPath: string, newPath: string) => Promise<void>;
    setClaudeCliSendError: (message: string | null) => Promise<void>;
    setClaudeCliKillBlocked: (blocked: boolean) => Promise<void>;
    setCodexCliKillBlocked: (blocked: boolean) => Promise<void>;
    setCodexCliTurnError: (message: string | null) => Promise<void>;
    setAiSessionWriteError: (message: string | null) => Promise<void>;
    setAiSessionWritesBlocked: (blocked: boolean) => Promise<void>;
    setAiSessionDeletesBlocked: (blocked: boolean) => Promise<void>;
    setAiSessionListError: (projectDir: string, message: string | null) => Promise<void>;
    setAiPromptAssetError: (projectDir: string, message: string | null) => Promise<void>;
      setAiPromptAssetsBlocked: (projectDir: string, blocked: boolean) => Promise<void>;
      setProjectDetectBlocked: (projectDir: string, blocked: boolean) => Promise<void>;
    setReadFileBlocked: (path: string, blocked: boolean) => Promise<void>;
    releaseNextBlockedRead: () => Promise<void>;
    failNextBlockedRead: (message: string) => Promise<void>;
    rejectBlockedRead: (message: string) => Promise<void>;
    scheduleConditionalWriteMutation: (path: string, content: string) => Promise<void>;
    setConditionalWriteBlocked: (path: string, blocked: boolean) => Promise<void>;
    setConditionalWriteResolvedTarget: (path: string, resolvedPath: string, content: string) => Promise<void>;
    setFileContent: (path: string, content: string) => Promise<void>;
     getFileContent: (path: string) => Promise<string | null>;
     setPublishChannels: (channels: ChannelConfig[]) => Promise<void>;
     deferNextPublishSettingsRead: () => Promise<void>;
     releaseNextPublishSettingsRead: () => Promise<void>;
     setPublishDrafts: (forms: Record<string, FormDraft>) => Promise<void>;
     setPublishDraftInvalidChannelIds: (channelIds: string[]) => Promise<void>;
     setPublishRemote: (args: {
       projectDir: string;
       filePath: string;
       channelId: string;
       remote: RemoteIdentity | null;
     }) => Promise<void>;
     getPublishRemotes: () => Promise<Record<string, RemoteIdentity>>;
       setPublishResponses: (responses: Array<
         | { result: PublishResult }
         | { error: string }
       >) => Promise<void>;
       setPublishVerifyResponses: (responses: Array<{ error: string }>) => Promise<void>;
      deferNextPublishRemoteRead: () => Promise<void>;
      releaseNextPublishRemoteRead: () => Promise<void>;
       rejectNextPublishRemoteRead: (message: string) => Promise<void>;
       setPublishBindError: (message: string | null) => Promise<void>;
       setPublishBindBlocked: (blocked: boolean) => Promise<void>;
       setPublishPersistError: (message: string | null) => Promise<void>;
       setPublishPersistBlocked: (blocked: boolean) => Promise<void>;
     setPublishCoverLoadBlocked: (blocked: boolean) => Promise<void>;
     releaseNextPublishCoverLoad: () => Promise<void>;
     setPublishClipboardImage: (image: { bytes: number[]; mime: string; width: number; height: number } | { error: string } | null) => Promise<void>;
     setPublishClipboardReadBlocked: (blocked: boolean) => Promise<void>;
     releaseNextPublishClipboardRead: () => Promise<void>;
     setPublishBlocked: (blocked: boolean) => Promise<void>;
     setPublishError: (message: string | null) => Promise<void>;
     setPublishDraftWritesBlocked: (blocked: boolean) => Promise<void>;
     setPublishDraftWriteError: (message: string | null) => Promise<void>;
     setManagedNameWritesBlocked: (blocked: boolean) => Promise<void>;
     releaseNextManagedNameWrite: () => Promise<void>;
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
     setPortableMode: (value: { enabled: boolean; dataRoot?: string } | { error: string }) => Promise<void>;
     setUpdaterResponses: (responses: Array<null | { version: string; body?: string | null } | { error: string }>) => Promise<void>;
     getInvokeCalls: () => Promise<MockInvokeCall[]>;
    getAiSessionWriteCount: () => Promise<number>;
    getClaudeCliSpawnUuidHistory: () => Promise<string[]>;
    getClaudeCliSendCount: () => Promise<number>;
    getClaudeCliKillCount: () => Promise<number>;
    getCodexCliTurnCount: () => Promise<number>;
     getCodexCliKillCount: () => Promise<number>;
     reset: () => Promise<void>;
     cleanup: () => Promise<void>;
     getResidue: () => Promise<FixtureResidue>;
   };
}>({
  browserErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
      if (message.type() === 'warning' && message.text().includes('[Tauri Mock] Unhandled command:')) {
        errors.push(`unhandled IPC: ${message.text()}`);
      }
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
       pressMod: async (key) => {
         const isMac = await app.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform));
         await app.keyboard.press(`${isMac ? 'Meta' : 'Control'}+${key}`);
       },
    });
  },

  clipboardCapture: async ({ app }, use) => {
    async function configure(mode: 'resolved' | 'deferred' | 'rejected', rejectionMessage = '') {
      await app.evaluate(({ mode, rejectionMessage }) => {
        const writes: string[] = [];
        const releases: Array<() => void> = [];
        Reflect.set(window, '__NOVELIST_TEST_CLIPBOARD_WRITES__', writes);
        Reflect.set(window, '__NOVELIST_TEST_CLIPBOARD_RELEASES__', releases);
        const current = navigator.clipboard;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            readText: async () => writes.at(-1) ?? '',
            writeText: async (text: string) => {
              writes.push(text);
              if (mode === 'deferred') {
                await new Promise<void>(resolve => releases.push(resolve));
              } else if (mode === 'rejected') {
                throw new Error(rejectionMessage);
              }
            },
            ...(current && 'read' in current ? { read: current.read.bind(current) } : {}),
            ...(current && 'write' in current ? { write: current.write.bind(current) } : {}),
          },
        });
      }, { mode, rejectionMessage });
    }

    await use({
      async start() {
        await configure('resolved');
      },
      async startDeferred() {
        await configure('deferred');
      },
      async startRejected(message: string) {
        await configure('rejected', message);
      },
      async releaseNext() {
        await app.evaluate(() => {
          const releases = Reflect.get(window, '__NOVELIST_TEST_CLIPBOARD_RELEASES__');
          if (!Array.isArray(releases)) throw new Error('Clipboard release queue unavailable');
          const release: unknown = releases.shift();
          if (typeof release !== 'function') throw new Error('No deferred clipboard write to release');
          release();
        });
      },
      async getWrites() {
        return app.evaluate(() => {
          const writes = Reflect.get(window, '__NOVELIST_TEST_CLIPBOARD_WRITES__');
          if (!Array.isArray(writes) || !writes.every(value => typeof value === 'string')) {
            throw new Error('Clipboard capture unavailable');
          }
          return writes;
        });
      },
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
      async emitEvent(event: string, payload: unknown, targetLabel?: string) {
        await app.evaluate(
          ([e, p, target]) => (window as any).__TAURI_MOCK_STATE__.emitEvent(e, p, target),
          [event, payload, targetLabel] as const,
        );
      },
      async openProject(dirPath: string, files: MockFileEntry[]) {
        await app.evaluate(
          ([d, f]) => (window as any).__TAURI_MOCK_STATE__.openProject(d, f),
          [dirPath, files] as const,
        );
      },
      async setProjectConfig(config: ProjectConfig) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setProjectConfig(value),
          config,
        );
      },
      async setLiteraryOverview(overview: LiteraryStudyOverview) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setLiteraryOverview(value),
          overview,
        );
      },
      async renameFile(oldPath: string, newPath: string) {
        await app.evaluate(
          ([o, n]) => (window as any).__TAURI_MOCK_STATE__.renameFile(o, n),
          [oldPath, newPath] as const,
        );
      },
      async setClaudeCliSendError(message: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setClaudeCliSendError');
          if (typeof setter !== 'function') throw new Error('Claude send-error setter unavailable');
          setter.call(state, value);
        }, message);
      },
      async setConditionalWriteResolvedTarget(path: string, resolvedPath: string, content: string) {
        await app.evaluate(([requested, resolved, initial]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setConditionalWriteResolvedTarget');
          if (typeof setter !== 'function') throw new Error('Conditional write target setter unavailable');
          setter.call(state, requested, resolved, initial);
        }, [path, resolvedPath, content] as const);
      },
      async getFileContent(path: string) {
        return app.evaluate((target) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const getter: unknown = Reflect.get(state, 'getFileContent');
          if (typeof getter !== 'function') throw new Error('Mock file-content getter unavailable');
          const value: unknown = getter.call(state, target);
          if (value !== null && typeof value !== 'string') throw new Error('Mock file content unavailable');
          return value;
        }, path);
      },
      async setClaudeCliKillBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setClaudeCliKillBlocked');
          if (typeof setter !== 'function') throw new Error('Claude kill-block setter unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setCodexCliKillBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setCodexCliKillBlocked');
          if (typeof setter !== 'function') throw new Error('Codex kill-block setter unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setCodexCliTurnError(message: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setCodexCliTurnError');
          if (typeof setter !== 'function') throw new Error('Codex turn-error setter unavailable');
          setter.call(state, value);
        }, message);
      },
      async setAiSessionWriteError(message: string | null) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiSessionWriteError');
          if (typeof setter !== 'function') throw new Error('AI session write-error setter unavailable');
          setter.call(state, value);
        }, message);
      },
      async setAiSessionWritesBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiSessionWritesBlocked');
          if (typeof setter !== 'function') throw new Error('AI session write blocker unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setAiSessionDeletesBlocked(blocked: boolean) {
        await app.evaluate((value) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiSessionDeletesBlocked');
          if (typeof setter !== 'function') throw new Error('AI session delete blocker unavailable');
          setter.call(state, value);
        }, blocked);
      },
      async setAiSessionListError(projectDir: string, message: string | null) {
        await app.evaluate(([dirPath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiSessionListError');
          if (typeof setter !== 'function') throw new Error('AI session list-error setter unavailable');
          setter.call(state, dirPath, value);
        }, [projectDir, message] as const);
      },
      async setAiPromptAssetError(projectDir: string, message: string | null) {
        await app.evaluate(([dirPath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiPromptAssetError');
          if (typeof setter !== 'function') throw new Error('AI prompt-asset error setter unavailable');
          setter.call(state, dirPath, value);
        }, [projectDir, message] as const);
      },
      async setAiPromptAssetsBlocked(projectDir: string, blocked: boolean) {
        await app.evaluate(([dirPath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setAiPromptAssetsBlocked');
          if (typeof setter !== 'function') throw new Error('AI prompt-asset blocker unavailable');
          setter.call(state, dirPath, value);
        }, [projectDir, blocked] as const);
      },
      async setProjectDetectBlocked(projectDir: string, blocked: boolean) {
        await app.evaluate(([dirPath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setProjectDetectBlocked');
          if (typeof setter !== 'function') throw new Error('Project detect blocker unavailable');
          setter.call(state, dirPath, value);
        }, [projectDir, blocked] as const);
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
      async scheduleConditionalWriteMutation(path: string, content: string) {
        await app.evaluate(([filePath, externalContent]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const schedule: unknown = Reflect.get(state, 'scheduleConditionalWriteMutation');
          if (typeof schedule !== 'function') throw new Error('Conditional-write mutation scheduler unavailable');
          schedule.call(state, filePath, externalContent);
        }, [path, content] as const);
      },
      async setConditionalWriteBlocked(path: string, blocked: boolean) {
        await app.evaluate(([filePath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setConditionalWriteBlocked');
          if (typeof setter !== 'function') throw new Error('Conditional-write blocker unavailable');
          setter.call(state, filePath, value);
        }, [path, blocked] as const);
      },
      async setFileContent(path: string, content: string) {
        await app.evaluate(([filePath, value]) => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const setter: unknown = Reflect.get(state, 'setFileContent');
          if (typeof setter !== 'function') throw new Error('Mock file-content setter unavailable');
          setter.call(state, filePath, value);
        }, [path, content] as const);
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
       async deferNextPublishSettingsRead() {
         await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.deferNextPublishSettingsRead());
       },
       async releaseNextPublishSettingsRead() {
         await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.releaseNextPublishSettingsRead());
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
       async setPublishDraftInvalidChannelIds(channelIds: string[]) {
         await app.evaluate((value) => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const setter: unknown = Reflect.get(state, 'setPublishDraftInvalidChannelIds');
           if (typeof setter !== 'function') throw new Error('Publish invalid-draft setter unavailable');
           setter.call(state, value);
         }, channelIds);
       },
       async setPublishCoverLoadBlocked(blocked: boolean) {
         await app.evaluate((value) => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const setter: unknown = Reflect.get(state, 'setPublishCoverLoadBlocked');
           if (typeof setter !== 'function') throw new Error('Publish cover load blocker unavailable');
           setter.call(state, value);
         }, blocked);
       },
       async releaseNextPublishCoverLoad() {
         await app.evaluate(() => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const release: unknown = Reflect.get(state, 'releaseNextPublishCoverLoad');
           if (typeof release !== 'function') throw new Error('Publish cover load release unavailable');
           release.call(state);
         });
       },
       async setPublishClipboardImage(image: { bytes: number[]; mime: string; width: number; height: number } | { error: string } | null) {
         await app.evaluate((value) => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const setter: unknown = Reflect.get(state, 'setPublishClipboardImage');
           if (typeof setter !== 'function') throw new Error('Publish clipboard image setter unavailable');
           setter.call(state, value);
        }, image);
      },
      async setPublishRemote(args: {
        projectDir: string;
        filePath: string;
        channelId: string;
        remote: RemoteIdentity | null;
      }) {
        await app.evaluate((value) => {
          const state: any = (window as any).__TAURI_MOCK_STATE__;
          state.setPublishRemote(value.projectDir, value.filePath, value.channelId, value.remote);
        }, args);
      },
      async getPublishRemotes() {
        return app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.publishRemotes);
      },
      async setPublishResponses(responses: Array<
        | { result: PublishResult }
        | { error: string }
      >) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishResponses(value),
          responses,
        );
      },
      async setPublishVerifyResponses(responses: Array<{ error: string }>) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishVerifyResponses(value),
          responses,
        );
      },
      async deferNextPublishRemoteRead() {
        await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.deferNextPublishRemoteRead());
      },
      async releaseNextPublishRemoteRead() {
        await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.releaseNextPublishRemoteRead());
      },
      async rejectNextPublishRemoteRead(message: string) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.rejectNextPublishRemoteRead(value),
          message,
        );
      },
      async setPublishBindError(message: string | null) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishBindError(value),
          message,
        );
      },
      async setPublishBindBlocked(blocked: boolean) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishBindBlocked(value),
          blocked,
        );
      },
      async setPublishPersistError(message: string | null) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishPersistError(value),
          message,
        );
      },
      async setPublishPersistBlocked(blocked: boolean) {
        await app.evaluate(
          (value) => (window as any).__TAURI_MOCK_STATE__.setPublishPersistBlocked(value),
          blocked,
        );
      },
       async setPublishClipboardReadBlocked(blocked: boolean) {
         await app.evaluate((value) => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const setter: unknown = Reflect.get(state, 'setPublishClipboardReadBlocked');
           if (typeof setter !== 'function') throw new Error('Publish clipboard read blocker unavailable');
           setter.call(state, value);
         }, blocked);
       },
       async releaseNextPublishClipboardRead() {
         await app.evaluate(() => {
           const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
           if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
           const release: unknown = Reflect.get(state, 'releaseNextPublishClipboardRead');
           if (typeof release !== 'function') throw new Error('Publish clipboard read release unavailable');
           release.call(state);
         });
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
       async setPublishDraftWriteError(message: string | null) {
         await app.evaluate(
           (value) => (window as any).__TAURI_MOCK_STATE__.setPublishDraftWriteError(value),
           message,
         );
       },
       async setManagedNameWritesBlocked(blocked: boolean) {
         await app.evaluate(
           (value) => (window as any).__TAURI_MOCK_STATE__.setManagedNameWritesBlocked(value),
           blocked,
         );
       },
       async releaseNextManagedNameWrite() {
         await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.releaseNextManagedNameWrite());
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
       async setPortableMode(value: { enabled: boolean; dataRoot?: string } | { error: string }) {
         await app.evaluate((next) => {
           const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
           const setter = Reflect.get(state, 'setPortableMode');
           if (typeof setter !== 'function') throw new Error('Portable-mode setter unavailable');
           setter.call(state, next);
         }, value);
       },
       async setUpdaterResponses(responses: Array<null | { version: string; body?: string | null } | { error: string }>) {
         await app.evaluate((next) => {
           const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
           const setter = Reflect.get(state, 'setUpdaterResponses');
           if (typeof setter !== 'function') throw new Error('Updater response setter unavailable');
           setter.call(state, next);
         }, responses);
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
      async getAiSessionWriteCount() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const count: unknown = Reflect.get(state, 'aiSessionWriteCount');
          if (typeof count !== 'number') throw new Error('AI session write count unavailable');
          return count;
        });
      },
      async getClaudeCliSpawnUuidHistory() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const history: unknown = Reflect.get(state, 'claudeCliSpawnUuidHistory');
          if (!Array.isArray(history) || !history.every((value) => typeof value === 'string')) {
            throw new Error('Claude spawn UUID history unavailable');
          }
          return history;
        });
      },
      async getClaudeCliSendCount() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const count: unknown = Reflect.get(state, 'claudeCliSendCount');
          if (typeof count !== 'number') throw new Error('Claude send count unavailable');
          return count;
        });
      },
      async getClaudeCliKillCount() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const count: unknown = Reflect.get(state, 'claudeCliKillCount');
          if (typeof count !== 'number') throw new Error('Claude kill count unavailable');
          return count;
        });
      },
      async getCodexCliTurnCount() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const count: unknown = Reflect.get(state, 'codexCliTurnCount');
          if (typeof count !== 'number') throw new Error('Codex turn count unavailable');
          return count;
        });
      },
      async getCodexCliKillCount() {
        return app.evaluate(() => {
          const state: unknown = Reflect.get(window, '__TAURI_MOCK_STATE__');
          if (typeof state !== 'object' || state === null) throw new Error('Tauri mock state unavailable');
          const count: unknown = Reflect.get(state, 'codexCliKillCount');
          if (typeof count !== 'number') throw new Error('Codex kill count unavailable');
          return count;
        });
      },
       async reset() {
         await app.evaluate(() => (window as any).__TAURI_MOCK_STATE__.reset());
       },
       async cleanup() {
         await app.evaluate(async () => {
           const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
            for (const [name, value] of [
             ['setAiSessionWritesBlocked', false],
             ['setAiSessionDeletesBlocked', false],
             ['setClaudeCliKillBlocked', false],
             ['setCodexCliKillBlocked', false],
             ['setPublishCoverLoadBlocked', false],
              ['setPublishClipboardReadBlocked', false],
              ['setPublishBlocked', false],
              ['setPublishBindBlocked', false],
               ['setPublishPersistBlocked', false],
               ['setPublishDraftWritesBlocked', false],
               ['setManagedNameWritesBlocked', false],
              ['setStyledConversionBlocked', false],
            ] as const) {
             const setter = Reflect.get(state, name);
             if (typeof setter === 'function') setter.call(state, value);
            }
            const releasePublishRemoteReads = Reflect.get(state, 'releaseAllPublishRemoteReads');
            if (typeof releasePublishRemoteReads === 'function') {
              releasePublishRemoteReads.call(state);
            }
            const releasePublishSettingsReads = Reflect.get(state, 'releaseAllPublishSettingsReads');
            if (typeof releasePublishSettingsReads === 'function') {
              releasePublishSettingsReads.call(state);
            }
            await Promise.resolve();
           await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

           const checkerPath = '/app/lib/services/update-checker.ts';
           const portablePath = '/app/lib/services/portable.ts';
           const storePath = '/app/lib/stores/updater-state.svelte.ts';
           const checker = await import(/* @vite-ignore */ checkerPath);
           const portable = await import(/* @vite-ignore */ portablePath);
           const { updaterState } = await import(/* @vite-ignore */ storePath);
           checker.__resetUpdateCheckerForTests();
           portable.__resetPortableCacheForTests();
           updaterState.reset();
           await Promise.resolve();
           await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
           if (typeof caches !== 'undefined') {
             await Promise.all((await caches.keys()).map(key => caches.delete(key)));
           }
           const resetAll = Reflect.get(state, 'resetAll');
           if (typeof resetAll !== 'function') throw new Error('Full Tauri mock reset unavailable');
           resetAll.call(state);
           localStorage.clear();
           sessionStorage.clear();
         });
       },
       async getResidue() {
         return app.evaluate(async () => {
           const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
           const residue = Reflect.get(state, 'residue');
           if (typeof residue !== 'object' || residue === null) throw new Error('Tauri mock residue unavailable');
           return {
             localStorageKeys: Object.keys(localStorage).sort(),
             sessionStorageKeys: Object.keys(sessionStorage).sort(),
             cacheKeys: typeof caches === 'undefined' ? [] : (await caches.keys()).sort(),
             ...(residue as Omit<FixtureResidue, 'localStorageKeys' | 'sessionStorageKeys' | 'cacheKeys'>),
           };
         });
       },
     };
     await use(helpers);
   },

   _task23Isolation: [async ({ browserErrors, mockState }, use, testInfo) => {
     await use();
     if (!testInfo.title.includes('@task23')) return;
     const errorsBeforeCleanup = [...browserErrors];
     await mockState.cleanup();
     expect(errorsBeforeCleanup).toEqual([]);
     expect(await mockState.getResidue()).toEqual(EMPTY_FIXTURE_RESIDUE);
     expect(browserErrors).toEqual([]);
   }, { auto: true }],
 });

export { expect };
