# Snapshot Retention + WebDAV Upload

**Date**: 2026-04-20
**Status**: Draft (awaiting user review)
**Scope**: `core/src/services/snapshots.rs`, `core/src/commands/snapshot.rs`, `app/lib/components/SnapshotPanel.svelte`, `core/src/models/settings.rs`, `core/src/commands/settings.rs`. WebDAV upload reuses existing `core/src/services/webdav.rs` and the sync config written by `core/src/commands/sync.rs`.

---

## 1. Goals

1. **Bound local disk growth.** Snapshots currently accumulate without limit. Add a user-configurable cap (default **100**).
2. **Eliminate near-duplicate snapshots.** Two snapshots within a user-configurable interval (default **60 minutes**) collapse into one — the newer one overwrites the older. This is "rule B" from brainstorming: no rate-limit popup, no button disable, no history compression; the latest wins silently.
3. **Opt-in WebDAV backup.** When the user already has sync configured (non-empty `webdav_url` + `username`), every new snapshot is also uploaded to the WebDAV server. Upload failure is non-fatal — local snapshot creation always succeeds.
4. **Collision-safe remote paths.** Two projects with the same folder name (e.g., `~/Documents/小说` and `~/Projects/小说`) must not share a remote directory.
5. **User-configurable**, with global defaults + per-project overlay, following the existing `EffectiveSettings` pattern.

Non-goals: history compression, inter-snapshot diffing, remote restore, selective-file restore, zip/tar packaging.

---

## 2. Behavior Matrix

| Trigger | Precondition | Result |
|---|---|---|
| User clicks **Create** in SNAPS panel | No previous snapshot, or newest snapshot timestamp ≥ `min_interval_minutes` ago | Create new snapshot (§4). If local count > `max_count`, delete oldest until at cap (§5). If WebDAV configured, upload (§6). |
| User clicks **Create** | Newest snapshot timestamp < `min_interval_minutes` ago | **Replace**: delete the newest snapshot (both local dir and remote dir if present), then create new snapshot in its place. No cap pruning needed (count unchanged). |
| User clicks **Restore** on any snapshot | — | Unchanged from current: overwrite project files from snapshot's local `files/` dir. Remote is a backup, not a restore source. |
| User clicks **Delete** on a snapshot | — | Unchanged local behavior + attempt to DELETE the remote dir (best-effort, non-fatal). |
| User changes `max_count` from N down to M (M < N) in Settings | — | **Not applied immediately.** Pruning happens on next Create — at that point, delete oldest until count ≤ M. This avoids background deletion surprises and keeps the codepath single. |
| WebDAV config becomes available after snapshots already exist | — | Nothing retroactive. Only snapshots created **after** config is present get uploaded. No bulk back-fill. |
| WebDAV config removed after uploads exist | — | Remote dirs remain untouched. User can manually clean up their server. (Explicit "wipe remote" button: out of scope.) |

---

## 3. Settings Schema

### 3.1 Rust model (`core/src/models/settings.rs`)

Add a new section, mirroring `ViewConfig` / `NewFileConfig`:

```rust
pub const DEFAULT_SNAPSHOT_MAX_COUNT: u32 = 100;
pub const DEFAULT_SNAPSHOT_MIN_INTERVAL_MINUTES: u32 = 60;

#[derive(Debug, Default, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct SnapshotConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_interval_minutes: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
pub struct ResolvedSnapshot {
    pub max_count: u32,
    pub min_interval_minutes: u32,
}
```

- Attached to `GlobalSettings` as `pub snapshot: SnapshotConfig` with `#[serde(default)]`.
- Attached to `ProjectConfig` (`core/src/models/project.rs`) as `pub snapshot: Option<SnapshotConfig>` (check parity with how `[view]` / `[new_file]` are currently attached; use the same pattern).
- `EffectiveSettings` gains `pub snapshot: ResolvedSnapshot`.
- `resolve()` picks project → global → baked default, field-by-field.

### 3.2 IPC

`write_global_settings` and `write_project_settings` gain an extra optional `snapshot: Option<SnapshotConfig>` parameter (backwards-compatible: existing callers pass `None`).

### 3.3 Validation

`max_count` clamped to `[1, 10000]` on write (reject outside range with `AppError::InvalidInput`). `min_interval_minutes` clamped to `[0, 10080]` (0 = disable rule B → every create is a fresh snapshot; 10080 = one week).

---

## 4. Snapshot Creation — Revised Flow

Replaces the current `create_snapshot()` in `core/src/services/snapshots.rs`:

