import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';

const FULL_SOURCE = '# 冻结全文\n\n前文 未保存选择文本 后文';
const SELECTED_SOURCE = '未保存选择文本';
const GHOST_CHANNEL = {
  id: 'ghost-main',
  name: 'Editorial Ghost',
  platform: 'ghost' as const,
  admin_url: 'https://ghost.example',
  api_key: 'mock-key',
};

async function openChapter(app: Page) {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
}

async function installFrozenSelection(app: Page) {
  await app.evaluate(({ fullSource, selectedSource }) => {
    const view = (window as any).__novelist_view;
    const from = fullSource.indexOf(selectedSource);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: fullSource },
      selection: { anchor: from, head: from + selectedSource.length },
    });
  }, { fullSource: FULL_SOURCE, selectedSource: SELECTED_SOURCE });
}

async function openStyledCopy(app: Page) {
  await app.getByTestId('share-menu-pane-1').click();
  await app.getByTestId('share-styled-copy').click();
  await expect(app.getByRole('dialog')).toBeVisible();
}

async function expectDialogFitsViewport(app: Page) {
  const metrics = await app.getByRole('dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    const controls = Array.from(dialog.querySelectorAll(
      '.controls > fieldset, .controls > .select-field, .controls > .messages, .controls > .copy-button',
    )).map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
    let controlOverlaps = 0;
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left];
        const b = controls[right];
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
          controlOverlaps += 1;
        }
      }
    }
    const controlsColumn = dialog.querySelector('.controls')?.getBoundingClientRect();
    const preview = dialog.querySelector('.preview-region')?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      controlOverlaps,
      columnsOverlap: Boolean(
        controlsColumn
          && preview
          && controlsColumn.left < preview.right
          && controlsColumn.right > preview.left
          && controlsColumn.top < preview.bottom
          && controlsColumn.bottom > preview.top,
      ),
    };
  });
  expect(metrics.documentOverflow).toBe(false);
  expect(metrics.dialogOverflow).toBe(false);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.top).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.controlOverlaps).toBe(0);
  expect(metrics.columnsOverlap).toBe(false);
}

