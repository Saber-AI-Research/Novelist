# Settings Architecture

## Two-tier overlay: global defaults + per-project

Modelled on VSCode's `.vscode/settings.json` and Obsidian's `.obsidian/`:

- **Global defaults**: `~/.novelist/settings.json` (`GlobalSettings` in
  `core/src/models/settings.rs`). Scratch/no-project mode reads this only.
- **Per-project overlay**: `<project>/.novelist/project.toml`'s
  `[view] / [new_file] / [plugins]` sections (added to `ProjectConfig`).
  Field-level override — project values win when present; unset fields
  fall through to global; unset globals fall through to baked-in defaults.

### Backend commands (`core/src/commands/settings.rs`)

- `get_effective_settings(dir_path?)` — returns the merged
  `EffectiveSettings` (all fields concrete, plus
  `is_project_scoped: bool`).
- `get_global_settings()` — raw global-only, used by the frontend to
  compute plugin deltas.
- `write_global_settings(view?, new_file?, plugins?)` /
  `write_project_settings(dir, view?, new_file?, plugins?)` — patch one
  section at a time; others unchanged.

All global mutations (section patches, Publish channels, image hosts and Pandoc
path) use `update_global_settings`: one canonical destination lock spans strict
read, mutation and unique-temp atomic write. Only a missing settings file starts
from defaults; malformed existing data is not overwritten. Project writes use
`acquire_project_settings_guard`, also held by literary replacement and snapshot
capture/restore. Started filesystem workers retain their guards if the caller
is cancelled. Read-only helpers remain lock-free to avoid reentrant locking.

Frontend snapshot-setting responses use the same generation/scope checks as
other sections; a late project A response cannot overwrite project B's state.

### Frontend hub

`app/lib/stores/settings.svelte.ts` (`settingsStore`). Reads on project
open/close; routes writes to the current scope. `newFileSettings` and
`projectStore.sortMode` are thin shims over this store;
`projectStore.showHiddenFiles` is a getter that feeds
`listDirectory(path, show_hidden)`.

### Plugin deltas

Project's `[plugins].enabled` stores only entries that differ from the
global default. `settingsStore.writePluginEnabled` handles the delta math
automatically (delete-override-equals-global,
insert-override-otherwise).

### Seamless migration

`settingsStore.load(dirPath)` detects the old localStorage keys
(`novelist.sortMode.<path>`, `novelist.newFileSettings.v1`) on first
project open and copies them into `project.toml` before the
`get_effective_settings` read.

### Hidden files

`list_directory(path, show_hidden?: bool)` — every dotfile (including
`.novelist/`) is skipped by default; users flip the toggle via the
sidebar blank-area right-click menu
(`data-testid="sidebar-view-menu"`) to see project config directly in
the tree.

### View settings (`[view]`)

| Field              | Type   | Where surfaced |
|--------------------|--------|-----------------|
| `sort_mode`        | string | Sidebar header sort menu. Allowed values: `name-asc/desc`, `numeric-asc/desc`, `mtime-asc/desc`, `ctime-asc/desc`. Anything else coerces back to `numeric-asc` in `projectStore.coerceSortMode`. |
| `show_hidden_files`| bool   | Sidebar blank-area right-click toggle. |
| `wrap_file_names`  | bool   | Settings → Editor. When `true`, `FileTreeNode` adds `tree-row-wrap` so long names wrap to multiple lines instead of truncating with an ellipsis. |
| `sidebar_font_size`| u16    | Settings → Editor → Sidebar. Clamped to 12-18px and applied to `--novelist-sidebar-file-font-size` on the sidebar tree. |

`ctime-*` reads the new `ctime: Option<i64>` field on `FileEntry`,
populated from `metadata.created()` in `list_directory`. The
comparator (`app/lib/utils/file-sort.ts → compareByMode`) falls back
to `mtime` when `ctime` is null so filesystems without birth-time
support still produce a deterministic order.

### Snapshot retention (`[snapshot]`)

| Field                  | Type | Where surfaced |
|------------------------|------|-----------------|
| `max_count`            | u32  | Settings → Editor → Snapshots. Cap on kept snapshots; default 100. |
| `min_interval_minutes` | u32  | Settings → Editor → Snapshots. Default 60. `0` disables replacement entirely. |

Unlike the other sections, `ProjectConfig.snapshot` is
`Option<SnapshotConfig>` — an absent table inherits the global policy
wholesale, a present one overrides field-by-field like everything else.

`services/snapshots.rs` applies two rules, in this order:

1. **Replace within the interval.** If the newest snapshot is younger than
   `min_interval_minutes`, it becomes the victim and the new snapshot
   replaces it. A replacement keeps the count flat, so it deliberately does
   *not* trigger cap pruning.
2. **Prune to the cap.** Otherwise, anything past `max_count` is dropped
   oldest-first.

Snapshots stage into a `<id>.pending` directory and are `rename`d into
place, so a crash never leaves a half-written snapshot; stale `.pending`
dirs are swept on the next create and never surface in `list_snapshots`.
Old snapshots are only retired *after* the new one is durably in place.

