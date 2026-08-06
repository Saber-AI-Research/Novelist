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
