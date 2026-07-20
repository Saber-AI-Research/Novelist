// @ts-expect-error Playwright runs specs in Node; the app tsconfig intentionally omits Node types.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, type MockInvokeCall } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';

const CANONICAL_MARKDOWN = readFileSync(
  new URL('../../fixtures/styled-copy/canonical.md', import.meta.url),
  'utf8',
);
const SUPPORTED_PANDOC_HTML = readFileSync(
  new URL('../../fixtures/styled-copy/supported.input.html', import.meta.url),
  'utf8',
);
const SELECTED_CJK = '未保存 SELECTED 文本';
const PANE_ONE_PREFIX = 'PANE_ONE_PREFIX\n\n';
const PANE_ONE_SUFFIX = '\n\nPANE_ONE_SUFFIX';
if (!CANONICAL_MARKDOWN.includes(SELECTED_CJK)) {
  throw new Error('Canonical Styled Copy fixture is missing the selected CJK marker');
}
const PANE_ONE_FULL_SOURCE = `${PANE_ONE_PREFIX}${SELECTED_CJK}${PANE_ONE_SUFFIX}`;
const PANE_TWO_SOURCE = '# PANE_TWO_GLOBAL_ACTIVE\n\n绝不能进入风格化复制。';
const CHAPTER_ONE_PATH = `${MOCK_PROJECT_DIR}/Chapter 1.md`;
const COVER_PATH = `${MOCK_PROJECT_DIR}/图片/封面 1.png`;
const RETRY_PATH = `${MOCK_PROJECT_DIR}/图片/重试.png`;
const DUPLICATE_REFERENCE_URL = 'https://example.com/章节';

const PNG_BYTES = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
  0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 248, 207, 192, 240,
  31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69,
  78, 68, 174, 66, 96, 130,
];
const GIF_BYTES = [
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0,
  255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0,
  1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
];

const CANONICAL_PANDOC_HTML = [
  `<p id="selected-source" class="source-copy" style="position:fixed" data-source="pane-1" onclick="alert(1)">${SELECTED_CJK}</p>`,
  SUPPORTED_PANDOC_HTML.replace(/<pre class="mermaid"[\s\S]*?<\/pre>/, ''),
  `<p><a href="${DUPLICATE_REFERENCE_URL}" class="duplicate-source">重复外链</a></p>`,
  '<p><img src="./图片/封面 1.png" alt="重复封面"><img src="./图片/重试.png" alt="失败重试图"></p>',
].join('\n');

interface StyledMockState {
  setPublishChannels(channels: []): Promise<void>;
  setStyledConversionBlocked(blocked: boolean): Promise<void>;
  setStyledConversionError(message: string | null): Promise<void>;
  setStyledConversionHtml(html: string | null): Promise<void>;
  setStyledImageResults(
    results: Record<string, { bytes: number[]; mime: string } | { error: string }>,
  ): Promise<void>;
  setStyledImageHostSettings(settings: {
    hosts: Array<Record<string, unknown>>;
    active_host_id: string | null;
    auto_on_paste: boolean;
  }): Promise<void>;
  setStyledUploadResults(
    results: Record<string, { url: string } | { error: string }>,
  ): Promise<void>;
  getInvokeCalls(): Promise<MockInvokeCall[]>;
}

interface PlatformKeys {
  pressMod(key: string): Promise<void>;
}

async function openChapter(app: Page): Promise<void> {
  const recentItem = app.getByTestId('recent-project-0');
  if (await recentItem.isVisible().catch(() => false)) {
    await recentItem.click();
    await app.getByTestId('sidebar').waitFor({ state: 'visible', timeout: 5000 });
  }
  await app.getByTestId('sidebar-file-Chapter 1.md').click();
  await app.locator('.cm-editor').waitFor({ state: 'visible', timeout: 5000 });
}

async function installPaneOneSelection(app: Page): Promise<void> {
  await app.evaluate(({ fullSource, selectedSource, prefixLength }) => {
    const view = (window as any).__novelist_view;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: fullSource },
      selection: { anchor: prefixLength, head: prefixLength + selectedSource.length },
    });
  }, {
    fullSource: PANE_ONE_FULL_SOURCE,
    selectedSource: SELECTED_CJK,
    prefixLength: PANE_ONE_PREFIX.length,
  });
}

