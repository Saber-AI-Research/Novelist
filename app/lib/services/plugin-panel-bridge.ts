import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands } from '$lib/ipc/commands';
import { getEditorView, tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { aiEventName, claudeEventName } from '$lib/utils/plugin-bridge';

export type PluginPanelBridge = {
  destroy(): Promise<void>;
};

type BridgeContext = {
  iframe: HTMLIFrameElement;
  pluginId: string;
  /** Permission tokens declared by the plugin manifest. Used to gate ai.* / claude.* methods. */
  permissions?: readonly string[];
  /** Optional callback so the panel can respond to in-app navigation requests. */
  onNavigate?: (from: number) => void;
};

type BridgeRequest = {
  id?: string;
  method?: string;
  params?: any;
};

const THEME_VARS = [
  '--novelist-bg',
  '--novelist-bg-secondary',
  '--novelist-text',
  '--novelist-text-secondary',
  '--novelist-accent',
  '--novelist-border',
];

function themeVars() {
  const styles = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const prop of THEME_VARS) {
    vars[prop] = styles.getPropertyValue(prop);
  }
  return vars;
}

function post(target: Window, payload: unknown) {
  target.postMessage(payload, '*');
}

function activeEditorSnapshot() {
  const tab = tabsStore.activeTab;
  if (!tab) return null;
  const view = getEditorView(tab.id);
  const fullDoc = view?.state.doc.toString() ?? tab.content ?? '';
  const selection = view?.state.selection.main;
  const from = selection?.from ?? tab.cursorPosition ?? 0;
  const to = selection?.to ?? from;
  return {
    tabId: tab.id,
    filePath: tab.filePath,
    fullDoc,
    from,
    to,
    text: fullDoc.slice(from, to),
  };
}

function reply(target: Window, id: string | undefined, ok: boolean, data?: unknown, error?: string) {
  post(target, { type: 'bridge:response', id, ok, data, error });
}

function hasPermission(ctx: BridgeContext, token: string): boolean {
  return Array.isArray(ctx.permissions) && ctx.permissions.includes(token);
}

/**
 * Tracks per-stream Tauri listeners so we can detach them when a stream
 * completes, errors, is cancelled, or the panel unmounts.
 */
class StreamRegistry {
  private entries = new Map<string, UnlistenFn>();

  set(key: string, unlisten: UnlistenFn) {
    // If a caller reuses an id, drop the previous listener first.
    const prev = this.entries.get(key);
    if (prev) prev();
    this.entries.set(key, unlisten);
  }

  drop(key: string) {
    const fn = this.entries.get(key);
    if (fn) {
      fn();
      this.entries.delete(key);
    }
  }

  drainAll() {
    for (const fn of this.entries.values()) fn();
    this.entries.clear();
  }
}

async function attachAiStream(
  target: Window,
  registry: StreamRegistry,
  streamId: string,
) {
  const eventName = aiEventName(streamId);
  const unlisten = await listen<{ kind: string }>(eventName, (event) => {
    post(target, { type: 'bridge:event', event: eventName, payload: event.payload });
    const kind = event.payload?.kind;
    if (kind === 'done' || kind === 'error') {
      registry.drop(eventName);
    }
  });
  registry.set(eventName, unlisten);
}

async function attachClaudeStream(
  target: Window,
  registry: StreamRegistry,
  sessionId: string,
) {
  const eventName = claudeEventName(sessionId);
  const unlisten = await listen<{ kind: string }>(eventName, (event) => {
    post(target, { type: 'bridge:event', event: eventName, payload: event.payload });
    const kind = event.payload?.kind;
    if (kind === 'exit' || kind === 'error') {
      registry.drop(eventName);
    }
  });
  registry.set(eventName, unlisten);
}

