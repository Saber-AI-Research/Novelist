# File Lifecycle

## Sidebar selection and destructive actions

The sidebar tree is an ARIA multi-select tree. An unmodified row click selects
one entry and preserves its existing open/toggle behavior; Shift selects the
visible contiguous range from the anchor, while Command/Ctrl toggles individual
entries. Collapsing or refreshing a branch prunes hidden selections so a
keyboard delete cannot target an invisible stale row. `Backspace` and `Delete`
are handled only when focus is inside a tree row and never from rename/create
inputs.

Sidebar deletion and the command-palette `delete-current-file` command share
`app/lib/services/file-deletion.ts`. It confirms once, collapses descendants of
selected folders, runs the normal unsaved-tab close flow for every affected
tab, aborts before filesystem mutation if any close is cancelled, calls the
existing `delete_item` IPC command, removes workspace paths, and refreshes each
affected parent folder. `Sidebar.svelte` remains the owner of visible selection
state; the service owns the destructive lifecycle.
Cancellation is checked by the just-closed tab ID, not by file path: another
pane may still display the same document and must be processed separately.

The watcher, rename suppression, auto-rename, and cross-window broadcast
form one coupled system. Breaking any of them leads to rename echoes or
dirty-state flaps.

## File watcher + self-write suppression

- BLAKE3 hashing detects self-writes (app writes → watcher sees → would
  otherwise think external change → prompts conflict dialog on user's
  own save). The Rust write path hashes the exact encoded bytes staged for
  atomic rename. The expected hash also records the saving window's label.
  Only that owner's matching event is suppressed; other owners retain their
  notification and polling cursor. Background writes with no owner notify every
  owner. A distinct external write is never hidden by a time-only ignore window.

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
  Entries expire after 5 s and are withdrawn (`clear_rename_ignore`) when the
  rename fails, so they never swallow a later real event.
- Notify commits the file's on-disk mtime together with its hash, and both
  notify and the poll adopt the new mtime when the bytes are unchanged, so the
  poll's stat gate keeps skipping saved or touched files. Hashing runs on
  blocking threads, never on the async workers. `directory-changed` goes only
  to the window whose watcher saw the event.
- Closing a window releases its watcher, debounce task, poll cursors and
  tracked aliases (`release_window_resources` in `lib.rs`); window labels are
  never reused, so nothing else would free them.
- `file-changed` handler in `app/lib/composables/app-events.svelte.ts`
  must tolerate paths without `/` (root-level files have no parent
  slash); guard parent-path calc accordingly.

## Encoding-preserving saves

Normal and conditional saves reject text that the original legacy encoding
cannot represent, before creating a temporary file or registering watcher
suppression. The original disk bytes and encoding state remain unchanged;
the save reports an error rather than silently replacing characters or
converting to UTF-8.

UTF-16LE and UTF-16BE saves explicitly encode UTF-16 code units with the original
endianness and BOM, including surrogate pairs. `encoding_rs::Encoding::encode`
is not used for these encodings because its UTF-16 output encoding is UTF-8.
Normal and conditional saves resolve symlinks before choosing the write lock,
encoding identity, sibling temporary file, and rename destination. Saving an
alias therefore updates the real target without replacing the link.

Template-created files stage bytes in an exclusively created sibling temporary
file and publish without replacing an existing destination. A collision retries
the numbered name; existing `.novelist-tmp` files and dangling symlinks are not
overwritten. Project TOML is serialized through `ProjectConfig`, not interpolated
from unescaped project names.

## WebDAV synchronization

`services/sync.rs` reconciles each file three ways against a common BLAKE3
content hash, the baseline. Only successful transfers, propagated deletions or
byte-equality advance it; conflicts and failed transfers leave it unchanged and
appear in `SyncStatus.errors`. Conflicted paths are also listed in
`SyncStatus.conflicts` until they are resolved explicitly (see below).

