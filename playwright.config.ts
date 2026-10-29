import { defineConfig, devices } from '@playwright/test';

declare const process: { env: Record<string, string | undefined> };
const isCI = !!process.env['CI'];

export default defineConfig<{ mockPlatform: 'macos' | 'ios' | 'android' }>({
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
      testIgnore: '**/mobile/**',
      use: { ...devices['Desktop Safari'], mockPlatform: 'macos' },
    },
    {
      name: 'chromium',
      testIgnore: '**/mobile/**',
      use: { ...devices['Desktop Chrome'], mockPlatform: 'macos' },
    },
    {
      name: 'iphone',
      testMatch: '**/mobile/**/*.spec.ts',
      use: { ...devices['iPhone 13'], mockPlatform: 'ios' },
    },
    {
      name: 'ipad',
      testMatch: '**/mobile/**/*.spec.ts',
      use: { ...devices['iPad (gen 7)'], mockPlatform: 'ios' },
    },
    {
      name: 'ipad-landscape',
      testMatch: '**/mobile/**/*.spec.ts',
      use: { ...devices['iPad (gen 7) landscape'], mockPlatform: 'ios' },
    },
    {
      name: 'android-phone',
      testMatch: '**/mobile/**/*.spec.ts',
      use: { ...devices['Pixel 7'], mockPlatform: 'android' },
    },
  ],
  webServer: {
    command: 'pnpm exec vite --mode test',
    url: 'http://localhost:1420',
    reuseExistingServer: !isCI,
    timeout: 30000,
  },
});
