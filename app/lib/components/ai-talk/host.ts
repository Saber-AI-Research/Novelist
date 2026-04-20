/**
 * Direct host-side helpers used by the native AI panels. These call the Rust
 * IPC commands and Tauri event listeners directly — no postMessage / iframe
 * indirection — so they can only be used from components rendered inside the
 * main app webview.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands } from '$lib/ipc/commands';
import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';

export type EditorSnapshot = {
  tabId: string;
  filePath: string | null;
  fullDoc: string;
  from: number;
  to: number;
  text: string;
};

export function getEditorSnapshot(): EditorSnapshot | null {
  const tab = tabsStore.activeTab;
  if (!tab) return null;
  const view = getEditorView(tab.id);
  const fullDoc = view?.state.doc.toString() ?? tab.content ?? '';
  const sel = view?.state.selection.main;
  const from = sel?.from ?? tab.cursorPosition ?? 0;
  const to = sel?.to ?? from;
  return {
    tabId: tab.id,
    filePath: tab.filePath,
    fullDoc,
    from,
    to,
    text: fullDoc.slice(from, to),
  };
}

export function replaceEditorRange(from: number, to: number, text: string) {
  const tab = tabsStore.activeTab;
  if (!tab) return;
  const view = getEditorView(tab.id);
  if (!view) return;
  view.dispatch({ changes: { from, to, insert: text } });
  tabsStore.updateContent(tab.id, view.state.doc.toString());
}

export type AiStreamEvent =
  | { kind: 'chunk'; data: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string; status?: number };

export async function startAiStream(req: {
  url: string;
  headers: [string, string][];
  body: string;
  sse: boolean;
}): Promise<string> {
  const result = await commands.aiFetchStreamStart(req);
  if (result.status === 'error') throw new Error(result.error);
  return result.data;
}

export async function cancelAiStream(streamId: string): Promise<void> {
  const result = await commands.aiFetchStreamCancel(streamId);
  if (result.status === 'error') throw new Error(result.error);
}

/**
 * Async iterator over a started AI stream. Subscribes to the per-stream Tauri
 * event channel and yields each `{kind, ...}` event the Rust bridge emits.
 * Ends after `done` or `error`. Cleans up the listener on completion.
 */
export async function* aiStream(streamId: string): AsyncGenerator<AiStreamEvent> {
  const channel = `ai-stream://${streamId}`;
  const queue: AiStreamEvent[] = [];
  let waiter: ((v: void) => void) | null = null;
  let done = false;

  const unlisten: UnlistenFn = await listen<AiStreamEvent>(channel, (event) => {
    queue.push(event.payload);
    waiter?.();
    waiter = null;
  });

  try {
    while (!done) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
      const ev = queue.shift();
      if (!ev) continue;
      yield ev;
      if (ev.kind === 'done' || ev.kind === 'error') {
        done = true;
      }
    }
  } finally {
    unlisten();
  }
}