| Local | Remote | Action |
|---|---|---|
| equals remote | equals local | nothing; the baseline becomes that content |
| unchanged since baseline | changed | download |
| changed | unchanged since baseline | upload with `If-Match` |
| unchanged since baseline | deleted | keep a copy in app data, then delete locally |
| deleted | unchanged since baseline | `DELETE` with `If-Match` |
| new, or changed | absent or deleted | upload: an edit wins over a deletion |
| absent or deleted | new, or changed | download: an edit wins over a deletion |
| changed | changed differently | conflict; nothing is transferred |

A rename, including an automatic managed-name rename, is a deletion of the old
path plus a new file, so it reaches every device without leaving a stale copy
under the old name. A locally deleted file is first copied to
`<app data>/sync/<project-hash>/deleted/<run>/<path>`, and removed only while
its bytes still equal the baseline. An iCloud Drive placeholder
(`.<name>.icloud`) means the file was evicted, not deleted; it is reported and
the remote copy stays. Empty directories are left in place. Upload and
download counts in `SyncStatus` include propagated deletions.

Baselines from completed transfers are saved even when the run stops later (a
failed request, or an identity check), so a later edit is not turned into a
permanent conflict; `last_sync` advances only after the closing identity check.
Legacy timestamp-only states remain readable: equal versions establish a common
hash, while differing versions require explicit reconciliation instead of
guessing from timestamps.

Listings request `getetag`. The strong ETag received with a baseline (from the
GET or PUT response) is stored next to it; while a later listing still reports
that ETag the remote bytes equal the baseline and the GET is skipped. Missing
or weak ETags always fall back to a full download.

Each project carries a versioned, random identity in
`.novelist/sync-identity.json`. Keep this file when moving or copying the same
logical project to another device. Independent projects with identical names
use different `novelist-sync/<project-id>/` remote trees. The remote tree carries
the same identity card and must pass identity validation before file transfers;
a nonempty tree with a missing or mismatched card is not adopted. Credentials
remain in the application data directory, outside the project identity card.
Baselines are bound to the project ID, WebDAV URL, and account. The card is
staged in a temporary file, fsynced, and published with a hard link (or, on
filesystems without links, a rename while no card exists): a crash never leaves
a partial card, and creation never replaces an existing one.

Legacy `novelist/<project-name>/` trees have no trustworthy identity. If a
nonempty legacy tree exists when initializing a new namespace, sync stops until
the writer backs it up, reconciles its files into the intended local project,
and explicitly checks the legacy migration acknowledgment in Settings → Sync.
That first device then publishes a claim card,
`novelist-sync/legacy-claims/<project-name>.json`, naming its project ID. The
claim is created with `If-None-Match: *`, so exactly one device wins, and only
then is its namespace seeded. Any other copy whose own identity was never
published finds the claim — even if it also acknowledged, and even after the
legacy tree was cleaned up — and stops with `SyncStatus.adoptable_project_id`
instead of starting a second namespace that would silently split the devices.
Settings → Sync then offers "Join existing sync namespace"
(`adopt_sync_identity`). It verifies that the local identity owns no remote
data, that the claim still names the offered ID and that the namespace's own
card matches, then atomically replaces the local card. The next sync starts with
fresh baselines: identical files are adopted, one-sided files transfer, and
files that differ are reported as conflicts. A different project that only
shares the folder name is renamed instead. Sync never imports, overwrites, or
deletes the legacy remote tree, and a device carrying an already established
identity never needs to acknowledge it again. A deliberately independent fork
must use a fresh project identity rather than copy the original identity card.

The settings form shows a stored password as `****`. `save_sync_config` and
`test_sync_connection` substitute the stored password only while the WebDAV URL
and username are unchanged; after either changes, the password is cleared
rather than sent to the new host. Config files are read and written on
blocking threads.

