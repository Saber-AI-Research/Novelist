import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';

const FAILURE_PREFIX = 'NOVELIST_PANDOC_FAILURE_JSON:';

type PandocFailure = {
  stage: string;
  message: string;
  resolved_binary?: string;
  format?: string;
  stderr_excerpt?: string;
  stderr_truncated?: boolean;
  source_path?: string;
  probed_paths?: string[];
};

async function configureExport(
  app: Page,
  response: { result: { message: string; warning?: PandocFailure } } | { error: string },
) {
  await app.evaluate((mockResponse) => {
    const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
    const setStatus = Reflect.get(state, 'setPandocStatus');
    const setResponse = Reflect.get(state, 'setExportProjectResponse');
    if (typeof setStatus !== 'function' || typeof setResponse !== 'function') {
      throw new Error('Export mock controls unavailable');
    }
    setStatus.call(state, {
      available: true,
      version: 'pandoc 3.10',
      resolved_path: '/opt/pandoc-3.10/bin/pandoc',
      override_path: null,
    });
    setResponse.call(state, mockResponse);
  }, response);
}

async function openExportDialog(app: Page, options: { includeTheme?: boolean } = {}) {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
  await app.keyboard.press('Meta+Shift+p');
  await app.getByTestId('palette-input').fill('export project');
  await app.getByTestId('palette-result-0').click();
  await expect(app.getByRole('dialog', { name: 'Export Project' })).toBeVisible();
  await expect(app.getByText('pandoc 3.10')).toBeVisible();
  if (options.includeTheme !== true) {
    await app.getByRole('checkbox', { name: /Include current theme styling/ }).uncheck();
  }
}

async function runExport(app: Page) {
  await app.getByRole('button', { name: 'Export', exact: true }).click();
}

function failure(error: PandocFailure): string {
  return `${FAILURE_PREFIX}${JSON.stringify(error)}`;
}