```
1. Resolve settings for this project_dir (max_count, min_interval_minutes).
2. List existing local snapshots (sorted newest-first, same as today).
3. Compute `should_replace` = snapshots.first().timestamp >= (now - min_interval_minutes * 60)
   - If min_interval_minutes == 0 → never replace.
4. If should_replace:
     let victim = snapshots.remove(0);
     delete_snapshot_local(&victim.id);
     if webdav_configured: try_delete_snapshot_remote(&victim.id); // log-and-continue
5. Do the file copy loop (unchanged — same .md/.txt/... filter, same hidden-dir skip).
6. Write metadata.json (unchanged).
7. Prune oldest if !should_replace and snapshots.len() + 1 > max_count:
     while count > max_count:
        let oldest = snapshots.pop();
        delete_snapshot_local(&oldest.id);
        if webdav_configured: try_delete_snapshot_remote(&oldest.id);
8. If webdav_configured: try_upload_snapshot(&new_meta.id). // log-and-continue
9. Return new SnapshotMeta to frontend (same shape as today).
```

**Why step 4 comes first, before the copy loop**: if the copy fails mid-way, we don't want to have already deleted the victim. Therefore step 4 is actually: *plan to replace, but only delete after the new files_dir is fully written*. Concrete sequence:

```
5a. Create temp dir: ~/.novelist/snapshots/{hash}/snap-{ts}.pending/
5b. Copy project files into {...}.pending/files/
5c. Write {...}.pending/metadata.json
5d. Atomic rename {...}.pending → snap-{ts}    (tokio::fs::rename)
5e. Now safe to delete the victim (step 4 action) + prune oldest (step 7).
```

This gives crash-safety: a partial copy leaves a `.pending/` dir that future `list_snapshots` ignores (only `metadata.json` at the canonical path counts). A stale `.pending/` is cleaned on next `create_snapshot` (scan and remove any `*.pending` dirs at the start — cheap).

**Content scope**: unchanged. Still `.md / .markdown / .txt / .json / .jsonl / .csv`. Hidden dirs still skipped. This keeps the 100-copy × project-size calculus sane (text-only → 100 copies of a 500-chapter novel ≈ a few hundred MB, not gigabytes).

---

## 5. Local Pruning

