import { isolateHistory } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { commandRegistry } from '$lib/stores/commands.svelte';

export type EditorCtxMenuState = {
  x: number;
  y: number;
  hasSelection: boolean;
  from: number;
  to: number;
};

/**
 * Editor right-click context menu composable.
 *
 * Snapshots the selection at menu-open time because WKWebView's right-click
 * mousedown can collapse/move the CM selection before the user clicks a
 * menu item. The snapshot is restored when running chain commands
 * (copy-rich-text, copy-plain-text) so they operate on the right range.
 */
export function createEditorContextMenu(getView: () => EditorView | null) {
  let state = $state<EditorCtxMenuState | null>(null);

  async function cut() {
    const view = getView();
    if (!view || !state) return;
    const { from, to } = state;
    if (from === to) return;
    const text = view.state.sliceDoc(from, to);
    // Make the captured range the deletion event's start selection for undo.
    view.dispatch({
      selection: { anchor: from, head: to },
      annotations: Transaction.addToHistory.of(false),
    });
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
      annotations: isolateHistory.of('full'),
    });
    view.focus();
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  async function copy() {
    const view = getView();
    if (!view || !state) return;
    const { from, to } = state;
    if (from === to) return;
    try { await navigator.clipboard.writeText(view.state.sliceDoc(from, to)); } catch {}
  }

  async function paste() {
    const view = getView();
    if (!view) return;
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (!text) return;
    // Prefer the snapshot range (right-click position) over the current
    // selection, which may have been collapsed by WKWebView's mousedown.
    const from = state?.from ?? view.state.selection.main.from;
    const to = state?.to ?? view.state.selection.main.to;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    view.focus();
  }

  function selectAll() {
    const view = getView();
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }

  /** Restore the snapshot selection, then run a registered command. */
  function runCommand(id: string) {
    const view = getView();
    if (view && state) {
      const { from, to } = state;
      view.dispatch({ selection: { anchor: from, head: to } });
    }
    commandRegistry.execute(id);
    view?.focus();
  }

  return {
    get state() { return state; },
    set state(next: EditorCtxMenuState | null) { state = next; },
    close() { state = null; },
    cut,
    copy,
    paste,
    selectAll,
    runCommand,
  };
}
