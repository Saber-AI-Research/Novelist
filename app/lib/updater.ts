import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { t } from '$lib/i18n';

const SKIPPED_VERSION_KEY = 'novelist-skipped-update-version';

function getSkippedVersion(): string | null {
  return localStorage.getItem(SKIPPED_VERSION_KEY);
}

function setSkippedVersion(version: string) {
  localStorage.setItem(SKIPPED_VERSION_KEY, version);
}

export function clearSkippedVersion() {
  localStorage.removeItem(SKIPPED_VERSION_KEY);
}

export interface UpdateStatus {
  available: boolean;
  version?: string;
  notes?: string;
  downloading?: boolean;
  progress?: number;
}

let _status: UpdateStatus = { available: false };
let _cachedUpdate: Update | null = null;
const listeners: Array<(s: UpdateStatus) => void> = [];

export function getUpdateStatus(): UpdateStatus {
  return _status;
}

export function onUpdateStatusChange(fn: (s: UpdateStatus) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function setStatus(s: UpdateStatus) {
  _status = s;
  for (const fn of listeners) fn(s);
}

/**
 * Check for updates silently. Called once on app startup after a short delay.
 * If an update is found but the user previously skipped this exact version,
 * it is suppressed. A newer version will still prompt.
 */
export async function checkForUpdates(silent = true): Promise<void> {
  try {
    const update = await check({ timeout: 10000 });
    if (update) {
      _cachedUpdate = update;

      const skipped = getSkippedVersion();
      if (silent && skipped === update.version) {
        // User chose "Skip This Version" for this exact version — stay quiet
        return;
      }

      setStatus({
        available: true,
        version: update.version,
        notes: update.body ?? undefined,
      });

      if (!silent) {
        await promptAndInstall();
      }
    } else {
      if (!silent) {
        await message(t('updater.alreadyLatest'), {
          title: t('updater.noUpdates'),
          kind: 'info',
        });
      }
      setStatus({ available: false });
    }
  } catch (e) {
    console.warn('[updater] Check failed:', e);
    if (!silent) {
      await message(t('updater.checkFailedMessage'), {
        title: t('updater.checkFailed'),
        kind: 'error',
      });
    }
  }
}

/**
 * Download and install the update, then relaunch.
 */
export async function installUpdate(): Promise<void> {
  if (!_cachedUpdate) {
    await checkForUpdates(false);
    return;
  }
  await promptAndInstall();
}

/**
 * Three-button dialog: Update Now / Skip This Version / Later
 *
 * Tauri's `ask()` only supports two buttons, so we use two sequential dialogs:
 * 1. "Update Now" vs "Not Now"
 * 2. If "Not Now" → "Skip This Version?" vs "Remind Me Later"
 */
async function promptAndInstall(): Promise<void> {
  const update = _cachedUpdate;
  if (!update) return;

  const wantUpdate = await ask(
    t('updater.availableMessage', { version: update.version, notes: update.body || '' }),
    { title: t('updater.available'), kind: 'info', okLabel: t('updater.updateNow'), cancelLabel: t('updater.notNow') }
  );

  if (!wantUpdate) {
    const skip = await ask(
      t('updater.skipMessage', { version: update.version }),
      { title: t('updater.skipTitle'), kind: 'info', okLabel: t('updater.skipVersion'), cancelLabel: t('updater.remindLater') }
    );
    if (skip) {
      setSkippedVersion(update.version);
      setStatus({ available: false });
    }
    return;
  }

  setStatus({ ..._status, downloading: true, progress: 0 });

  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength ?? 0;
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        setStatus({
          ..._status,
          downloading: true,
          progress: contentLength > 0 ? Math.round((downloaded / contentLength) * 100) : 0,
        });
        break;
      case 'Finished':
        setStatus({ ..._status, downloading: false, progress: 100 });
        break;
    }
  });
}
