/**
 * Plugin side of the Novelist host channel.
 *
 * Plugin iframes are sandboxed into opaque origins, so the host cannot rely on
 * `event.source` or origins to tell plugins apart. Instead it hands every
 * plugin document exactly one `MessagePort` right after the iframe's first
 * `load` event, and all traffic in both directions uses that port. Window
 * `message` events are only accepted for that single connect handshake.
 *
 * Call `connectToHost` synchronously at module top level (before any `await`
 * or mount), so the listener exists when the host's connect message arrives.
 */
export const HOST_CONNECT_TYPE = 'novelist-plugin-connect';

export type HostMessage = Record<string, unknown>;

export interface HostChannel {
  /** Post to the host. Messages posted before the host connects are queued. */
  post(message: HostMessage): void;
}

export function connectToHost(onMessage: (message: HostMessage) => void): HostChannel {
  let port: MessagePort | null = null;
  const pending: HostMessage[] = [];

  const onConnect = (event: MessageEvent) => {
    if (port || event.source !== window.parent) return;
    const data = event.data as { type?: unknown } | null;
    const offered = event.ports[0];
    if (!data || data.type !== HOST_CONNECT_TYPE || !offered) return;
    port = offered;
    window.removeEventListener('message', onConnect);
    port.onmessage = (message: MessageEvent) => {
      const payload = message.data;
      if (payload && typeof payload === 'object') onMessage(payload as HostMessage);
    };
    for (const message of pending.splice(0)) port.postMessage(message);
  };
  window.addEventListener('message', onConnect);

  return {
    post(message) {
      if (port) port.postMessage(message);
      else pending.push(message);
    },
  };
}
