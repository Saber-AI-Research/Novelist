import { invoke } from '@tauri-apps/api/core';
import { platform } from '$lib/stores/platform.svelte';

/**
 * Native share sheet (mobile only), backed by the `mobile-support` plugin.
 *
 * The plugin only shares regular files inside the share staging directory
 * `<appCacheDir>/exports/`; export commands write there first. The outcome
 * reflects the share sheet, not delivery: iOS reports `completed` or
 * `cancelled`, Android always `dismissed`. None of them is an error, so
 * callers must not show "sent" confirmations. Failures reject with an Error.
 */
export type ShareOutcome = 'completed' | 'cancelled' | 'dismissed';

const MIME_BY_EXTENSION: Record<string, string> = {
  zip: 'application/zip',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
};

export function mimeTypeForPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

export async function shareFile(path: string, mimeType: string = mimeTypeForPath(path)): Promise<ShareOutcome> {
  if (!platform.isMobile) {
    throw new Error('Sharing files is not supported on this platform');
  }
  try {
    return await invoke<ShareOutcome>('plugin:mobile-support|share_file', { path, mimeType });
  } catch (error) {
    throw new Error(typeof error === 'string' ? error : (error as Error)?.message ?? String(error));
  }
}
