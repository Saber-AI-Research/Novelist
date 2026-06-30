# File Lifecycle

The watcher, rename suppression, auto-rename, and cross-window broadcast
form one coupled system. Breaking any of them leads to rename echoes or
dirty-state flaps.

## File watcher + self-write suppression

- BLAKE3 hashing detects self-writes (app writes → watcher sees → would
  otherwise think external change → prompts conflict dialog on user's
  own save). `write_file` records the written content's hash; watcher
  events matching recent hashes are dropped.

## External-edit auto-reload (watcher + polling fallback)

A non-dirty open tab reloads automatically when its file changes on disk;
a dirty tab raises the conflict dialog instead. Both flow through
`handleExternalChange()` in `app/lib/composables/app-events.svelte.ts`, fed
by **two** independent sources:

1. **notify watcher** (`start_file_watcher`) — instant (<200ms debounce), but
   only covers the single recursively-watched **project** directory.
2. **Polling fallback** (`poll_external_changes`, called every 1s from
   `app-events`) — re-hashes every *tracked open file* (mtime-gated `stat`,
   then BLAKE3) and returns the changed paths.

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

Self-write safety: the poll reuses the watcher's 2s `ignore_set`. Because the
1s poll interval is shorter than that window, a save is hashed-and-suppressed
(its new hash committed) before the window expires, so it never resurfaces as a
spurious external change that would reset the editor under the user.

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
successful `writeFile`. Uses `rename_item(..., allow_collision_bump: true)`
with ` 2`/` 3` suffix on collision. Only runs while the filename is still a
placeholder (e.g. `Untitled 2.md`) and the doc has an H1 — then renames
the file to match the H1.

## Cross-window file-renamed broadcast

When one window auto-renames a file after an H1-driven save, every window
needs to know so open tabs don't point at stale paths.

- Backend: `broadcast_file_renamed` IPC command fires a `file-renamed`
  Tauri event to all windows.
- Frontend: `app/lib/composables/app-events.svelte.ts` listens for
  `file-renamed` and calls `tabsStore.updatePath(old, new)` in every
  window, plus refreshes the parent folder in the sidebar.

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
