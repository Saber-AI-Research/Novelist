import type { Frame, Page } from '@playwright/test';
import { PLUGIN_CONNECT_TYPE } from '../../../app/lib/services/plugin-host-channel';

/**
 * Plugin iframes are sandboxed into opaque origins and talk to the host only
 * over the MessagePort handed to each plugin document right after it loads
 * (`app/lib/services/plugin-host-channel.ts`, `plugins/host-channel.ts`).
 * These helpers let specs drive that channel.
 */

export type PluginMessage = Record<string, unknown>;
type PluginTarget = Page | Frame;

interface TestHost {
  port: MessagePort;
  received: PluginMessage[];
}

/**
 * Act as the Novelist host for a plugin page opened at top level: transfer a
 * port to the plugin and record everything it posts back. Call after the page
 * has loaded, exactly like the real host does on the iframe's load event.
 */
export async function connectPluginHost(target: PluginTarget): Promise<void> {
  await target.evaluate((connectType) => {
    const channel = new MessageChannel();
    const host = { port: channel.port1, received: [] as Record<string, unknown>[] };
    channel.port1.onmessage = (event: MessageEvent) => host.received.push(event.data);
    Reflect.set(window, '__NOVELIST_TEST_HOST__', host);
    window.postMessage({ type: connectType }, '*', [channel.port2]);
  }, PLUGIN_CONNECT_TYPE);
}

/** Post a host → plugin message over the port from `connectPluginHost`. */
export async function postToPlugin(target: PluginTarget, message: PluginMessage): Promise<void> {
  await target.evaluate((payload) => {
    (Reflect.get(window, '__NOVELIST_TEST_HOST__') as TestHost).port.postMessage(payload);
  }, message);
}

/** Every plugin → host message received by `connectPluginHost`'s port. */
export async function pluginMessages(target: PluginTarget): Promise<PluginMessage[]> {
  return target.evaluate(() => (Reflect.get(window, '__NOVELIST_TEST_HOST__') as TestHost).received);
}

/**
 * For plugins embedded by the real host: keep a handle on the port each
 * plugin document receives, so a spec can speak as the plugin
 * (`postAsPlugin`) and observe the host's replies (`capturePluginInbox`).
 * Applies to frames attached after the call.
 */
export async function exposePluginPorts(page: Page): Promise<void> {
  await page.addInitScript((connectType) => {
    window.addEventListener('message', (event) => {
      const offered = event.ports[0];
      if (event.source === window.parent && event.data?.type === connectType && offered) {
        Reflect.set(window, '__NOVELIST_PLUGIN_PORT__', offered);
      }
    });
  }, PLUGIN_CONNECT_TYPE);
}

/** Post a plugin → host message on the embedded plugin's own port. */
export async function postAsPlugin(frame: Frame, message: PluginMessage): Promise<void> {
  await frame.evaluate((payload) => {
    (Reflect.get(window, '__NOVELIST_PLUGIN_PORT__') as MessagePort).postMessage(payload);
  }, message);
}

/**
 * Start recording host → plugin messages of the given types on the embedded
 * plugin's port; read them with `pluginInbox`.
 */
export async function capturePluginInbox(frame: Frame, types: readonly string[]): Promise<void> {
  await frame.evaluate((wanted) => {
    const inbox: unknown[] = [];
    const port = Reflect.get(window, '__NOVELIST_PLUGIN_PORT__') as MessagePort;
    port.addEventListener('message', (event: MessageEvent) => {
      if (wanted.includes(event.data?.type)) inbox.push(event.data);
    });
    Reflect.set(window, '__NOVELIST_PLUGIN_INBOX__', inbox);
  }, [...types]);
}

export async function pluginInbox<T = PluginMessage>(frame: Frame): Promise<T[]> {
  return frame.evaluate(() => Reflect.get(window, '__NOVELIST_PLUGIN_INBOX__') as T[]);
}

/**
 * Sandboxed plugin frames request the dev server's modules with
 * `Origin: null`, which Vite's default CORS policy refuses. The shipped
 * single-file plugins make no such requests; this only stands in for that
 * build when specs load plugin sources from the dev server.
 */
export async function allowOpaqueOriginPluginModules(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.startsWith('/plugins/')
      || url.pathname.startsWith('/@')
      || url.pathname.startsWith('/node_modules/'),
    async (route) => {
      if (route.request().headers()['origin'] !== 'null') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'access-control-allow-origin': '*' },
      });
    },
  );
}
