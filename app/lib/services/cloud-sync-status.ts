import type { SyncStatus } from '$lib/ipc/commands';

/** A run counts as synced only when it finished without any error or conflict. */
export function syncedCleanly(status: SyncStatus | null): boolean {
  return status !== null
    && status.last_sync !== null
    && status.errors.length === 0
    && status.conflicts.length === 0;
}

/**
 * Errors other than the per-file conflict reports (`Sync <path>: …`), which
 * are shown with their own resolution actions instead.
 */
export function nonConflictErrors(status: SyncStatus | null): string[] {
  if (!status) return [];
  return status.errors.filter(
    (error) => !status.conflicts.some((path) => error.startsWith(`Sync ${path}: `)),
  );
}