async function handleRequest(
  ctx: BridgeContext,
  target: Window,
  registry: StreamRegistry,
  req: BridgeRequest,
) {
  const { method, params } = req;
  switch (method) {
    case 'bridge.ready':
      reply(target, req.id, true, { pluginId: ctx.pluginId, permissions: ctx.permissions ?? [] });
      return;

    case 'theme.get':
      reply(target, req.id, true, themeVars());
      return;

    case 'editor.getSelection': {
      reply(target, req.id, true, activeEditorSnapshot());
      return;
    }

    case 'editor.replaceRange': {
      const snap = activeEditorSnapshot();
      if (!snap) return reply(target, req.id, false, undefined, 'No active tab');
      const view = getEditorView(snap.tabId);
      if (!view) return reply(target, req.id, false, undefined, 'No active editor view');
      view.dispatch({
        changes: {
          from: Number(params?.from ?? 0),
          to: Number(params?.to ?? 0),
          insert: String(params?.text ?? ''),
        },
      });
      tabsStore.updateContent(snap.tabId, view.state.doc.toString());
      reply(target, req.id, true, { ok: true });
      return;
    }

    case 'editor.insertAtCursor': {
      const snap = activeEditorSnapshot();
      if (!snap) return reply(target, req.id, false, undefined, 'No active tab');
      const view = getEditorView(snap.tabId);
      if (!view) return reply(target, req.id, false, undefined, 'No active editor view');
      view.dispatch({
        changes: { from: snap.from, to: snap.to, insert: String(params?.text ?? '') },
      });
      tabsStore.updateContent(snap.tabId, view.state.doc.toString());
      reply(target, req.id, true, { ok: true });
      return;
    }

    case 'project.getCwd':
      reply(target, req.id, true, projectStore.dirPath);
      return;

    case 'project.getActiveFilePath':
      reply(target, req.id, true, tabsStore.activeTab?.filePath ?? null);
      return;

    case 'ai.fetchStream.start': {
      if (!hasPermission(ctx, 'ai:http')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:http' permission");
      }
      const result = await commands.aiFetchStreamStart(params);
      if (result.status === 'error') return reply(target, req.id, false, undefined, result.error);
      const streamId = result.data;
      try {
        await attachAiStream(target, registry, streamId);
      } catch (e) {
        return reply(target, req.id, false, undefined, `Failed to attach stream listener: ${e}`);
      }
      reply(target, req.id, true, { streamId });
      return;
    }

    case 'ai.fetchStream.cancel': {
      if (!hasPermission(ctx, 'ai:http')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:http' permission");
      }
      const streamId = String(params?.streamId ?? '');
      const result = await commands.aiFetchStreamCancel(streamId);
      registry.drop(aiEventName(streamId));
      if (result.status === 'error') return reply(target, req.id, false, undefined, result.error);
      reply(target, req.id, true, { ok: true });
      return;
    }

    case 'claude.detect': {
      if (!hasPermission(ctx, 'ai:claude-cli')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:claude-cli' permission");
      }
      const result = await commands.claudeCliDetect();
      reply(target, req.id, true, result);
      return;
    }

    case 'claude.spawn': {
      if (!hasPermission(ctx, 'ai:claude-cli')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:claude-cli' permission");
      }
      const result = await commands.claudeCliSpawn(params);
      if (result.status === 'error') return reply(target, req.id, false, undefined, result.error);
      const sessionId = result.data;
      try {
        await attachClaudeStream(target, registry, sessionId);
      } catch (e) {
        return reply(target, req.id, false, undefined, `Failed to attach stream listener: ${e}`);
      }
      reply(target, req.id, true, { sessionId });
      return;
    }

    case 'claude.send': {
      if (!hasPermission(ctx, 'ai:claude-cli')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:claude-cli' permission");
      }
      const sessionId = String(params?.sessionId ?? '');
      const line = String(params?.line ?? '');
      const result = await commands.claudeCliSend(sessionId, line);
      if (result.status === 'error') return reply(target, req.id, false, undefined, result.error);
      reply(target, req.id, true, { ok: true });
      return;
    }

    case 'claude.kill': {
      if (!hasPermission(ctx, 'ai:claude-cli')) {
        return reply(target, req.id, false, undefined, "Plugin lacks 'ai:claude-cli' permission");
      }
      const sessionId = String(params?.sessionId ?? '');
      const result = await commands.claudeCliKill(sessionId);
      registry.drop(claudeEventName(sessionId));
      if (result.status === 'error') return reply(target, req.id, false, undefined, result.error);
      reply(target, req.id, true, { ok: true });
      return;
    }

    default:
      reply(target, req.id, false, undefined, `Unknown bridge method: ${method}`);
  }
}

export async function createPluginPanelBridge(ctx: BridgeContext): Promise<PluginPanelBridge> {
  const target = ctx.iframe.contentWindow;
  if (!target) {
    return { destroy: async () => {} };
  }

  const registry = new StreamRegistry();

  const onWindowMessage = (event: MessageEvent) => {
    if (event.source !== target) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'navigate' && typeof data.position === 'number') {
      ctx.onNavigate?.(data.position);
      return;
    }
    if (data.type === 'bridge:request') {
      void handleRequest(ctx, target, registry, data as BridgeRequest);
    }
  };

  window.addEventListener('message', onWindowMessage);

  // Push initial theme + ready handshake. Plugins can either listen for
  // 'bridge:host-ready' or call 'bridge.ready' themselves.
  post(target, { type: 'theme-update', theme: themeVars() });
  post(target, { type: 'bridge:host-ready', pluginId: ctx.pluginId, permissions: ctx.permissions ?? [] });

  return {
    async destroy() {
      window.removeEventListener('message', onWindowMessage);
      registry.drainAll();
    },
  };
}
