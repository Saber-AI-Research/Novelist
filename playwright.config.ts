import { defineConfig, devices } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };
const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './tests/e2e/specs',
  fullyParallel: true,
  forbidOnly: isCI,
  // Retries only collect a trace ('on-first-retry'); a test that needs one to
  // pass still fails CI instead of hiding the flake.
  retries: isCI ? 2 : 0,
  failOnFlakyTests: isCI,
  workers: isCI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  outputDir: 'test-results/playwright',
  preserveOutput: 'always',
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !isCI,
    timeout: 30000,
  },
});
