# File Lifecycle

The watcher, rename suppression, auto-rename, and cross-window broadcast
form one coupled system. Breaking any of them leads to rename echoes or
dirty-state flaps.

## File watcher + self-write suppression

- BLAKE3 hashing detects self-writes (app writes → watcher sees → would
  otherwise think external change → prompts conflict dialog on user's
  own save). `write_file` records the written content's hash; watcher
  events matching recent hashes are dropped.
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