test.describe('[contract] Export dialog Pandoc diagnostics', () => {
  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('shows the executable path that discovery actually resolved', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await openExportDialog(app);

    await expect(app.getByText('/opt/pandoc-3.10/bin/pandoc', { exact: true })).toBeVisible();
    await expect(app.getByText('pandoc', { exact: true })).toHaveCount(0);
  });

  test('maps missing-binary discovery details to actionable safe guidance', async ({ app }) => {
    await configureExport(app, {
      error: failure({
        stage: 'discovery',
        message: 'Pandoc not found.',
        format: 'html',
        probed_paths: ['/configured/pandoc', '/opt/homebrew/bin/pandoc'],
      }),
    });
    await openExportDialog(app);
    await runExport(app);

    const status = app.getByTestId('export-status-error');
    await expect(status).toContainText('Pandoc was not found');
    await expect(status).toContainText('Settings');
    await expect(status).toContainText('/configured/pandoc');
    await expect(status).not.toContainText('Pandoc discovery:');
  });

  test('maps timeout diagnostics without exposing internal stage tags', async ({ app }) => {
    await configureExport(app, {
      error: failure({
        stage: 'timeout_or_cancel',
        message: 'Pandoc exceeded the 120 second timeout.',
        resolved_binary: '/opt/pandoc-3.10/bin/pandoc',
        format: 'docx',
      }),
    });
    await openExportDialog(app);
    await app.getByRole('button', { name: 'DOCX (Word)' }).click();
    await runExport(app);

    const status = app.getByTestId('export-status-error');
    await expect(status).toContainText('Pandoc export timed out');
    await expect(status).toContainText('Format: DOCX');
    await expect(status).not.toContainText('timeout_or_cancel');
  });

  test('maps malformed input encoding, preserves CJK context, and redacts secrets', async ({ app }) => {
    const secret = 'SUPER_SECRET_TOKEN_123';
    await configureExport(app, {
      error: failure({
        stage: 'input_read',
        message: `failed to decode source text as GBK; token=${secret}`,
        format: 'epub',
        source_path: '/稿件/第一章-gbk.md',
      }),
    });
    await openExportDialog(app);
    await app.getByRole('button', { name: 'EPUB' }).click();
    await runExport(app);

    const status = app.getByTestId('export-status-error');
    await expect(status).toContainText('could not read or decode the export source');
    await expect(status).toContainText('/稿件/第一章-gbk.md');
    await expect(status).toContainText('token=<redacted>');
    await expect(status).not.toContainText(secret);
  });

  test('shows successful output with a structured cleanup warning', async ({ app }) => {
    await configureExport(app, {
      result: {
        message: 'Export complete: /mock/export.html',
        warning: {
          stage: 'cleanup',
          message: 'failed to remove temporary export resources: permission denied',
          resolved_binary: '/opt/pandoc-3.10/bin/pandoc',
          format: 'html',
          source_path: '/稿件/第一章.md',
        },
      },
    });
    await openExportDialog(app);
    await runExport(app);

    const status = app.getByTestId('export-status-warning');
    await expect(status).toContainText('Export complete: /mock/export.html');
    await expect(status).toContainText('temporary files could not be removed');
    await expect(status).toContainText('/稿件/第一章.md');
    await expect(app.getByTestId('export-status-error')).toHaveCount(0);
  });

  test('locks export options and preserves accepted pre-registration cancellation', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      const setCancelResponse = Reflect.get(state, 'setCancelExportProjectResponse');
      if (typeof setBlocked !== 'function' || typeof setCancelResponse !== 'function') {
        throw new Error('Export lifecycle mock controls unavailable');
      }
      setBlocked.call(state, true);
      setCancelResponse.call(state, true);
    });
    await openExportDialog(app);
    await runExport(app);

    await expect(app.getByRole('button', { name: 'HTML', exact: true })).toBeDisabled();
    await expect(app.getByRole('button', { name: 'DOCX (Word)' })).toBeDisabled();
    await expect(app.getByRole('checkbox', { name: /Include current theme styling/ })).toBeDisabled();

    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Cancelling...', exact: true })).toBeVisible();

    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      if (typeof setBlocked !== 'function') throw new Error('Export lifecycle mock controls unavailable');
      setBlocked.call(state, false);
    });
    await expect(app.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    await expect(app.getByTestId('export-status-success')).toHaveCount(0);
  });

  test('shows the committed result when cancellation is rejected during commit', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      const setCancelResponse = Reflect.get(state, 'setCancelExportProjectResponse');
      if (typeof setBlocked !== 'function' || typeof setCancelResponse !== 'function') {
        throw new Error('Export lifecycle mock controls unavailable');
      }
      setBlocked.call(state, true);
      setCancelResponse.call(state, false);
    });
    await openExportDialog(app);
    await runExport(app);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      if (typeof setBlocked !== 'function') throw new Error('Export lifecycle mock controls unavailable');
      setBlocked.call(state, false);
    });

    await expect(app.getByTestId('export-status-success')).toContainText('Export complete');
  });

  test('shows the committed result when the cancellation command fails', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      const setCancelResponse = Reflect.get(state, 'setCancelExportProjectResponse');
      if (typeof setBlocked !== 'function' || typeof setCancelResponse !== 'function') {
        throw new Error('Export lifecycle mock controls unavailable');
      }
      setBlocked.call(state, true);
      setCancelResponse.call(state, { error: 'cancel IPC unavailable' });
    });
    await openExportDialog(app);
    await runExport(app);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportProjectBlocked');
      if (typeof setBlocked !== 'function') throw new Error('Export lifecycle mock controls unavailable');
      setBlocked.call(state, false);
    });

    await expect(app.getByTestId('export-status-success')).toContainText('Export complete');
  });

  test('transfers request-owned theme CSS only for self-contained HTML', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await openExportDialog(app, { includeTheme: true });

    await runExport(app);
    await expect(app.getByTestId('export-status-success')).toContainText('Export complete');
    await app.getByRole('button', { name: 'EPUB' }).click();
    await expect(app.getByRole('checkbox', { name: /Include current theme styling/ })).toHaveCount(0);
    await runExport(app);
    await expect(app.getByTestId('export-status-success')).toContainText('Export complete');

    const calls = await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as { invokeCalls: Array<{ command: string; args: Record<string, unknown> }> };
      return state.invokeCalls.filter((call) => call.command === 'export_project');
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.args.format)).toEqual(['html', 'epub']);
    const htmlArgs = calls[0].args.extraArgs as string[];
    expect(htmlArgs[0]).toBe('--include-in-header');
    expect(htmlArgs[1]).toMatch(/novelist-export-theme-export-.*\.html$/);
    expect(calls[1].args.extraArgs).toEqual([]);
  });

  test('cancels during stylesheet staging before backend registration', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportCssWriteBlocked');
      const setCancelResponse = Reflect.get(state, 'setCancelExportProjectResponse');
      if (typeof setBlocked !== 'function' || typeof setCancelResponse !== 'function') {
        throw new Error('Export CSS lifecycle mock controls unavailable');
      }
      setBlocked.call(state, true);
      setCancelResponse.call(state, true);
    });
    await openExportDialog(app, { includeTheme: true });
    await runExport(app);

    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as Record<string, unknown>;
      const setBlocked = Reflect.get(state, 'setExportCssWriteBlocked');
      if (typeof setBlocked !== 'function') throw new Error('Export CSS lifecycle mock controls unavailable');
      setBlocked.call(state, false);
    });

    await expect(app.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
    const exportCalls = await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as { invokeCalls?: Array<{ command: string }> };
      return state.invokeCalls?.filter(call => call.command === 'export_project').length ?? -1;
    });
    expect(exportCalls).toBe(0);
  });

  test('owns preflight so rapid Export clicks dispatch exactly once', async ({ app }) => {
    await configureExport(app, {
      result: { message: 'Export complete: /mock/export.html' },
    });
    await openExportDialog(app, { includeTheme: false });
    const exportButton = app.getByRole('button', { name: 'Export', exact: true });

    await exportButton.evaluate((button) => {
      const exportControl = button as HTMLButtonElement;
      exportControl.click();
      exportControl.click();
    });

    await expect(app.getByTestId('export-status-success')).toContainText('Export complete');
    const exportCalls = await app.evaluate(() => {
      const state = Reflect.get(window, '__TAURI_MOCK_STATE__') as { invokeCalls?: Array<{ command: string }> };
      return state.invokeCalls?.filter((call) => call.command === 'export_project').length ?? -1;
    });
    expect(exportCalls).toBe(1);
  });
});
