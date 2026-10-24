/**
 * Host side of the plugin iframe channel (plugin side: `plugins/host-channel.ts`).
 *
 * Every plugin iframe is sandboxed without `allow-same-origin`, which gives
 * each plugin document its own opaque origin: plugins can neither script the
 * host nor each other. Messaging is bound to one `MessageChannel` per plugin
 * document: the port is transferred to the iframe's window right after the
 * host-initiated load, and only that port is trusted afterwards. A later load
 * the host did not initiate means the plugin navigated its own frame; that
 * document never receives a port.
 */
export const PLUGIN_CONNECT_TYPE = 'novelist-plugin-connect';

/**
 * No `allow-same-origin` (opaque origin per document), no popups and no
 * top-level navigation. WKWebView, WebKitGTK and WebView2 all load the
 * asset-protocol entry document in such frames; module scripts must be inlined
 * (see `plugins/vite-single-file.ts`) because cross-origin asset subresources
 * are refused for the opaque origin.
 */
export const PLUGIN_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-modals';

export type PluginMessage = Record<string, unknown>;

/** `ignored`: no plugin document yet; `navigated`: an untrusted load was refused. */
export type PluginLoadOutcome = 'connected' | 'ignored' | 'navigated';

export class PluginFrameConnection {
  #port: MessagePort | null = null;
  #awaitingLoad = true;
  #generation = 0;
  readonly #onMessage: (message: PluginMessage) => void;

  constructor(onMessage: (message: PluginMessage) => void) {
    this.#onMessage = onMessage;
  }

  /** Changes on every connect and close; pass it to `post` to drop stale replies. */
  get generation(): number {
    return this.#generation;
  }

  get connected(): boolean {
    return this.#port !== null;
  }

  /** The host is (re)assigning the iframe's document: trust its next load. */
  expectLoad(): void {
    this.close();
    this.#awaitingLoad = true;
  }

  /** Call from the iframe's `load` event. */
  handleLoad(iframe: HTMLIFrameElement | null | undefined): PluginLoadOutcome {
    const target = iframe?.contentWindow;
    if (!iframe || !target || !iframe.getAttribute('src')) return 'ignored';
    this.close();
    if (!this.#awaitingLoad) return 'navigated';
    this.#awaitingLoad = false;
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data && typeof data === 'object') this.#onMessage(data as PluginMessage);
    };
    target.postMessage({ type: PLUGIN_CONNECT_TYPE }, '*', [channel.port2]);
    this.#port = channel.port1;
    this.#generation += 1;
    return 'connected';
  }

  /** Returns false when disconnected or when `generation` is no longer current. */
  post(message: PluginMessage, generation: number = this.#generation): boolean {
    if (!this.#port || generation !== this.#generation) return false;
    this.#port.postMessage(message);
    return true;
  }

  close(): void {
    if (!this.#port) return;
    this.#port.onmessage = null;
    this.#port.close();
    this.#port = null;
    this.#generation += 1;
  }
}