A canonical-project lock serializes creation, cleanup, listing, deletion,
restoration and remote mirroring. Snapshot IDs include a unique monotonic suffix
so same-second creates cannot collide; legacy `snap-<seconds>` IDs and existing
path-hash storage namespaces remain readable. Lock order is snapshot, then
project settings; the settings lock is released before network mirroring.

`services/project_files.rs` defines the shared snapshot/sync allowlist. It includes
Markdown/text/JSON/CSV plus `.litstudy`, `.canvas`, `.kanban`, and exactly
`.novelist/project.toml` plus `.novelist/literary-study.json`. Other hidden data,
credentials, transaction backups and caches are excluded. Capture/restore use
directory capabilities and reject symlink components instead of following them.

Restoration stages and syncs every file before replacing originals through
same-directory atomic rename. Read/preflight/staging failure preserves original
bytes; a later rename error is reported and can leave earlier files restored.
This is per-file atomic recovery, not a whole-project rollback transaction.
Staged files share one pinned directory handle per distinct parent. A missing
project root does not hide or prevent deletion of existing snapshots; restore
recreates missing directory components without following symlinks.

Retention reads global settings and (with `feature = "sync"`) the WebDAV
sync config, so any unit test that calls `create_snapshot` must isolate all
three data-dir seams — `NOVELIST_SNAPSHOTS_DATA_DIR`,
`NOVELIST_SETTINGS_DATA_DIR`, `NOVELIST_SYNC_DATA_DIR` — and join the
`snapshots_data_dir, settings_data_dir, sync_data_dir` serial group.
Falling through to `portable::novelist_home()` panics in a test process.

### Filename template grammar

See `docs/product-specs/2026-05-07-v0.2.4-rename-and-macros.md` for
the full grammar. `parseTemplate` in `app/lib/utils/placeholder.ts`
enforces: at most one `{N}`-style counter slot, at most one
`{title}` slot, at least one of the two, and rejects unrecognized
brace-tokens up front so typos like `{cN}` / `{Title}` fail loudly.

## New-file location tracking

`NewFileConfig` carries two related fields beyond the template settings:

- `default_dir: Option<String>` — user-pinned default. Set via Settings >
  Editor > New File > "Choose…". When present, Cmd+N always creates here;
  `settingsStore.recordLastUsedDir` short-circuits so the pin wins.
- `last_used_dir: Option<String>` — the live recency pointer. Updated
  after every successful create (header button, Cmd+N, `createFileAt`
  from the context menus) via `settingsStore.recordLastUsedDir`.
  Persisted in `project.toml` so it survives across sessions per-project.

Resolution: `settingsStore.resolveNewFileDir(projectRoot)` returns
`default_dir || last_used_dir || projectRoot`. `createNewFileInProject` in
`app/lib/services/new-file.ts` adds one contextual rule: when the active file is
a `.litstudy` chapter inside the current project and no `default_dir` is pinned,
the chapter's parent folder takes precedence over `last_used_dir` and the
project root. Cmd+N and the sidebar header `+` share this resolution, keeping
new chapters alongside the active literary-study chapter. The resolved path is
then probed with `listDirectory`; if it has been deleted, creation falls back to
the project root. Explicit folder/blank-area context-menu actions retain their
explicit target directory.

## Sidebar right-click menus

Two distinct context menus:

- **Per-entry menu** (right-click a file or folder row).
  `data-testid="context-menu"`. Folder entries get a prepended section:
  `New File in Folder` / `New Folder in Folder`, both of which call
  `createFileAt` / `createFolderAt` in `Sidebar.svelte` with the target
  dir. Those helpers create an `untitled.md` / `new-folder` (backend
  auto-numbers on collision), expand the folder, refresh, and kick off
  inline rename on the new node via `startRename`. The rename input is
  rendered by `FileTreeNode` itself (gated on `renamingPath === node.path`)
  so it lines up under the renamed node at any depth — there is no
  separate top-of-sidebar rename row anymore.
- **Blank-area view menu** (right-click the empty region of
  `[data-testid="sidebar-files"]`, skipped if the target is a `.tree-row`
  or `.tree-input-row`). `data-testid="sidebar-view-menu"`. Lists:
  `New File` (root-level), `New Folder` (root-level), and the
  `Show hidden files` checkable item that writes to
  `settingsStore.view.show_hidden_files` and immediately refreshes the
  root folder.

## Cmd+M move-file palette

`app/lib/components/MoveFilePalette.svelte`. Triggered by the `move-file`
command (default shortcut `Cmd+M`, customizable in Settings > Shortcuts).
Walks `projectStore.files` recursively to list every folder (plus the
project root), filters out the active tab's current parent to prevent
no-op moves, and on selection calls `commands.moveItem(srcPath, targetDir)`.
Success path: `tabsStore.updatePath` rewires the open tab to the new
path and both source + destination folders are refreshed.
