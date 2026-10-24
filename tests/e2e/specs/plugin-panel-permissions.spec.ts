import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/app-fixture';
import { MOCK_PROJECT_DIR } from '../fixtures/mock-data';
import type { PluginInfo } from '../../../app/lib/ipc/commands';
import { PLUGIN_CONNECT_TYPE } from '../../../app/lib/services/plugin-host-channel';

/**
 * [regression] Panel plugins receive the active document only when their
 * manifest grants `read` (PluginPanel.svelte). A panel without it still gets
 * theme updates over its host port, but never manuscript text.
 */

const CHAPTER_PATH = `${MOCK_PROJECT_DIR}/Chapter 1.md`;

function probePlugin(id: string, label: string, permissions: string[]): PluginInfo {
  return {
    id,
    name: label,
    version: '1.0.0',
    permissions,
    active: false,
    ui: { type: 'panel', entry: 'index.html', label, width: 320, requires_app_reload: false },
    description: null,
    author: null,
    icon: null,
    builtin: false,
    enabled: true,
  };
}

const PROBES = [
  probePlugin('probe-reader', 'Probe Reader', ['read', 'ui']),
  probePlugin('probe-blind', 'Probe Blind', ['ui']),
];

/** Records every host message type it receives on its port. */
const PROBE_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  window.received = [];
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== ${JSON.stringify(PLUGIN_CONNECT_TYPE)}) return;
    event.ports[0].onmessage = (message) => window.received.push(message.data);
  });
</script></body></html>`;

async function installProbePanels(app: Page) {
  await app.route('**/plugin-probe/*.html', (route) => route.fulfill({ contentType: 'text/html', body: PROBE_PAGE }));
  await app.addInitScript((probes) => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__');
    if (!internals) return;
    const invoke = Reflect.get(internals, 'invoke') as (...args: unknown[]) => Promise<unknown>;
    Reflect.set(internals, 'invoke', async (command: string, ...rest: unknown[]) => {
      const result = await invoke.call(internals, command, ...rest);
      return command === 'list_plugins' ? [...(result as unknown[]), ...probes] : result;
    });
    const convertFileSrc = Reflect.get(internals, 'convertFileSrc') as (path: string, protocol?: string) => string;
    Reflect.set(internals, 'convertFileSrc', (path: string, protocol?: string) => {
      const probe = /\/plugins\/(probe-[a-z-]+)\/index\.html$/.exec(path);
      return probe ? `/plugin-probe/${probe[1]}.html` : convertFileSrc.call(internals, path, protocol);
    });
  }, PROBES);
  await app.reload();
  await app.waitForSelector('#app > *');
}

async function receivedBy(app: Page, label: string): Promise<Array<Record<string, unknown>>> {
  const frame = await (await app.locator(`iframe[title="${label}"]`).elementHandle())?.contentFrame();
  if (!frame) return [];
  return frame.evaluate(() => Reflect.get(window, 'received') as Array<Record<string, unknown>>);
}

async function callTestApi(app: Page, name: string, arg: string) {
  await app.evaluate(([method, value]) => {
    const api = Reflect.get(window, '__test_api__') as Record<string, (arg: string) => unknown>;
    return api[method](value);
  }, [name, arg] as const);
}

test('[regression] only panels granted `read` receive document content', async ({ app }) => {
  await installProbePanels(app);
  await callTestApi(app, 'openProject', MOCK_PROJECT_DIR);
  await callTestApi(app, 'openFile', CHAPTER_PATH);
  await expect(app.getByTestId('tab-Chapter 1.md')).toBeVisible();

  await app.getByTestId('panel-toggle-probe-reader').click();
  await expect.poll(async () => (await receivedBy(app, 'Probe Reader')).map((message) => message.type))
    .toEqual(expect.arrayContaining(['content-update', 'theme-update']));
  const reader = await receivedBy(app, 'Probe Reader');
  expect(reader.find((message) => message.type === 'content-update')?.content)
    .toContain('It was a dark and stormy night.');

  await app.getByTestId('panel-toggle-probe-blind').click();
  // content-update is posted before theme-update on connect, so once the
  // theme arrived any document text would have arrived first.
  await expect.poll(async () => (await receivedBy(app, 'Probe Blind')).map((message) => message.type))
    .toContain('theme-update');
  expect((await receivedBy(app, 'Probe Blind')).map((message) => message.type))
    .not.toContain('content-update');
});
