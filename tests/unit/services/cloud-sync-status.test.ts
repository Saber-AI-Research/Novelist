import { describe, expect, it } from 'vitest';
import type { SyncStatus } from '$lib/ipc/commands';
import { nonConflictErrors, syncedCleanly } from '$lib/services/cloud-sync-status';

function status(patch: Partial<SyncStatus> = {}): SyncStatus {
  return {
    last_sync: '2026-10-28T10:00:00Z',
    files_uploaded: 0,
    files_downloaded: 0,
    errors: [],
    in_progress: false,
    adoptable_project_id: null,
    conflicts: [],
    ...patch,
  };
}

describe('[contract] cloud sync status', () => {
  it('reports synced only for a completed run without errors or conflicts', () => {
    expect(syncedCleanly(status())).toBe(true);
    expect(syncedCleanly(null)).toBe(false);
    expect(syncedCleanly(status({ last_sync: null }))).toBe(false);
    expect(syncedCleanly(status({ errors: ['Remote discovery: WebDAV PROPFIND failed'] }))).toBe(false);
    expect(syncedCleanly(status({
      conflicts: ['chapter.md'],
      errors: ['Sync chapter.md: Conflict: local and remote differ'],
    }))).toBe(false);
  });

  it('separates per-file conflict reports from other problems', () => {
    const run = status({
      conflicts: ['第一章.md', 'notes/a b.md'],
      errors: [
        'Sync 第一章.md: Conflict: local and remote differ',
        'Sync notes/a b.md: Conflict: local and remote differ',
        'Sync other.md: WebDAV GET returned 500 Internal Server Error',
        'Skipped "bad\\u0001.md": this filename cannot be synced to WebDAV',
      ],
    });
    expect(nonConflictErrors(run)).toEqual([
      'Sync other.md: WebDAV GET returned 500 Internal Server Error',
      'Skipped "bad\\u0001.md": this filename cannot be synced to WebDAV',
    ]);
    expect(nonConflictErrors(null)).toEqual([]);
  });
});
