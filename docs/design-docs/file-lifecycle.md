# File Lifecycle

The watcher, rename suppression, auto-rename, and cross-window broadcast
form one coupled system. Breaking any of them leads to rename echoes or
dirty-state flaps.

## File watcher + self-write suppression

- BLAKE3 hashing detects self-writes (app writes → watcher sees → would
  otherwise think external change → prompts conflict dialog on user's
  own save). The Rust write path hashes the exact encoded bytes staged for
  atomic rename and registers that expected hash immediately before rename.
  Only an observed event with the same hash is suppressed; a distinct external
  write immediately after save is never hidden by a time-only ignore window.

## External-edit auto-reload (watcher + polling fallback)

A non-dirty open tab reloads automatically when its file changes on disk;
a dirty tab raises the conflict dialog instead. Both flow through
`deliverExternalChange()` in `app/lib/composables/app-events.svelte.ts`, fed
by **two** independent sources:

1. **notify watcher** (`start_file_watcher`) — receives OS events promptly, but
   frontend delivery intentionally coalesces each canonical identity for about
   1,050ms so notify and the one-second poll converge before handling. Watcher,
   watched-directory, and cancellation ownership is per window. Notify emits
   one owner-scoped payload to each window label, containing only that window's
   registered aliases.
2. **Polling fallback** (`poll_external_changes`, called every 1s from
   `app-events`) — re-hashes every *tracked open file* (mtime-gated `stat`,
   then BLAKE3) and returns canonical identity payloads. Each tracked identity
   has an independent pending cursor per window, so one window polling cannot
   consume another window's delivery.

The poll exists because the watcher has real coverage gaps that left external
edits requiring a manual re-open:

- **Single-file mode** (a file opened with no project, e.g. `Open File`, CLI,
  drag) starts **no** watcher at all — only the poll reloads it.
- **Symlinked roots.** macOS FSEvents reports canonical paths; a project under
  a symlink (`/tmp`, `/var`, an external mount, iCloud "Desktop & Documents"
  where `~/Documents` is a symlink) can have its events dropped. Two defenses:
  `start_file_watcher` now watches the **canonical** dir (with
  `normalize_event_path` mapping events back to the original prefix), and the
  poll catches anything still missed.
- **Coalesced/dropped OS events.** The poll is a backstop.

Canonical identity owns the detection baseline; opening another symlink or
case-form alias adds an owner without replacing the existing hash/mtime. Notify
and poll commit their off-lock hash snapshots only when the tracked hash still
matches the snapshot, preventing stale work from overwriting a newer baseline.
Existing aliases are canonicalized again before delivery, so a symlink that was
retargeted to another file identity cannot receive the previous identity's
content. Missing aliases are retained long enough to preserve deletion handling.

Frontend queues, generations, IME deferrals, and debounce timers are keyed by
canonical identity while each queued value retains every owner path. A rename
broadcast retargets pending and IME-deferred paths before delivery. Independent
identity timers prevent activity on one file from postponing another, and a
failed delivery is caught independently instead of aborting sibling identities.

Note both reload paths are wired inside App.svelte's post-first-paint
`requestAnimationFrame`, and `setInterval` is throttled while the window is
hidden — so a backgrounded Novelist catches up within ~1s of being refocused,
which is exactly when the user is looking at it.
- `register_rename_ignore(old, new)` is called *before* the rename so the
  watcher doesn't emit stale events for either path during the transition.
- `file-changed` handler in `app/lib/composables/app-events.svelte.ts`
  must tolerate paths without `/` (root-level files have no parent
  slash); guard parent-path calc accordingly.

## Save flow auto-rename

`tabsStore.tryRenameAfterSave(filePath, content)` runs after every
successful `writeFile`. It runs only when persisted managed-name state says
the document is `managed`. A placeholder such as `Untitled 2.md` takes its
first non-empty H1 name; later H1 changes keep the managed filename in sync.
`rename_item(..., allow_collision_bump: true)` adds a ` 2`/` 3` suffix on
collision. Manual rename preserves managed state. Only the explicit Stop Auto
Naming action changes the state to `detached`; ordinary files are never
enrolled by inference.

Automatic enrollment is limited to Markdown documents (`.md` and `.markdown`).
Canvas, kanban, text, JSON, and plugin-created non-Markdown files remain
unmanaged even when the current new-file template contains `{title}`. Creation
captures the source template before creating the file, writes the managed-name
sidecar after the final path exists, then reads the same sidecar back and
requires an exact state match. Sidebar `createFileAt` exposes its immediate
inline rename only after that durable state is observable; a failed or
unobservable enrollment leaves the created file in the tree without starting a
rename that could outrun sidecar migration.