async function makePaneTwoGloballyActive(app: Page, appKeys: PlatformKeys): Promise<void> {
  await app.getByTestId('sidebar-file-Chapter 2.md').click({ button: 'right' });
  await app.getByRole('menuitem', { name: 'Open in Other Pane' }).click();
  await expect(app.locator('.cm-editor')).toHaveCount(2);
  const paneTwoContent = app.locator('.cm-editor').nth(1).locator('.cm-content');
  await paneTwoContent.click();
  await appKeys.pressMod('a');
  await app.keyboard.insertText(PANE_TWO_SOURCE);
  await paneTwoContent.click();

  const activePaneId = await app.evaluate(async () => {
    const modulePath = '/app/lib/stores/tabs.svelte.ts';
    const module = await import(modulePath);
    module.tabsStore.setActivePane('pane-2');
    return module.tabsStore.activePaneId;
  });
  expect(activePaneId).toBe('pane-2');
}

async function configureCanonicalPipeline(mockState: StyledMockState): Promise<void> {
  await mockState.setStyledConversionError(null);
  await mockState.setStyledConversionBlocked(false);
  await mockState.setStyledConversionHtml(CANONICAL_PANDOC_HTML);
  await mockState.setStyledImageResults({
    [COVER_PATH]: { bytes: PNG_BYTES, mime: 'image/png' },
    [RETRY_PATH]: { bytes: GIF_BYTES, mime: 'image/gif' },
  });
  await mockState.setStyledImageHostSettings({
    hosts: [{ id: 'styled-host', name: 'Styled Host', provider: 'imgur', client_id: 'mock-client' }],
    active_host_id: 'styled-host',
    auto_on_paste: false,
  });
  await mockState.setStyledUploadResults({
    '封面 1.png': { url: 'https://uploads.example/cover.png' },
    '重试.png': { url: 'https://uploads.example/retry.gif' },
  });
}

async function openStyledCopy(app: Page, paneId = 'pane-1'): Promise<void> {
  await app.getByTestId(`share-menu-${paneId}`).click();
  await expect(app.getByTestId('share-styled-copy')).toBeVisible();
  await app.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
  await app.getByTestId('share-styled-copy').click();
  await expect(app.getByRole('dialog')).toBeVisible();
}

async function closePublishDialog(app: Page): Promise<void> {
  await app.getByLabel('Close publish dialog').click();
  await expect(app.getByRole('dialog')).toHaveCount(0);
}

async function expectPreviewReady(app: Page): Promise<string> {
  const preview = app.getByTestId('styled-copy-preview');
  await expect(app.getByTestId('styled-copy-copy')).toBeEnabled({ timeout: 15_000 });
  await expect(preview).toHaveAttribute('sandbox', '');
  await expect(preview).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(preview).not.toHaveAttribute('sandbox', /allow-scripts|allow-same-origin/);
  const srcdoc = await preview.getAttribute('srcdoc');
  expect(srcdoc?.trim().length).toBeGreaterThan(200);
  await expect(app.frameLocator('[data-testid="styled-copy-preview"]').locator('body')).not.toHaveText('');
  return srcdoc!;
}

async function expectDialogGeometry(app: Page): Promise<{ width: number; height: number }> {
  const metrics = await app.getByRole('dialog').evaluate((dialog) => {
    const dialogRect = dialog.getBoundingClientRect();
    const visible = Array.from(dialog.querySelectorAll(
      'button, select, iframe, .controls > fieldset, .controls > .messages',
    )).filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    });
    const overlaps: string[] = [];
    for (let left = 0; left < visible.length; left += 1) {
      for (let right = left + 1; right < visible.length; right += 1) {
        const a = visible[left];
        const b = visible[right];
        if (a.contains(b) || b.contains(a)) continue;
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        if (ar.left < br.right && ar.right > br.left && ar.top < br.bottom && ar.bottom > br.top) {
          overlaps.push(`${a.tagName}:${a.getAttribute('data-testid') ?? a.className}|${b.tagName}:${b.getAttribute('data-testid') ?? b.className}`);
        }
      }
    }
    const copyRect = dialog.querySelector('[data-testid="styled-copy-copy"]')!.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      dialogLeft: dialogRect.left,
      dialogRight: dialogRect.right,
      dialogTop: dialogRect.top,
      dialogBottom: dialogRect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      overlaps,
      copyWidth: copyRect.width,
      copyHeight: copyRect.height,
    };
  });
  expect(metrics.documentOverflow).toBe(false);
  expect(metrics.dialogOverflow).toBe(false);
  expect(metrics.dialogLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.dialogRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.dialogTop).toBeGreaterThanOrEqual(0);
  expect(metrics.dialogBottom).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.overlaps).toEqual([]);
  expect(metrics.copyWidth).toBe(112);
  expect(metrics.copyHeight).toBe(32);
  return { width: metrics.copyWidth, height: metrics.copyHeight };
}

