import type { Page } from '@playwright/test';
import { expect, test, type MockInvokeCall } from '../fixtures/app-fixture';

type UpdaterResponse = null | { version: string; body?: string | null } | { error: string };

type UpdaterControls = {
  setPortableMode: (value: { enabled: boolean; dataRoot?: string } | { error: string }) => Promise<void>;
  setUpdaterResponses: (responses: UpdaterResponse[]) => Promise<void>;
};

async function resetUpdaterRuntime(app: Page) {
  await app.evaluate(async () => {
    const checkerPath = '/app/lib/services/update-checker.ts';
    const portablePath = '/app/lib/services/portable.ts';
    const storePath = '/app/lib/stores/updater-state.svelte.ts';
    const checker = await import(/* @vite-ignore */ checkerPath);
    const portable = await import(/* @vite-ignore */ portablePath);
    const { updaterState } = await import(/* @vite-ignore */ storePath);
    checker.__resetUpdateCheckerForTests();
    portable.__resetPortableCacheForTests();
    updaterState.reset();
  });
}

async function runSilentChecks(app: Page, count = 1) {
  await app.evaluate(async (total) => {
    const updaterPath = '/app/lib/updater.ts';
    const { checkForUpdates } = await import(/* @vite-ignore */ updaterPath);
    await Promise.all(Array.from({ length: total }, () => checkForUpdates(true)));
  }, count);
}

function updaterCalls(calls: MockInvokeCall[]) {
  return calls.filter(call => call.command.startsWith('plugin:updater|'));
}

test.describe('Updater browser state machine', () => {
  test('scheduled startup check displays one available update @task23', async ({ app, mockState }, testInfo) => {
    const controls = mockState as typeof mockState & UpdaterControls;
    await controls.setPortableMode({ enabled: false });
    await controls.setUpdaterResponses([{ version: '0.4.0', body: 'Deterministic release notes' }]);
    await app.reload();
    await app.waitForSelector('#app > *', { timeout: 10000 });

    const banner = app.getByTestId('update-available-banner');
    await expect(banner).toHaveCount(1, { timeout: 8000 });
    await expect(banner).toContainText('0.4.0');
    await expect(banner).toContainText('Install');
    await banner.screenshot({
      path: `.sisyphus/evidence/task-23-updater-available-${testInfo.project.name}.png`,
    });
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'plugin:updater|check')).toHaveLength(1);
    expect(updaterCalls(calls)).toHaveLength(1);
    await app.screenshot({ path: '.sisyphus/evidence/task-22-startup-update.png' });
  });

  test('portable mode remains quiet and invokes no updater plugin @task23 @task23-negative', async ({ app, mockState }) => {
    const controls = mockState as typeof mockState & UpdaterControls;
    await controls.setPortableMode({ enabled: true, dataRoot: '/portable/data' });
    await controls.setUpdaterResponses([{ version: '9.9.9' }]);
    await resetUpdaterRuntime(app);
    await mockState.reset();

    await runSilentChecks(app);

    await expect(app.getByTestId('update-available-banner')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'is_portable_mode')).toHaveLength(1);
    expect(updaterCalls(calls)).toHaveLength(0);
  });

  test('skipped and no-update startup outcomes stay quiet @task23 @task23-negative', async ({ app, mockState }) => {
    const controls = mockState as typeof mockState & UpdaterControls;
    await controls.setPortableMode({ enabled: false });
    await app.evaluate(() => localStorage.setItem('novelist-skipped-update-version', '9.9.9'));
    await controls.setUpdaterResponses([{ version: '9.9.9', body: 'Skipped notes' }]);
    await resetUpdaterRuntime(app);
    await mockState.reset();

    await runSilentChecks(app);
    await expect(app.getByTestId('update-available-banner')).toHaveCount(0);

    await app.evaluate(() => localStorage.removeItem('novelist-skipped-update-version'));
    await controls.setUpdaterResponses([null]);
    await resetUpdaterRuntime(app);
    await runSilentChecks(app);

    await expect(app.getByTestId('update-available-banner')).toHaveCount(0);
    const calls = await mockState.getInvokeCalls();
    expect(calls.filter(call => call.command === 'plugin:updater|check')).toHaveLength(2);
    expect(calls.filter(call => call.command === 'plugin:dialog|message')).toHaveLength(0);
  });

  test('transient startup failure permits one clean manual retry @task23 @task23-negative', async ({ app, mockState }) => {
    const controls = mockState as typeof mockState & UpdaterControls;
    await controls.setPortableMode({ enabled: false });
    await controls.setUpdaterResponses([
      { error: 'temporary network failure' },
      { version: '0.4.0', body: 'Recovered release notes' },
    ]);
    await resetUpdaterRuntime(app);
    await mockState.reset();

    await runSilentChecks(app);
    await expect(app.getByTestId('update-available-banner')).toHaveCount(0);
    expect((await mockState.getInvokeCalls()).filter(call => call.command === 'plugin:dialog|message')).toHaveLength(0);

    await app.keyboard.press('Meta+Shift+p');
    await app.getByTestId('palette-input').fill('Check for Updates');
    const result = app.getByTestId('palette-result-0');
    await expect(result).toContainText('Check for Updates');
    await result.click();

    await expect.poll(async () => (await mockState.getInvokeCalls())
      .filter(call => call.command === 'plugin:updater|check').length).toBe(2);
    await expect(app.getByTestId('command-palette')).toHaveCount(0);
    await expect(app.getByTestId('update-available-banner')).toContainText('0.4.0');

    const calls = await mockState.getInvokeCalls();
    const dialogs = calls.filter(call => call.command === 'plugin:dialog|message');
    expect(dialogs.some(call => call.args.title === 'Update Available')).toBe(true);
    expect(dialogs.every(call => call.args.kind !== 'error')).toBe(true);
    expect(updaterCalls(calls).filter(call => call.command !== 'plugin:updater|check')).toHaveLength(0);
  });
});