Deterministic: sort by timestamp ascending, pop the oldest one by one until `len() <= max_count`. No weight given to the `name` field — user-named snapshots get pruned the same as auto-named ones (current UI requires a name, so they're all "named").

**If the user wants to protect a snapshot**: out of scope for this iteration. A future `pinned: bool` field on `SnapshotMeta` could exempt it from pruning.

---

## 6. WebDAV Upload — Naming & Collision Safety

### 6.1 Remote path scheme

```
{webdav_url}/novelist-snapshots/{slug}-{hash8}/
    project.json                  ← identity card, written once on first upload
    snap-{timestamp}/
        metadata.json
        files/
            chapter1.md
            notes/ideas.md
            ...
    snap-{older-ts}/
        ...
```

- `{slug}` = folder basename, sanitized: replace any of `/ \ : * ? " < > |` and whitespace with `_`, keep CJK and ASCII word chars. If the result is empty (pathological — e.g., the user's folder is literally `///`), fall back to `project`.
- `{hash8}` = first 8 hex chars of `blake3(canonicalized_absolute_project_path)`. Stable across app restarts. Independent of folder-rename until the folder is actually moved/renamed on disk.
- The top-level namespace is **`novelist-snapshots/`**, NOT `novelist/`, to avoid any co-habitation with the existing sync's `novelist/{name}/` tree. Different concept (full snapshots vs. incremental sync), different top-level dir.

### 6.2 `project.json` — identity card

Written to the project root on the remote (`novelist-snapshots/{slug}-{hash8}/project.json`) on the very first upload, and validated before every subsequent upload:

```json
{
  "original_path": "/Users/foo/Documents/小说",
  "display_name": "小说",
  "created_iso": "2026-04-20T12:34:56Z"
}
```

**Pre-upload validation** (every snapshot upload):

```
1. PROPFIND novelist-snapshots/{slug}-{hash8}/  (Depth: 0)
2. If 404 / not exists:
     MKCOL novelist-snapshots/
     MKCOL novelist-snapshots/{slug}-{hash8}/
     PUT  novelist-snapshots/{slug}-{hash8}/project.json  ← write identity card
3. If exists:
     GET  novelist-snapshots/{slug}-{hash8}/project.json
     parse → if original_path != current project_dir: ABORT with error
             "WebDAV path collision: remote project.json says {x}, local is {y}.
              Skipping remote upload for this snapshot."
     (hash collision is astronomically rare; this mostly catches user-created dirs or
      multi-user shared WebDAV where two users happened to pick the same slug-hash.)
4. MKCOL novelist-snapshots/{slug}-{hash8}/snap-{ts}/
5. MKCOL novelist-snapshots/{slug}-{hash8}/snap-{ts}/files/
6. Walk snapshot's local files/, MKCOL each subdir, PUT each file.
7. PUT metadata.json last (so a partial upload doesn't look complete on list).
```

If `project.json` is missing from an existing dir (e.g., legacy or hand-created), treat it as step 2's "not exists" and write one — the local project claims the dir by being the first to deposit identity.

### 6.3 Failure handling

Every remote step is wrapped in `tracing::warn!` on error. The local snapshot is ALREADY committed by the time we attempt upload (§4 step 5d), so remote failures never undo local work. The frontend gets a successful `SnapshotMeta` back either way; upload errors appear in the tracing log only for this iteration.

Future improvement (out of scope): a per-snapshot `remote_status: "synced" | "pending" | "failed"` field surfaced in the UI with a retry button.

### 6.4 Detecting "WebDAV configured"

Reuse `sync::read_sync_config(project_dir)`:
- Config file exists at `~/.novelist/sync/{hash16}/config.json`
- `enabled == true` AND `webdav_url` is non-empty AND `username` is non-empty

Snapshot does **not** require `sync.enabled == true` per se — but since the existing sync UI tightly couples "enabled" to "has credentials," reusing the flag is fine and avoids introducing a second enable-toggle. If the user turns off sync, snapshot uploads also stop. (Alternative: a dedicated `snapshot.upload_webdav: bool` — rejected, over-complicates the UX.)

---

## 7. Frontend Changes

### 7.1 `SnapshotPanel.svelte`

- No behavior change in the create form; still just name + Create.
- After Create, the refresh reflects the new list (possibly with one fewer entry if a replace happened — which the user won't notice unless they're staring at the list).
- Optional: a subtle row-level tooltip or badge "Uploaded to WebDAV" when the upload succeeded. Deferred — out of scope for v1.

### 7.2 Settings UI (`Settings.svelte`)

New section **Snapshots** under the existing editor/view settings:

```
Snapshots
  Max snapshots       [  100  ]  (1–10000)
  Min interval         [   60  ]  minutes  (0 = never replace)
```

Both inputs are number fields; no file picker needed. Help tooltip on the section header: "Snapshots older than the cap are deleted automatically. If two snapshots are created within the min interval, the newer replaces the older."

Note about WebDAV: a small hint "Uploads to WebDAV when sync is configured" with a link to the sync section. No separate toggle.

### 7.3 Settings store (`app/lib/stores/settings.svelte.ts`)

Add `settingsStore.snapshot.maxCount` and `settingsStore.snapshot.minIntervalMinutes` getters following the existing `view.*` / `newFile.*` pattern. Add `writeSnapshotConfig(partial)` that routes to global or project scope based on `is_project_scoped`.

### 7.4 No new Tauri events needed

The existing `refresh()` call in `SnapshotPanel` is enough. No background cron, no file-watcher hookup.

---

## 8. Data Migration

- **Existing local snapshots**: no schema change. `list_snapshots` still reads `metadata.json` unchanged. First `create_snapshot` after this lands may prune down to `max_count` if the user already has >100 — expected and documented in the changelog.
- **Existing sync configs**: untouched. Snapshots use a different top-level remote dir (`novelist-snapshots/`), so there's no overlap.
- **First-run defaults**: `GlobalSettings::default()` gives `SnapshotConfig::default()` which resolves to 100 / 60 via `DEFAULT_SNAPSHOT_*` constants. No explicit migration code needed.

---

## 9. Testing

### 9.1 Rust unit tests (`core/src/services/snapshots.rs` module)

New tests alongside existing ones:

- `test_create_within_interval_replaces_newest` — create, fast-forward < interval, create again → count stays 1, timestamp is the newer one
- `test_create_outside_interval_appends` — create, fast-forward > interval, create again → count is 2
- `test_prune_at_cap` — max_count = 3, create 5 times with > interval spacing → 3 most recent remain, oldest 2 gone
- `test_replace_does_not_trigger_prune` — cap = 3, 3 snapshots exist, replace within interval → still 3 snapshots
- `test_pending_dir_cleaned_on_next_create` — manually leave a `snap-X.pending/` dir → next create doesn't crash and cleans it
- `test_atomic_replace_survives_partial_copy` — simulate a failure mid-copy (inject via trait or use a read-only target subdir); original victim snapshot still exists
- `test_min_interval_zero_never_replaces` — interval = 0 → every create appends

Time injection: factor `now()` behind a `fn now_secs() -> u64` that tests override via a `thread_local!` or via passing a `Clock` trait. Minimal — tests just need monotonic control.

### 9.2 Rust unit tests — WebDAV naming (pure functions)

- `test_slug_sanitize_keeps_cjk` — `"小说"` → `"小说"`
- `test_slug_sanitize_replaces_illegal` — `"my: project?"` → `"my__project_"`
- `test_slug_sanitize_empty_falls_back` — `"///"` → `"project"`
- `test_remote_path_format` — build `novelist-snapshots/{slug}-{hash8}/snap-{ts}/files/foo.md` string, assert shape
- `test_hash8_stable` — same path → same hash; different path → different hash; hash is exactly 8 hex chars

### 9.3 Rust integration — WebDAV upload/download/identity-check

Gated behind an env var (`NOVELIST_TEST_WEBDAV_URL` etc.) so CI doesn't need a live server. Local dev runs these against a local `rclone serve webdav` or similar. Asserts:

- Fresh upload writes `project.json` + snap dir + files
- Second upload from same project writes only the new snap dir, leaves `project.json` alone
- Upload with a forged `project.json` (different `original_path`) → local snapshot still succeeds, upload logs the collision warning, remote untouched
- Delete on prune removes the remote snap dir

### 9.4 Frontend unit tests

- `tests/unit/stores/settings-store.test.ts` — extend with snapshot section getters/writers
- No new Vitest tests needed for `SnapshotPanel.svelte` itself — existing behavior unchanged

### 9.5 E2E

- Extend `tests/e2e/fixtures/tauri-mock.ts` to:
  - Track mock snapshot list in-memory
  - Simulate the replace-within-interval rule
  - Simulate the prune-at-cap rule
- New spec `tests/e2e/specs/snapshot-retention.spec.ts` covering:
  - Create 101 snapshots at > interval spacing → list shows 100
  - Create 2 snapshots at < interval spacing → list shows 1, with the second timestamp
  - Set max_count to 5 in Settings, restart (or re-open), create → prune kicks in on next create

WebDAV upload is NOT exercised by E2E (mock-only project, no live server). Covered by §9.3.

---

## 10. Future Work (not in this spec)

1. **Fix the existing sync.rs collision bug**: `sync.rs` still writes to `novelist/{project_name}/` without hash disambiguation. Two projects with the same folder name will clobber each other on WebDAV. Recommend adopting the `{slug}-{hash8}` scheme from §6.1 + a `project.json` identity check. This change would be a one-file diff in `sync.rs::perform_sync`, plus a migration note (users with existing sync'd data need to either re-sync under the new path or manually rename on the server). Tracking as a separate follow-up — not conflated with the snapshot work to keep the review surface small.
2. **Pinned snapshots**: `pinned: bool` exempt from prune.
3. **Remote restore**: list remote snapshots, download, restore. Current v1 keeps WebDAV as write-only backup.
4. **Partial restore**: pick specific files/dirs from a snapshot instead of overwrite-all.
5. **Upload retry UI**: per-snapshot remote_status field + retry button.
6. **Background upload queue**: today uploads block the create response on the network. Moving to a tokio background task would feel snappier, but needs state tracking we don't have yet.

---

## 11. Touch List

| File | Change |
|---|---|
| `core/src/models/settings.rs` | `SnapshotConfig`, `ResolvedSnapshot`, constants, `resolve()` extension, tests |
| `core/src/models/project.rs` | Add `snapshot: Option<SnapshotConfig>` to project TOML overlay |
| `core/src/commands/settings.rs` | Extend `write_global_settings` / `write_project_settings` / `get_effective_settings` |
| `core/src/services/snapshots.rs` | Rewrite `create_snapshot` to the §4 flow; add `Clock` seam; add pending-dir cleanup; reuse `delete_snapshot` for pruning |
| `core/src/services/snapshots.rs` (new submodule or inline) | Remote upload helpers (`upload_snapshot`, `delete_remote_snapshot`, `project_json_identity_check`, slug/hash helpers) |
| `core/src/commands/snapshot.rs` | No signature change; still returns `SnapshotMeta` |
| `app/lib/stores/settings.svelte.ts` | Add snapshot section getters + `writeSnapshotConfig` |
| `app/lib/components/Settings.svelte` | Add Snapshots section UI |
| `app/lib/components/SnapshotPanel.svelte` | No logic change |
| `app/lib/ipc/commands.ts` | Auto-regenerated from specta |
| `app/lib/i18n/locales/{en,zh-CN}.ts` | New strings: `settings.snapshot.*`, `settings.snapshot.webdavHint` |
| `tests/unit/stores/settings-store.test.ts` | Extend |
| `tests/e2e/fixtures/tauri-mock.ts` | Mock retention rules |
| `tests/e2e/specs/snapshot-retention.spec.ts` | New |

---

## 12. Open Questions

None at spec time — all brainstorming questions resolved. Reviewer may push back on:

- **WebDAV enable-toggle reuse** (§6.4): should snapshots ignore `sync.enabled` and only check for credentials? Current spec couples them. Easy flip.
- **Settings default** (100 / 60): user picked these as examples, not hard requirements. Easy to tune.
- **Slug sanitization**: current spec keeps CJK; some WebDAV servers may mis-encode non-ASCII in PROPFIND responses. If this turns out to be a real problem in testing, fallback is pure-ASCII slug via `percent_encode`.
