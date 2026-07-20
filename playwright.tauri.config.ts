import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NATIVE_WORKFLOW_TIMEOUT_MS } from './tests/e2e/native/native-timeouts';

declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  testDir: './tests/e2e/native/specs',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: NATIVE_WORKFLOW_TIMEOUT_MS,
  reporter: [['list']],
  outputDir: process.env['NOVELIST_NATIVE_PLAYWRIGHT_OUTPUT']
    ?? path.join(tmpdir(), 'novelist-playwright-tauri'),
  preserveOutput: 'always',
  projects: [
    {
      name: 'tauri',
      metadata: {
        backend: 'rust',
        webview: 'WKWebView',
        socket: process.env['NOVELIST_NATIVE_SOCKET'] ?? 'unconfigured',
      },
    },
  ],
});