Re-enable Auto Naming persists `managed` first, then requests one reconciliation
pass against the current H1. That pass may repair a manually renamed filename
even when the H1 text is unchanged from the stored anchor. Ordinary saves retain
the unchanged-H1 fast path, so this forced reconciliation is scoped to the
explicit re-enable control.

## Rename transaction and sidecar migration

Rename is a two-phase operation shared by manual rename, managed H1 rename,
and folder rename. The durable order is:

1. The frontend rename coordinator flushes every registered provider for the
   old path, including descendants of a renamed folder. DraftNote flushes its
   ordinary note chain, while Editor independently flushes crash-recovery state.
   The Publish dialog waits for any cover mutation and flushes each pending
   `(project, old path, stable channel id)` form write. A rejected flush or the
   5-second coordinator timeout stops the operation before rename IPC.
2. Rust collects the exact old-to-final file mappings and atomically writes a
   rename journal under `.novelist/rename-migrations/`. A file journal contains
   exactly one mapping. A folder journal contains its regular-file descendants,
   preserves relative paths, and skips symlinks and `.novelist`.
3. Rust calls `register_rename_ignore(old, final)` before touching the user
   file, then performs the filesystem rename. The old and final paths are both
   registered so the next notify event for either path is consumed.
4. After the user file has moved, Rust migrates draft and crash-recovery notes,
   managed-name state, and Publish sidecars for every journal mapping. Publish
   migration shares the project cover-asset transaction lock with cover
   replacement and cleanup. Encoding state is then retargeted from the
   canonical old tree to the canonical final tree.
5. Only after migration status is known does the command emit `file-renamed`.
   The payload contains the final path and migration result. The initiating
   window and other windows then retarget open tabs and refresh the affected
   sidebar folders. A broadcast failure is reported in the migration result;
   it does not turn the completed user-file rename into a failed rename.

The frontend and backend boundaries are implemented in
[`rename-coordinator.ts`](../../app/lib/services/rename-coordinator.ts),
[`file.rs`](../../core/src/commands/file.rs), and
[`rename_migration.rs`](../../core/src/services/rename_migration.rs). The
ordering contract is covered by
[`rename-coordinator.test.ts`](../../tests/unit/services/rename-coordinator.test.ts)
and the rename tests in `file.rs`.

### Atomicity and failure states

The user-file rename is one filesystem rename. The journal, each destination
sidecar write, and each conflict-copy write use a sibling temp file, file
`flush`/`sync_all`, and atomic replacement. Those are separate atomic
operations. Moving the user file plus several sidecars is **not** one atomic
transaction, and no document should claim otherwise.

`RenameMigrationStatus` distinguishes the outcomes:

- `full_success`: the user file and all known metadata moved, and the journal
  was removed.
- `user_file_renamed_with_metadata_errors`: the user file moved, but one or
  more sidecar migrations, journal cleanup steps, or the final broadcast
  failed. The final user path remains authoritative and is never rolled back.
  Any source whose preservation is uncertain remains available. The journal
  remains when migration or journal cleanup did not converge. A broadcast-only
  failure happens after successful migration removed the journal, so that case
  is reported but is not journal-retryable.
- `idempotent_retry`: the old user path is already absent, the final path and a
  matching journal exist, and replay converged successfully. The journal is
  removed only after the replay completes.

Calling the same rename after a partial metadata failure is the recovery action
only while the matching journal remains. Rust loads only the journal whose
project, roots, root kind, and mappings match the requested rename. A final path
without that journal is not treated as proof that a prior rename succeeded, so
repeating a broadcast-only failure returns File Not Found instead of replaying
the event. Replaying a successful journal mapping is a no-op: equivalent
destination data is retained, stale source data is removed, and no additional
conflict copy is created.

### Sidecar keys and conflicts