test.describe('[contract] Styled Copy publish dialog UI', () => {
  test.beforeEach(async ({ app, mockState }) => {
    await app.setViewportSize({ width: 1280, height: 800 });
    await mockState.setPublishChannels([]);
    await openChapter(app);
    await installFrozenSelection(app);
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('is available without channels and copies the frozen selected source through safe controls', async ({ app, mockState }) => {
    await app.getByTestId('share-menu-pane-1').click();
    await expect(app.getByTestId('share-styled-copy')).toBeVisible();
    await expect(app.getByText(/No publish channels configured/)).toBeVisible();
    await app.getByTestId('share-styled-copy').click();

    await expect(app.getByTestId('publish-mode-styled')).toBeChecked();
    await expect(app.getByTestId('styled-target-wechat')).toBeChecked();
    await expect(app.getByTestId('styled-scope-selection')).toBeChecked();
    await expect(app.getByTestId('styled-scope-full')).toBeEnabled();
    await expect(app.getByTestId('styled-theme-minimal')).toBeChecked();
    await expect(app.getByTestId('styled-link-mode')).toHaveValue('target-default');
    await expect(app.getByTestId('styled-link-mode').locator('option:checked')).toHaveText('Target default (End references)');

    const preview = app.getByTestId('styled-copy-preview');
    await expect(preview).toHaveAttribute('sandbox', '');
    await expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(preview).toHaveAttribute('srcdoc', /未保存选择文本/);
    await expect(preview).not.toHaveAttribute('sandbox', /allow-scripts|allow-same-origin/);

    await app.getByTestId('publish-mode-online').check();
    await expect(app.getByText(/No publish channels configured/)).toBeVisible();
    await app.getByTestId('publish-mode-styled').check();
    await expect(app.getByTestId('styled-target-wechat')).toBeChecked();

    await app.getByTestId('styled-scope-full').check();
    await expect(preview).toHaveAttribute('srcdoc', /冻结全文/);
    await app.getByTestId('styled-scope-selection').check();
    await expect(preview).toHaveAttribute('srcdoc', /未保存选择文本/);

    await app.getByTestId('styled-target-zhihu').check();
    await expect(app.getByTestId('styled-theme-minimal')).toHaveCount(0);
    await expect(app.getByTestId('styled-link-mode').locator('option:checked')).toHaveText('Target default (Anchors)');
    await app.getByTestId('styled-target-wechat').check();
    await app.getByTestId('styled-theme-technical').check();
    await app.getByTestId('styled-link-mode').selectOption('end-references');
    await app.getByTestId('styled-target-zhihu').check();
    await expect(app.getByTestId('styled-link-mode')).toHaveValue('end-references');
    await app.getByTestId('styled-target-wechat').check();

    const copyButton = app.getByTestId('styled-copy-copy');
    await expect(copyButton).toBeEnabled();
    const before = await copyButton.boundingBox();
    await copyButton.click();
    await expect(copyButton).toContainText('Copied');
    const after = await copyButton.boundingBox();
    expect(after).toEqual(before);

    const calls = await mockState.getInvokeCalls();
    const styledConversions = calls.filter((call) => call.command === 'convert_markdown_to_styled_html');
    expect(styledConversions[0]?.args.markdown).toBe(SELECTED_SOURCE);
    expect(styledConversions.some((call) => call.args.markdown === FULL_SOURCE)).toBe(true);
    const clipboardCalls = calls.filter((call) => call.command === 'write_styled_clipboard');
    expect(clipboardCalls).toHaveLength(1);
    expect(String(clipboardCalls[0].args.html)).toContain(SELECTED_SOURCE);
    expect(String(clipboardCalls[0].args.plainText)).toContain(SELECTED_SOURCE);
    expect(calls.some((call) => call.command.startsWith('publish_to_'))).toBe(false);
    expect(calls.some((call) => call.command === 'write_publish_form_draft')).toBe(false);

    await expectDialogFitsViewport(app);
  });

  test('shows blocking Pandoc guidance and cancels pending conversion on close at compact size', async ({ app, mockState }) => {
    await app.setViewportSize({ width: 900, height: 700 });
    await mockState.setStyledConversionError('pandoc_not_found');
    await openStyledCopy(app);

    await expect(app.getByTestId('styled-copy-error')).toContainText('Settings > Publish');
    await expect(app.getByTestId('styled-copy-copy')).toBeDisabled();
    await expectDialogFitsViewport(app);

    await mockState.setStyledConversionError(null);
    await mockState.setStyledConversionBlocked(true);
    await app.getByTestId('styled-target-zhihu').check();
    await expect(app.getByTestId('styled-copy-copy')).toBeDisabled();
    await expect(app.getByTestId('styled-copy-copy')).toContainText('Converting…');
    await app.locator('.modal-backdrop').click({ position: { x: 8, y: 8 } });
    await expect(app.getByRole('dialog')).toHaveCount(0);
    await mockState.setStyledConversionBlocked(false);
    await app.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await expect(app.getByRole('dialog')).toHaveCount(0);

    const calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'write_styled_clipboard')).toHaveLength(0);
  });

  test('forces full-document scope when the frozen source has no selection', async ({ app }) => {
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ selection: { anchor: 0 } });
    });

    await openStyledCopy(app);

    await expect(app.getByTestId('styled-scope-selection')).toBeDisabled();
    await expect(app.getByTestId('styled-scope-full')).toBeChecked();
  });

  test('keeps the frozen live source across channel mode changes and lazily loads Online from disk', async ({ app, mockState }) => {
    await mockState.setPublishChannels([GHOST_CHANNEL]);
    await app.getByTestId('share-menu-pane-1').click();
    await app.getByRole('menuitem', { name: /Publish to Editorial Ghost/ }).click();
    await expect(app.getByTestId('publish-mode-online')).toBeChecked();

    await app.getByTestId('publish-mode-styled').check();
    await expect(app.getByTestId('styled-copy-preview')).toHaveAttribute('srcdoc', /未保存选择文本/);
    let calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'convert_markdown_to_styled_html').at(-1)?.args.markdown).toBe(SELECTED_SOURCE);

    await app.getByLabel('Close publish dialog').click();
    await openStyledCopy(app);
    const readsBeforeSwitch = (await mockState.getInvokeCalls()).filter((call) => call.command === 'read_file').length;
    await app.getByTestId('publish-mode-online').check();
    await expect(app.getByText('Editorial Ghost', { exact: true })).toBeVisible();
    calls = await mockState.getInvokeCalls();
    expect(calls.filter((call) => call.command === 'read_file')).toHaveLength(readsBeforeSwitch + 1);
  });
});
