import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_CONNECT_TYPE,
  PluginFrameConnection,
  type PluginMessage,
} from '../../../app/lib/services/plugin-host-channel';

/**
 * [contract] The host trusts a plugin document only through the MessagePort it
 * transferred after a host-initiated load; window messages carry no authority.
 */

interface FakeFrame {
  iframe: HTMLIFrameElement;
  /** The port handed to the plugin document by the latest connect, if any. */
  pluginPort(): MessagePort | undefined;
  connects: number;
}

const openPorts: MessagePort[] = [];

function fakeFrame(src = 'asset://localhost/plugin%2Findex.html'): FakeFrame {
  const state = { connects: 0, port: undefined as MessagePort | undefined };
  const contentWindow = {
    postMessage: vi.fn((message: { type?: string }, _origin: string, transfer?: MessagePort[]) => {
      if (message.type !== PLUGIN_CONNECT_TYPE) return;
      state.connects += 1;
      state.port = transfer?.[0];
      if (state.port) openPorts.push(state.port);
    }),
  };
  const iframe = {
    contentWindow,
    getAttribute: (name: string) => (name === 'src' ? src : null),
  } as unknown as HTMLIFrameElement;
  return {
    iframe,
    pluginPort: () => state.port,
    get connects() { return state.connects; },
  };
}

function nextMessage(port: MessagePort): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  port.onmessage = (event) => resolve(event.data);
  return promise;
}

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

describe('PluginFrameConnection', () => {
  it('connects once per host-initiated load and exchanges messages over the port', async () => {
    const received: PluginMessage[] = [];
    const connection = new PluginFrameConnection((message) => received.push(message));
    const frame = fakeFrame();

    expect(connection.handleLoad(frame.iframe)).toBe('connected');
    expect(frame.connects).toBe(1);

    const pluginPort = frame.pluginPort()!;
    const delivered = nextMessage(pluginPort);
    expect(connection.post({ type: 'theme-update' })).toBe(true);
    await expect(delivered).resolves.toEqual({ type: 'theme-update' });

    pluginPort.postMessage({ type: 'navigate', position: 3 });
    await vi.waitFor(() => expect(received).toEqual([{ type: 'navigate', position: 3 }]));
    connection.close();
  });

  it('refuses a later load the host did not initiate (the plugin navigated itself)', () => {
    const connection = new PluginFrameConnection(() => {});
    const frame = fakeFrame();
    connection.handleLoad(frame.iframe);

    expect(connection.handleLoad(frame.iframe)).toBe('navigated');
    expect(frame.connects).toBe(1);
    expect(connection.connected).toBe(false);
    expect(connection.post({ type: 'content-update', content: 'secret' })).toBe(false);

    connection.expectLoad();
    expect(connection.handleLoad(frame.iframe)).toBe('connected');
    expect(frame.connects).toBe(2);
    connection.close();
  });

  it('ignores the initial empty document of an iframe without a src', () => {
    const connection = new PluginFrameConnection(() => {});
    const blank = fakeFrame('');
    expect(connection.handleLoad(blank.iframe)).toBe('ignored');
    expect(blank.connects).toBe(0);

    const frame = fakeFrame();
    expect(connection.handleLoad(frame.iframe)).toBe('connected');
    connection.close();
  });

  it('drops replies addressed to an earlier connection', () => {
    const connection = new PluginFrameConnection(() => {});
    const frame = fakeFrame();
    connection.handleLoad(frame.iframe);
    const generation = connection.generation;

    connection.expectLoad();
    connection.handleLoad(frame.iframe);
    expect(connection.post({ type: 'translation-reference-result' }, generation)).toBe(false);
    expect(connection.post({ type: 'translation-reference-result' })).toBe(true);
    connection.close();
  });
});
