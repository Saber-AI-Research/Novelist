/**
 * Best-effort cancellation of in-flight AI streams when the AI Talk panel
 * unmounts. Without this, closing the panel while a chat or rewrite is
 * mid-stream leaves the Rust tokio task running until its 120s per-stream
 * timeout and the Tauri listener registered until a done/error event — a
 * slow leak across many open/close cycles.
 *
 * Safe to call with `null` / `undefined` ids. Rejections from the cancel IPC
 * are swallowed because the panel is already gone and nothing useful can be
 * done with the error.
 */
export function cancelPendingStreams(
  ids: Array<string | null | undefined>,
  cancel: (id: string) => Promise<unknown>,
): void {
  for (const id of ids) {
    if (id) void cancel(id).catch(() => {});
  }
}