Recursive local/remote discovery uses the shared project-content allowlist,
applied before any name check: non-content files such as macOS `Icon\r` are
ignored, and a content file whose name cannot be represented remotely
(non-UTF-8, control characters) is skipped and reported without stopping the
rest of the sync. Directory capabilities reject local symlink traversal.
Downloads compare local bytes again before atomic replacement; uploads use
`If-None-Match: *` for new files or a strong ETag precondition for existing
remote files. A server without a usable ETag cannot safely accept an automatic
overwrite or deletion; the error is surfaced.

All WebDAV operations construct URLs by encoding logical path segments once.
CJK and literal `#`, `?`, `%` filenames retain distinct identities. DAV hrefs
are decoded once and confined to the queried collection; traversal, ambiguous
encoded separators, fragments and embedded URL credentials are rejected.

Project file downloads hold at most 256 MiB per file, listings at most 32 MiB
of XML and a snapshot `project.json` at most 16 KiB; a larger response fails
that request instead of exhausting memory.

Snapshot mirroring removes any stale completion marker before retrying content.
Every directory and file transfer must succeed and match local metadata counts
before the final `metadata.json` PUT. Failed uploads remain visibly incomplete.
Requests, including response bodies, have a 30-second deadline; a snapshot upload
has a 300-second overall limit. Mirroring runs after the snapshot lock is
released, under a per-project mirror lock taken before it: listing and
restoring never wait for WebDAV, while uploads and remote deletions stay in
order. A retired snapshot's remote copy is deleted only after its replacement
uploaded completely. An unreadable snapshot folder is logged and skipped, and a
failed local retirement is logged, so neither blocks listing or creation.

### Cloud account

A device can connect one cloud account (`services/cloud.rs`, Settings → Sync →
Cloud account): a WebDAV folder URL, a user name and an app password created
for that device at an existing provider such as Nextcloud or a self-hosted
WebDAV server. Novelist runs no account service of its own: registration,
password resets and revoking a lost device happen at the provider. Writing
locally never requires an account.

`connect_cloud_account` validates before storing anything. The URL must be
`https://` (plain `http://` only for a loopback host, for development) and may
not carry a user name, password, query or fragment; the user name may not
contain `:`. An authenticated Depth-0 `PROPFIND` must answer `207` with a
collection; `401` is reported as rejected credentials, and redirects are
reported, never followed, so the password cannot reach another host. Only
then is the password written to the vault and the account record
(`<app data>/cloud/account.json`: URL, user name, time; never a secret)
written. The vault entry stores the password together with the URL and user
name it was entered for and releases it only for exactly that pair, so a
tampered record or project config cannot redirect it.

The connection check proves only that the URL is an authenticated WebDAV
folder, not that the server is safe to sync with. Sync relies on the server
for its lost-update protection, so a supported server must: return a strong
`ETag` that changes whenever a file's bytes change (also for same-length
writes within the same second); answer `412` to a `PUT` with
`If-None-Match: *` when the file exists and to a `PUT` or `DELETE` whose
`If-Match` no longer matches; and serve the configured URL without redirects.
A server that accepts a stale precondition can silently overwrite or delete
another device's edit. Check a server against these requirements before
relying on it (the deployment guide covers Nextcloud and Apache `mod_dav`);
servers that fail them are unsupported, and sync does not work around them.

| Platform | Password storage |
|---|---|
| iOS | Keychain generic password, `AfterFirstUnlockThisDeviceOnly`, not synchronizable (`tauri-plugin-mobile-support`) |
| Android | Keystore AES-256-GCM key; ciphertext in app-private preferences, excluded from backup |
| Desktop | `<app data>/cloud/credential.json`, folder `0700`, file `0600`, written atomically; **not encrypted at rest** — readable by anything running as the same OS user, and included in unencrypted backups of the home folder |

Mobile has no plaintext fallback: without the native vault every credential
operation fails. No command returns the password to the WebView; the account
summary and status carry only the URL, host, user name and connection state.

