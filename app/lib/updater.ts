import { type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { ask, message } from '@tauri-apps/plugin-dialog';
import { relaunch } from '@tauri-apps/plugin-process';
import { t } from '$lib/i18n';
import { updaterState } from '$lib/stores/updater-state.svelte';
import {
  runUpdateCheck,
  SKIPPED_VERSION_KEY,
  takeLastAvailableHandle,
} from '$lib/services/update-checker';

function setSkippedVersion(version: string) {
  localStorage.setItem(SKIPPED_VERSION_KEY, version);
}

export function clearSkippedVersion() {
  localStorage.removeItem(SKIPPED_VERSION_KEY);
}

let _cachedUpdate: Update | null = null;

export async function checkForUpdates(silent = true): Promise<void> {
  const outcome = await runUpdateCheck({ startup: silent });

  switch (outcome.kind) {
    case 'available': {
      const handle = (outcome.handle ?? takeLastAvailableHandle()) as Update | null;
      if (handle) _cachedUpdate = handle;
      if (!silent && _cachedUpdate) {
        await promptAndInstall();
      }
      return;
    }
    case 'no-update':
      updaterState.reset();
      if (!silent) {
        await message(t('updater.alreadyLatest'), {
          title: t('updater.noUpdates'),
          kind: 'info',
        });
      }
      return;
    case 'skipped':
    case 'unsupported':
      return;
    case 'failed':
      if (!silent) {
        await message(t('updater.checkFailedMessage'), {
          title: t('updater.checkFailed'),
          kind: 'error',
        });
      }
      return;
  }
}

export async function startUpdateFlow(): Promise<void> {
  if (!_cachedUpdate) {
    await checkForUpdates(false);
    return;
  }
  await promptAndInstall();
}

export const installUpdate = startUpdateFlow;

export function skipPendingVersion(): void {
  const v = updaterState.version;
  if (v) setSkippedVersion(v);
  updaterState.reset();
  _cachedUpdate = null;
}

export function dismissPendingVersion(): void {
  updaterState.reset();
}

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
      skipPendingVersion();
    }
    return;
  }

  await downloadAndInstall(update);
}

async function downloadAndInstall(update: Update): Promise<void> {
  updaterState.startDownload(0);

  try {
    await update.downloadAndInstall((event: DownloadEvent) => {
      switch (event.event) {
        case 'Started':
          updaterState.startDownload(event.data.contentLength ?? 0);
          break;
        case 'Progress':
          updaterState.recordChunk(event.data.chunkLength);
          break;
        case 'Finished':
          updaterState.setInstalling();
          break;
      }
    });
  } catch (e) {
    console.warn('[updater] Download/install failed:', e);
    const detail = e instanceof Error ? e.message : String(e);
    updaterState.setError(detail);
    return;
  }

  updaterState.setReady();
}

export async function restartForUpdate(): Promise<void> {
  try {
    await relaunch();
  } catch (e) {
    console.error('[updater] relaunch failed:', e);
    const detail = e instanceof Error ? e.message : String(e);
    await message(t('updater.relaunchFailedMessage', { detail }), {
      title: t('updater.relaunchFailed'),
      kind: 'error',
    });
  }
}

export function deferRestart(): void {
  updaterState.reset();
  _cachedUpdate = null;
}