async function captureViewportScreenshot(
  app: Page,
  path: string,
  width: number,
  height: number,
): Promise<void> {
  expect(app.viewportSize()).toEqual({ width, height });
  await app.screenshot({ path, scale: 'css' });
}

function commandCalls(calls: MockInvokeCall[], command: string): MockInvokeCall[] {
  return calls.filter((call) => call.command === command);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function assertSecureClipboardPayload(call: MockInvokeCall): void {
  const html = String(call.args.html);
  const plainText = String(call.args.plainText);
  expect(html).toContain(SELECTED_CJK);
  expect(plainText).toContain(SELECTED_CJK);
  expect(html).toContain('<table');
  expect(html).toContain('>const</span>');
  expect(html).toContain('章节');
  expect(html).toContain('unknown()');
  const unknownMarker = html.indexOf('unknown()');
  const unknownBlockStart = html.lastIndexOf('<pre', unknownMarker);
  const unknownBlockEnd = html.indexOf('</pre>', unknownMarker);
  expect(unknownBlockStart).toBeGreaterThanOrEqual(0);
  expect(unknownBlockEnd).toBeGreaterThan(unknownMarker);
  expect(html.slice(unknownBlockStart, unknownBlockEnd)).not.toContain('<span');
  expect(html).toContain('脚注内容');
  expect(html).toContain('<mark');
  expect(html).toContain('\\(E=mc^2\\)');
  expect(html).toContain('\\[x = y + 1\\]');
  expect(html).toContain('引用链接');
  expect(occurrences(html, `href="${DUPLICATE_REFERENCE_URL}"`)).toBe(1);
  expect(occurrences(plainText, DUPLICATE_REFERENCE_URL)).toBe(1);
  expect(html).not.toMatch(/<(?:script|style|iframe|frame|form|object|svg|template)\b/i);
  expect(html).not.toMatch(/\s(?:class|id|data-[\w-]+|on\w+|srcset|name)=/i);
  expect(html).not.toMatch(/(?:javascript|file|data|blob):/i);
  expect(html).not.toContain('position:fixed');
  expect(html).not.toContain('color:red');
  expect(html).not.toContain('sourceCode');
  expect(html).not.toMatch(/src="(?:\.|\/|[A-Za-z]:\\)/);
  const imageUrls = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  expect(imageUrls).toHaveLength(3);
  expect(imageUrls.every((url) => url.startsWith('https://'))).toBe(true);
}

async function setStyledClipboardError(app: Page, message: string | null): Promise<void> {
  await app.evaluate((value) => {
    const state = (window as any).__TAURI_MOCK_STATE__;
    if (typeof state?.setStyledClipboardError !== 'function') {
      throw new Error('Styled clipboard error control unavailable');
    }
    state.setStyledClipboardError(value);
  }, message);
}

async function installSanitizerFault(app: Page): Promise<void> {
  await app.evaluate(() => {
    const original = Element.prototype.setAttribute;
    (window as any).__TASK8_RESTORE_SET_ATTRIBUTE__ = original;
    Element.prototype.setAttribute = function setAttribute(name: string, value: string) {
      if (this.tagName === 'SECTION' && name === 'style') {
        throw new Error('task-8 generated sanitizer fault');
      }
      return original.call(this, name, value);
    };
  });
}

async function restoreSanitizerFault(app: Page): Promise<void> {
  await app.evaluate(() => {
    const original = (window as any).__TASK8_RESTORE_SET_ATTRIBUTE__;
    if (typeof original === 'function') Element.prototype.setAttribute = original;
    delete (window as any).__TASK8_RESTORE_SET_ATTRIBUTE__;
  });
}

test.describe('[contract] Styled Copy complete browser and security matrix', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ app, mockState }) => {
    await app.setViewportSize({ width: 1280, height: 800 });
    await mockState.setPublishChannels([]);
    await openChapter(app);
    await installPaneOneSelection(app);
    await configureCanonicalPipeline(mockState);
    await app.route('https://uploads.example/**', (route) => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: PNG_BYTES,
    }));
  });

  test.afterEach(async ({ browserErrors }) => {
    expect(browserErrors).toEqual([]);
  });

  test('matches generated Rope, styled conversion, safe-read, upload, and clipboard IPC fields', async ({ app, mockState }) => {
    const results = await app.evaluate(async ({ selected, projectDir }) => {
      const modulePath = '/app/lib/ipc/commands.ts';
      const { commands } = await import(modulePath);
      return {
        rope: await commands.ropeSnapshot('task-8-rope'),
        conversion: await commands.convertMarkdownToStyledHtml(selected),
        image: await commands.readStyledCopyImage(`${projectDir}/图片/封面 1.png`, [projectDir]),
        upload: await commands.uploadImageImgur(
          [137, 80, 78, 71],
          'contract.png',
          'image/png',
          { provider: 'imgur', client_id: 'mock-client' },
        ),
        clipboard: await commands.writeStyledClipboard('<section><p>合同</p></section>', '合同'),
      };
    }, { selected: SELECTED_CJK, projectDir: MOCK_PROJECT_DIR });

    expect(results.rope).toEqual({
      status: 'ok',
      data: { text: 'Mock Rope snapshot\n', generation: 7, total_lines: 2, total_chars: 19 },
    });
    expect(results.conversion.status).toBe('ok');
    expect(results.image).toEqual({ status: 'ok', data: { bytes: PNG_BYTES, mime: 'image/png' } });
    expect(results.upload.status).toBe('ok');
    expect(results.clipboard).toEqual({ status: 'ok', data: null });

    const calls = await mockState.getInvokeCalls();
    expect(commandCalls(calls, 'rope_snapshot').at(-1)?.args).toEqual({ fileId: 'task-8-rope' });
    expect(commandCalls(calls, 'convert_markdown_to_styled_html').at(-1)?.args).toEqual({ markdown: SELECTED_CJK });
    expect(commandCalls(calls, 'read_styled_copy_image').at(-1)?.args).toEqual({
      path: COVER_PATH,
      allowedRoots: [MOCK_PROJECT_DIR],
    });
    expect(commandCalls(calls, 'upload_image_imgur').at(-1)?.args).toMatchObject({
      bytes: [137, 80, 78, 71],
      filename: 'contract.png',
      mime: 'image/png',
      config: { provider: 'imgur', client_id: 'mock-client' },
    });
    expect(commandCalls(calls, 'write_styled_clipboard').at(-1)?.args).toEqual({
      html: '<section><p>合同</p></section>',
      plainText: '合同',
    });
  });

  test('isolates pane 1, covers scope/themes/targets/link modes, and serializes a secure payload', async ({ app, appKeys, mockState }) => {
    await openStyledCopy(app);
    await expectPreviewReady(app);
    await app.getByTestId('styled-scope-full').check();
    await expectPreviewReady(app);
    await expect.poll(async () => commandCalls(
      await mockState.getInvokeCalls(),
      'convert_markdown_to_styled_html',
    ).some((call) => call.args.markdown === PANE_ONE_FULL_SOURCE)).toBe(true);
    await app.getByTestId('styled-scope-selection').check();
    await expectPreviewReady(app);
    await closePublishDialog(app);

    await makePaneTwoGloballyActive(app, appKeys);
    await openStyledCopy(app, 'pane-1');

    let srcdoc = await expectPreviewReady(app);
    expect(srcdoc).toContain(SELECTED_CJK);
    expect(srcdoc).toContain('引用链接');
    expect(occurrences(srcdoc, `href="${DUPLICATE_REFERENCE_URL}"`)).toBe(1);
    const readyCopyBounds = await expectDialogGeometry(app);
    expect(commandCalls(await mockState.getInvokeCalls(), 'upload_image_imgur')).toHaveLength(0);
    await captureViewportScreenshot(
      app,
      'test-results/styled-copy/wechat-minimal.png',
      1280,
      800,
    );

    await app.getByTestId('styled-theme-magazine').check();
    await expect(app.getByTestId('styled-copy-preview')).toHaveAttribute('srcdoc', /#9f3434/);
    await expectPreviewReady(app);
    await captureViewportScreenshot(
      app,
      'test-results/styled-copy/wechat-magazine.png',
      1280,
      800,
    );

    await app.getByTestId('styled-theme-technical').check();
    await expect(app.getByTestId('styled-copy-preview')).toHaveAttribute('srcdoc', /#2563eb/);
    await expectPreviewReady(app);
    await captureViewportScreenshot(
      app,
      'test-results/styled-copy/wechat-technical.png',
      1280,
      800,
    );

    await app.getByTestId('styled-link-mode').selectOption('anchors');
    await expect.poll(async () => (await app.getByTestId('styled-copy-preview').getAttribute('srcdoc')) ?? '')
      .not.toContain('引用链接');
    srcdoc = (await app.getByTestId('styled-copy-preview').getAttribute('srcdoc'))!;
    expect(occurrences(srcdoc, `href="${DUPLICATE_REFERENCE_URL}"`)).toBeGreaterThanOrEqual(2);

    await app.getByTestId('styled-link-mode').selectOption('target-default');
    await app.getByTestId('styled-target-zhihu').check();
    await expect(app.getByTestId('styled-theme-minimal')).toHaveCount(0);
    await expect(app.getByTestId('styled-link-mode')).toHaveValue('target-default');
    await expect(app.getByTestId('styled-link-mode').locator('option:checked')).toHaveText('Target default (Anchors)');
    srcdoc = await expectPreviewReady(app);
    expect(srcdoc).not.toContain('引用链接');
    expect(occurrences(srcdoc, `href="${DUPLICATE_REFERENCE_URL}"`)).toBeGreaterThanOrEqual(2);
    await expect(app.getByTestId('styled-copy-preview')).toHaveAttribute('srcdoc', /#245ea8/);
    await captureViewportScreenshot(app, 'test-results/styled-copy/zhihu.png', 1280, 800);

    await app.getByTestId('styled-link-mode').selectOption('end-references');
    await expect.poll(async () => (await app.getByTestId('styled-copy-preview').getAttribute('srcdoc')) ?? '')
      .toContain('引用链接');
    srcdoc = (await app.getByTestId('styled-copy-preview').getAttribute('srcdoc'))!;
    expect(occurrences(srcdoc, `href="${DUPLICATE_REFERENCE_URL}"`)).toBe(1);

    await app.getByTestId('styled-target-wechat').check();
    await app.getByTestId('styled-theme-minimal').check();
    await app.getByTestId('styled-link-mode').selectOption('target-default');
    await expectPreviewReady(app);
    expect(commandCalls(await mockState.getInvokeCalls(), 'upload_image_imgur')).toHaveLength(0);

    const copyButton = app.getByTestId('styled-copy-copy');
    await copyButton.click();
    await expect(copyButton).toContainText('Copied');
    expect(await expectDialogGeometry(app)).toEqual(readyCopyBounds);

    const calls = await mockState.getInvokeCalls();
    const conversions = commandCalls(calls, 'convert_markdown_to_styled_html');
    expect(conversions[0]?.args.markdown).toBe(SELECTED_CJK);
    expect(conversions.some((call) => call.args.markdown === PANE_ONE_FULL_SOURCE)).toBe(true);
    expect(conversions.every((call) => !String(call.args.markdown).includes('PANE_TWO_GLOBAL_ACTIVE'))).toBe(true);
    const uploads = commandCalls(calls, 'upload_image_imgur');
    expect(uploads).toHaveLength(2);
    expect(uploads.map((call) => call.args.filename).sort()).toEqual(['封面 1.png', '重试.png'].sort());
    const clipboardCalls = commandCalls(calls, 'write_styled_clipboard');
    expect(clipboardCalls).toHaveLength(1);
    assertSecureClipboardPayload(clipboardCalls[0]);
    await expect(app.getByText('Math remains readable TeX on this target.')).toHaveCount(1);
    await expect(app.getByText('Some table structure was simplified for this target.')).toHaveCount(1);
  });

  test('uploads no preview assets, deduplicates Copy, and retries only the failed hash', async ({ app, mockState }) => {
    await mockState.setStyledUploadResults({
      '封面 1.png': { url: 'https://uploads.example/cover.png' },
      '重试.png': { error: 'temporary provider failure' },
    });
    await openStyledCopy(app);
    await expectPreviewReady(app);
    expect(commandCalls(await mockState.getInvokeCalls(), 'upload_image_imgur')).toHaveLength(0);

    await app.getByTestId('styled-copy-copy').click();
    await expect(app.getByTestId('styled-copy-error')).toContainText('Some assets could not be uploaded');
    let calls = await mockState.getInvokeCalls();
    expect(commandCalls(calls, 'upload_image_imgur')).toHaveLength(2);
    expect(commandCalls(calls, 'write_styled_clipboard')).toHaveLength(0);

    await mockState.setStyledUploadResults({
      '封面 1.png': { url: 'https://uploads.example/cover.png' },
      '重试.png': { url: 'https://uploads.example/retry.gif' },
    });
    await app.getByTestId('styled-link-mode').selectOption('anchors');
    await expectPreviewReady(app);
    await app.getByTestId('styled-copy-copy').click();
    await expect(app.getByTestId('styled-copy-copy')).toContainText('Copied');

    calls = await mockState.getInvokeCalls();
    const uploadFilenames = commandCalls(calls, 'upload_image_imgur').map((call) => call.args.filename);
    expect(uploadFilenames).toHaveLength(3);
    expect(uploadFilenames.filter((filename) => filename === '封面 1.png')).toHaveLength(1);
    expect(uploadFilenames.filter((filename) => filename === '重试.png')).toHaveLength(2);
    expect(commandCalls(calls, 'write_styled_clipboard')).toHaveLength(1);
  });

  test('blocks missing Pandoc/extensions, unsafe images, Mermaid failure, and sanitizer failure', async ({ app, mockState }) => {
    await app.setViewportSize({ width: 900, height: 700 });
    await mockState.setStyledConversionError('pandoc_not_found');
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-error')).toContainText('Settings > Publish');
    const errorCopyBounds = await expectDialogGeometry(app);
    await captureViewportScreenshot(app, 'test-results/styled-copy/compact.png', 900, 700);
    await closePublishDialog(app);

    await mockState.setStyledConversionError('unsupported_pandoc_extensions: mark, footnotes');
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-error')).toContainText('mark, footnotes');
    expect(await expectDialogGeometry(app)).toEqual(errorCopyBounds);
    await closePublishDialog(app);

    await mockState.setStyledConversionError(null);
    await mockState.setStyledConversionHtml('<p>不安全图片</p><img src="../escape.png" alt="escape">');
    await mockState.setStyledImageResults({
      [`${MOCK_PROJECT_DIR}/../escape.png`]: { error: 'unsafe_asset' },
    });
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-error')).toContainText('Some assets could not be prepared');
    expect(await expectDialogGeometry(app)).toEqual(errorCopyBounds);
    await closePublishDialog(app);

    const oversizedMermaid = 'x'.repeat(50_001);
    await mockState.setStyledConversionHtml(`<pre class="mermaid"><code>${oversizedMermaid}</code></pre>`);
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-error')).toContainText('Diagram source is too large');
    expect(await expectDialogGeometry(app)).toEqual(errorCopyBounds);
    await closePublishDialog(app);

    await mockState.setStyledConversionHtml(`<p>${SELECTED_CJK}</p>`);
    await installSanitizerFault(app);
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-error')).toContainText('Generated content failed safety checks');
    await restoreSanitizerFault(app);
    expect(await expectDialogGeometry(app)).toEqual(errorCopyBounds);

    const calls = await mockState.getInvokeCalls();
    expect(commandCalls(calls, 'read_styled_copy_image').some((call) => (
      call.args.path === `${MOCK_PROJECT_DIR}/../escape.png`
      && JSON.stringify(call.args.allowedRoots) === JSON.stringify([MOCK_PROJECT_DIR])
    ))).toBe(true);
    expect(commandCalls(calls, 'write_styled_clipboard')).toHaveLength(0);
  });

  test('blocks invalid hosted URLs and stale generations before clipboard mutation', async ({ app, mockState }) => {
    await mockState.setStyledConversionHtml(`<p>${SELECTED_CJK}</p><img src="./图片/重试.png" alt="retry">`);
    await mockState.setStyledImageResults({
      [RETRY_PATH]: { bytes: GIF_BYTES, mime: 'image/gif' },
    });
    await mockState.setStyledUploadResults({
      '重试.png': { url: 'http://unsafe.example/retry.gif' },
    });
    await openStyledCopy(app);
    await expectPreviewReady(app);
    await app.getByTestId('styled-copy-copy').click();
    await expect(app.getByTestId('styled-copy-error')).toContainText('unsafe URL');
    expect(commandCalls(await mockState.getInvokeCalls(), 'write_styled_clipboard')).toHaveLength(0);
    await closePublishDialog(app);

    await mockState.setStyledConversionHtml(`<p>${SELECTED_CJK}</p>`);
    await mockState.setStyledConversionBlocked(true);
    await openStyledCopy(app);
    await expect(app.getByTestId('styled-copy-copy')).toContainText('Converting');
    await app.evaluate(() => {
      const view = (window as any).__novelist_view;
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\nSTALE_AFTER_CAPTURE' } });
    });
    await mockState.setStyledConversionBlocked(false);
    await expect(app.getByTestId('styled-copy-error')).toContainText('The document changed');
    expect(commandCalls(await mockState.getInvokeCalls(), 'write_styled_clipboard')).toHaveLength(0);
  });

  test('sanitizes malicious Pandoc HTML and localizes clipboard OS failure without false success', async ({ app, mockState }) => {
    const malicious = [
      `<p id="source-id" class="source-class" style="position:fixed" data-secret="x" onclick="alert(1)">${SELECTED_CJK}`,
      '<a href="javascript:alert(1)">危险链接一</a><a href="javascript:alert(1)">危险链接二</a>',
      '<a href="https://safe.example/文章" class="safe-source">安全链接</a></p>',
      '<script>DROP_SCRIPT</script><iframe src="https://evil.example">DROP_FRAME</iframe>',
      '<svg onload="alert(1)"><text>DROP_SVG</text></svg>',
    ].join('');
    await mockState.setStyledConversionHtml(malicious);
    await openStyledCopy(app);
    const preview = await expectPreviewReady(app);
    expect(preview).toContain(SELECTED_CJK);
    expect(preview).not.toMatch(/DROP_SCRIPT|DROP_FRAME|<svg|onload=|javascript:|position:fixed|source-class/);
    await expect(app.getByText('An unsupported link was converted to text.')).toHaveCount(1);
    await app.getByTestId('styled-copy-copy').click();
    await expect(app.getByTestId('styled-copy-copy')).toContainText('Copied');
    let calls = await mockState.getInvokeCalls();
    const successfulClipboard = commandCalls(calls, 'write_styled_clipboard');
    expect(successfulClipboard).toHaveLength(1);
    const successfulHtml = String(successfulClipboard[0].args.html);
    expect(successfulHtml).toContain(SELECTED_CJK);
    expect(successfulHtml).not.toMatch(/DROP_SCRIPT|DROP_FRAME|<svg|onload=|javascript:|position:fixed|source-class/);
    await closePublishDialog(app);

    await mockState.setStyledConversionHtml(`<p>${SELECTED_CJK}</p>`);
    await setStyledClipboardError(app, 'native clipboard permission detail');
    await openStyledCopy(app);
    await expectPreviewReady(app);
    await app.getByTestId('styled-copy-copy').click();
    await expect(app.getByTestId('styled-copy-error')).toContainText('Could not write styled content to the clipboard');
    await expect(app.getByTestId('styled-copy-error')).not.toContainText('native clipboard permission detail');
    await expect(app.getByTestId('styled-copy-copy')).not.toContainText('Copied');
    calls = await mockState.getInvokeCalls();
    expect(commandCalls(calls, 'write_styled_clipboard')).toHaveLength(2);
  });
});