A project uses the account when its sync config has `cloud_account: true`
(`bind_cloud_project`). The per-project config then keeps only the URL and
user name naming the account, never a password; every sync, conflict
resolution and snapshot upload resolves the password from the vault at that
moment. A project linked to a different URL or user than the connected account
is refused before any request. Connecting an account links projects already
configured for exactly that URL and user and removes their per-project
password copy; on mobile every other stored per-project password is removed
as well and that project's sync turned off. Baselines are bound to URL, user
and project ID, so linking a project changes none of them and nothing is
re-sent. On mobile `save_sync_config` rejects per-project passwords.

`disconnect_cloud_account` deletes the vault entry and the account record and
turns sync off for linked projects (`unbind_cloud_project` does the same for
one project). It deletes no local or remote file and keeps baselines, so
linking again continues where the project left off.

All authenticated cloud work (sync of a linked project, conflict resolution,
snapshot mirroring, listing, download, connection checks) holds a shared
account lease for its whole duration. Disconnecting, or connecting a
replacement account after its credentials were verified, first asks every
lease to stop and then waits until all are released: listings, checks and
snapshot mirroring stop at their next await, a sync stops between files and
keeps the baselines it completed, and a download stops before publishing (its
staging folder and sync data are removed). When the change returns, no
request, publication or project link on behalf of the previous account is
still in flight. A download holds one lease through its whole sync rather
than taking a second one, which could wait forever behind the change.

A download's final commit (last revocation check, publishing the folder,
moving its sync data) and the change's stop signal share a small commit gate,
held only for those synchronous steps and never while waiting for leases.
Whichever takes it first goes first: after the signal no download publishes;
a commit that already started completes, and the change is signalled after
it. Such a project stays published — nothing visible is rolled back — and is
then unlinked by the disconnect (after a replacement it remains linked to the
previous account and reports that until it is linked again).

Offline edits need no separate queue: the files and their baselines are the
queue. The app syncs a linked project on its interval, when it returns to the
foreground, and when the network comes back; a failed run leaves every
baseline that was not completed unchanged and is simply retried.

### New devices

`list_cloud_projects` lists `novelist-sync/` (at most 1 MiB of XML and 1000
entries; an href escaping the folder rejects the whole listing) and describes
at most 200 folders named by a valid project ID. A folder counts only when its
own identity card (at most 1 KiB) names that ID; the display name comes from
its `.novelist/project.toml` (at most 64 KiB), stripped of control and
bidirectional-format characters and limited to 120 characters.

`download_cloud_project` never writes into an existing folder. In a hidden
staging folder inside the destination (the mobile project library, or a folder
chosen on desktop) it writes the exact remote identity card, links the
account, and runs the regular `perform_sync`, so every file arrives with its
baseline and later deletions propagate as on any other device. Only an
error-free result is published, under a free name, with one rename; its sync
config and baselines move to the published path. Otherwise the staging folder
and its sync data are removed and nothing appears. A project whose identity
already exists in the destination is opened instead of downloaded twice.

### Resolving conflicts

A file changed differently on both sides is never transferred automatically.
`resolve_sync_conflict(project, path, resolution)` settles one path from
`SyncStatus.conflicts` under the project's sync lock, after re-checking the
project identity on both sides and the baseline's account binding:

| Resolution | Effect |
|---|---|
| `keep_local` | upload this device's copy with `If-Match` on the remote ETag just read |
| `keep_remote` | download the remote copy, replacing the local file only while its bytes still equal what was read |
| `keep_both` | save the remote copy as `<name> (remote <date time>).<ext>` beside the file (never replacing one), then `keep_local`; the next sync shares the copy. Not offered for `.novelist/` settings files |

The version being replaced is first saved to
`<app data>/sync/<project-hash>/conflicts/<run>/{local,remote}/<path>`. The
resolved content becomes the new baseline.

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

## Per-project workspace restoration

