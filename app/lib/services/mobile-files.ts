import { commands } from '$lib/ipc/commands';

/**
 * Mobile file intake. Mobile platforms have no "any directory" semantics and
 * the system picker hands out `content://` / security-scoped URLs that
 * `std::fs` cannot open, so every user-picked file is read in the WebView via
 * a browser `<input type="file">` and copied into the app cache with
 * `stage_import_file`. The staged path is the only path passed to library /
 * import commands.
 */

/** Maximum decoded size accepted by `stage_import_file`. */
export const MAX_STAGED_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Open the system file picker through a transient `<input type="file">`.
 * Resolves `null` when the user cancels. `accept` uses the HTML syntax
 * (".epub,.txt" / MIME types).
 */
export function pickBrowserFile(accept: string): Promise<File | null> {
  // Executor form (not Promise.withResolvers): iOS 16 WKWebView lacks it.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.position = 'fixed';
    input.style.left = '-10000px';
    input.style.opacity = '0';
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    // Fired by WebKit/Chromium when the picker is dismissed without a choice.
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export class StageFileError extends Error {}

/** Copy a picked browser file into the app cache; returns the staged path. */
export async function stageBrowserFile(file: File): Promise<string> {
  if (file.size > MAX_STAGED_FILE_BYTES) {
    throw new StageFileError(`${file.name} is larger than 64 MiB`);
  }
  const base64 = await readAsBase64(file);
  const result = await commands.stageImportFile(file.name, base64);
  if (result.status === 'error') throw new StageFileError(result.error);
  return result.data;
}

/** Picker + staging in one step. Resolves `null` when the user cancels. */
export async function pickAndStageFile(accept: string): Promise<{ path: string; name: string } | null> {
  const file = await pickBrowserFile(accept);
  if (!file) return null;
  const path = await stageBrowserFile(file);
  return { path, name: file.name };
}