DraftNote, Publish, and managed-name sidecars use the canonical project-relative
`document_key` from [`sidecar.rs`](../../core/src/services/sidecar.rs). Path
segments are safely encoded and joined with `%2F`; literal percent sequences
cannot collide with a nested path. CJK and spaces remain readable, and `/` plus
`\` inputs normalize to one key. Keys longer than 140 bytes are a UTF-8-safe
readable prefix plus `~` and a deterministic 128-bit BLAKE3 suffix, which keeps
active and conflict filenames below the cross-platform component limit. Parent
traversal, paths outside the project, nulls, and unsafe filename components are
rejected. Root-level keys remain unchanged. Absolute scratch files outside the
project retain DraftNote's exact basename fallback for single-file
compatibility; access fails closed if that basename would alias an existing
root document. A leading dot in the first project-relative component is encoded
as `%2E`, allowing hidden root files/directories to satisfy the canonical
sidecar filename grammar.

Ordinary DraftNote read, write, delete, and existence commands reconcile a
recognized legacy `/` or `\` to `__` flattened entry into the canonical key
before acting. Rename migration uses the same canonical helper and recognizes
both old source forms. Equivalent duplicates collapse to one active canonical
file. When canonical and legacy bytes differ, original modification time chooses
the active value; canonical wins an exact timestamp tie. The older bytes are
stored once through the deterministic conflict-copy policy before the obsolete
active key is removed. A later ordinary write therefore updates the same
canonical destination produced by rename migration instead of recreating a
legacy active note. Legacy filenames are validated as complete single
filesystem components rather than against the canonical 140-byte key budget.
Component limits use filesystem bytes on Unix and UTF-16 code units on Windows,
so valid pre-migration CJK names remain readable while canonical long keys use
their bounded hash form.

Legacy flattening is inherently ambiguous when multiple live project files map
to one `__` name (for example `a/b.md` and root `a__b.md`). Reconciliation scans
the project tree only when that legacy sidecar exists and compares its storage
name with both canonical and legacy claims from every other live file. An
ambiguous candidate is never consumed: its bytes are retained at the source and copied once to a
deterministic conflict path for recovery. Ordinary access continues from an
existing canonical value or reports no active nested note; rename migration
reports a metadata error so the journal remains available.

The first root directory listing during project open reconciles claimed legacy
normal and `.~recovery` entries for every live non-symlink project file. The
walk skips `.novelist` and does no work while a rename journal is pending. It
acquires the canonical-project Draft transaction guard before inspecting the
journal directory, so a journal that appears while reconciliation is queued is
observed and a journal removed by a completed retry permits the queued walk to
continue. Concurrent project reconcilers serialize through the same guard.
Legacy entries with no live owner are never selected by the walk, and ordinary
read/has/delete operations also require a live owner before considering a legacy
candidate or accessing the canonical storage name. This also protects an
ownerless nested legacy key whose spelling equals a missing literal document's
canonical key. Unmatched bytes remain untouched for manual recovery; pending
journal reservations still surface before the missing-owner no-op.

For each draft, recovery, managed-name, or Publish sidecar:

- If only the old key exists, its bytes are atomically written at the final
  key, then the old key is removed.
- If old and final bytes are equivalent, the final copy wins and the duplicate
  old copy is removed. Managed-name JSON is compared semantically after its
  embedded `documentKey` is changed to the final key.
- If both differ, modification time selects the active value. Draft migration
  snapshots the original destination plus canonical and legacy source bytes and
  mtimes, then selects one global winner before writing. Destination wins a tie,
  followed by canonical source, then legacy source; intermediate atomic-write
  timestamps never participate in precedence. Every distinct loser is
  conflict-copied before the winner is persisted.
  The older bytes are first stored beside the destination as
  `<stem>.conflict-<marker>.<ext>`. The marker is the first 16 hex characters
  of BLAKE3 over destination path, source path, older bytes, and newer bytes,
  so the name is deterministic across retries.
- An existing conflict file is accepted only when its bytes equal the expected
  older value. Different bytes at that deterministic path fail closed. The
  source remains and the result reports a metadata error.
- A managed-name source containing invalid JSON is retained at the old key and
  reported as an error. Valid JSON updates `documentKey` only when that field is
  present; a valid object without the field, or another valid JSON shape, moves
  unchanged and may later be rejected by the managed-name schema reader. More
  generally, source cleanup happens only after the destination or every conflict
  copy is safely persisted. Draft source/destination bytes are revalidated
  before persistence and each source is checked again before cleanup. Losing
  sources are removed before the winning source, so a partial cleanup failure
  leaves original winner metadata available to a journal retry. Publish
  migration copies raw sidecar bytes; later
  Publish reads still retain and report malformed JSON rather than repairing it
  silently.

DraftNote commands plus draft and Publish rename migration open `.novelist`
metadata through a canonical project capability. Metadata directories use
no-follow directory opens; reads and mtime inspection atomically open the final
component with `FollowSymlinks::No` and require an opened regular file. Atomic
writes replace a symlink entry rather than following it, and deletion unlinks
the confined entry without following its target. Managed-name migration still
uses its existing path-based atomic storage and is not covered by this
capability-confinement statement.

Ordinary DraftNote operations and `rename_item` share one canonical-project
transaction lock. Rename holds it from before journal creation and filesystem
rename through draft migration and successful journal removal. The lock order is
Draft transaction guard, then journal inspection or mutation, then Draft
sidecar migration; rename may subsequently acquire the cover-asset transaction
lock for Publish migration. Inner reconciliation and journal helpers do not
reacquire the non-reentrant Draft guard. Project-scoped writes also require the owning
document (or the document underlying a `.~recovery` path) to still exist while
the lock is held. A delayed save targeting an already-renamed old path therefore
fails instead of recreating an obsolete active key. Persisted pending journals
reserve every old normal/recovery storage key, blocking stale delete and
colliding outside-scratch access after a crash until retry converges. Reservation
checks cover both the requested document's canonical key and its legacy
candidate, preventing another document from claiming a pending source.

Normal and `.~recovery` draft keys migrate independently. Within rename
migration, a chain such as `a.md` to `b.md` to `c.md`, including edits between
renames, converges to one active `c.md` key for drafts, recovery, managed-name,
and Publish state, with no active `a.md` or `b.md` artifacts. Nested DraftNote
reads remain available after each rename and later ordinary writes continue at
the canonical destination. Conflict copies exist only for genuinely different
older data and remain references during Publish cover orphan scans.

## Cross-window file-renamed broadcast

When one window auto-renames a file after an H1-driven save, every window
needs to know so open tabs don't point at stale paths.

- Backend: both `rename_item` and `move_item` emit the migration-bearing
  `file-renamed` event after migration status is known. The separate legacy
  `broadcast_file_renamed` IPC command remains available only for compatibility
  with callers that perform a path-only handoff outside those lifecycle
  commands; normal rename and move flows do not call it a second time.
- Frontend: `app/lib/composables/app-events.svelte.ts` listens for
  `file-renamed` and calls `tabsStore.updatePath(old, new)` in every
  window, plus refreshes the parent folder in the sidebar.

The explicit broadcast is the path-identity handoff. It is separate from OS
watcher delivery: rename-ignore consumes self-generated notify events, while
the existing one-second poll remains a content-hash fallback for tracked open
files. External notify and poll results still coalesce through
`handleExternalChange()`; clean tabs reload the latest content, dirty tabs keep
their buffer and enter conflict handling, and IME composition defers reload
until composition ends.

## Encoding state migration

`rename_item` migrates any encoding-state entry to the new path — otherwise
UTF-16/BOM files lose their encoding after rename.

## Recent projects: pin + manual order

`core/src/commands/recent.rs` persists `~/.novelist/recent-projects.json`.
Each `RecentProject` has optional `pinned: bool` and
`sort_order: Option<i64>` (both `#[serde(default)]`, so legacy files
deserialize cleanly). Canonical sort is `sort_projects()`: pinned before
unpinned, then ascending `sort_order` (None after Some), then descending
`last_opened` as tiebreaker. `set_project_pinned` toggles pin;
`reorder_recent_projects(ordered_paths)` rewrites `sort_order` by
position. `add_recent_project` preserves existing pin/sort_order when a
user re-opens a project.