`app/lib/services/project-workspace-state.ts` stores lightweight UI session
state in versioned local storage, keyed by the normalized project directory.
Only safe project-relative paths are persisted: the set of visibly expanded
sidebar folders and the last active file. `projectStore.setProject` restores
folders in parent-before-child order, and `App.svelte` reopens the last file
only after the target project and watcher have committed. A missing folder or
file is pruned instead of blocking project open.

Rename and move flows retarget the saved path and all descendants through the
same `tabsStore.retargetOpenPath*` handoff used by live tabs. Successful sidebar
deletion removes the corresponding workspace branch. Collapsing a folder drops
its persisted descendant expansion entries, preserving the visible tree shape
on the next launch. The state is UI-local rather than project content, so it
does not alter `.novelist/project.toml` or travel with a shared manuscript.

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

## Mobile project library

iOS and Android cannot open arbitrary folders. `portable::init_mobile(app)`
runs first in `setup` and fails with the offending directory instead of
falling back to `$HOME`:

- `novelist_home()` is the private app data directory (settings, credentials,
  plugin data, snapshots, sync config and baselines, writing stats). It is
  never visible in the Files app.
- The project library is `Documents/Projects` on iOS (the only folder exposed
  through Files) and `<app data>/Projects` on Android.
- `portable::cache_root()` is the app cache directory; `imports/` holds staged
  picker files and `exports/` holds share-sheet output.

iOS relocates the app container on updates, so nothing persisted names a
library project by absolute path. `portable::project_storage_key(path)` is the
project path on desktop (unchanged layout) and `library:<relative path>` for
library projects on mobile; local snapshots, sync config/state and writing
stats hash it. `recent-projects.json` stores the same key and resolves it
against the current library root on read, and mobile `write_project_settings`
stores `[new_file]` directories relative to the project
(`get_effective_settings` resolves relative values on every platform). The
WebDAV snapshot backup folder is not name-based on mobile: it is
`novelist-snapshots/project-<sync project id>` (identity created on first
upload), so clones and renamed copies share it while independent projects
with the same name on different devices stay isolated. Desktop keeps
`<slug>-<hash8(path)>`.

`core/src/commands/library.rs` owns the library commands (desktop returns
`AppError::Unsupported`); new projects reuse `create_project_from_template`
with `get_library_path()` as parent:

- `stage_import_file(name, base64_data)` writes at most 64 MiB into a fresh
  `imports/stage-*/<sanitized name>` folder; imports accept only such staged
  paths (canonicalized, so links out of staging are refused) and delete them
  after success.
- `import_library_file(staged_path, project_dir)` copies a document type
  accepted by `is_project_content_path` into a folder inside the library,
  publishing with no-clobber `name 2.md` bumps.
- `import_library_project(archive_path)` validates every ZIP entry first
  (≤ 20 000 entries, ≤ 512 MiB counted while reading; traversal, absolute,
  control-character and symlink entries abort), extracts into a hidden
  `.novelist-import-*` folder in the library, then reserves the final name
  and renames the whole tree into place. A failure removes the staging folder;
  nothing partial is visible.
- `export_library_project(project_dir)` writes
  `exports/<project>-<YYYYMMDD-HHMMSS>.zip` via a hidden temp file and a
  no-clobber rename. Reads go through a confined `cap_std` directory.
- `export_library_document(file_path, format)` exports one Markdown/text file
  as its original bytes (`markdown`) or as a sanitized standalone page
  rendered by pulldown-cmark (`html`); it is not a Pandoc equivalent.

Archives in both directions carry visible files and folders (content and
assets) plus the `.novelist` allow-list: `project.toml`,
`sync-identity.json`, `literary-study.json`, `book-translation.json` and the
`ai`, `chats`, `drafts`, `naming`, `publish`, `publish-assets` and
`templates` folders. Credentials, settings, caches, rename journals, hidden
files and `*.novelist-tmp` files never travel. An imported copy keeps its
sync identity, so it joins the original's WebDAV namespace. Disposable files
in `imports/`, `exports/` and stale library staging folders older than 24 h
are pruned on the next stage, export or import.