`get_recent_projects` takes a fast path on boot: it returns the list
immediately without `Path::exists()` stats, then fires a background
tokio task that filters missing paths and emits `recent-projects-updated`
(listened to in `app/lib/composables/app-events.svelte.ts`) when the set
changes. Welcome screen wires a pin button per row; the Tauri mock
mirrors the same sort for browser-mode E2E.

## Portable mode path resolution

Windows ships an optional truly-portable zip distribution. The marker file
`portable.dat`, sitting next to `Novelist.exe`, switches the app into portable
mode at startup (`core/src/services/portable.rs`).

In portable mode:

- `services::portable::novelist_home()` returns `<exe_dir>/data/` instead of
  `~/.novelist/`. All user data (settings, plugins, recent projects, writing
  stats, sync, snapshots, templates) flows through this helper.
- The Tauri updater plugin is not registered (`core/src/lib.rs` `run()`), and
  the "Check for updates" command shows an info dialog instead of triggering
  a check.
- The asset protocol scope is extended at runtime to allow loading plugins
  from `<exe_dir>/data/plugins/**`, since the static `tauri.conf.json` scope
  only covers `$HOME/.novelist/plugins/**`.
- Startup panics with a clear error if `<exe_dir>/data/` cannot be created or
  written — we never silently fall back to `%APPDATA%`.

The standard (`Novelist_<ver>_x64_windows.zip`) and portable
(`Novelist_<ver>_x64_windows-portable.zip`) zips contain the same binary;
only `portable.dat` differs.
