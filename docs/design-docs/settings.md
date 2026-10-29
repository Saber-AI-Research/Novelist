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

## AI Talk connection profiles

AI Talk uses the device-local `novelist:ai-talk:settings:v1` storage key,
independently of the global/project settings overlay. A saved `profiles` array
is authoritative, including `[]`; provider templates are seeded only for fresh
installations and legacy records without a profile list. Do not merge missing
built-in profiles back on load: absence records a deliberate deletion.

All connections can be renamed, duplicated and deleted. Deletion uses an inline
confirmation that also works in mobile WebViews. Removing the active connection
selects the first remaining one; removing the last clears the flattened active
ID, endpoint, key and model. Conversation history and prompt presets are kept.
Adding a provider template creates a clean connection without a key; duplication
explicitly copies the current connection, including its key. Template IDs are
reused only when absent; additional connections to the same provider get unique
IDs. Both the inline panel settings and the main Settings page share this UI.

Connection controls and shared conversation defaults are visually separated.
Mobile inputs use 16px text to avoid iOS focus zoom and controls have at least
44px touch height. Selecting, adding or duplicating a connection hides the key.

Validation on 2026-10-29: `pnpm check` passed without diagnostics; the settings,
OpenAI adapter and prompt-preset unit suites passed (30 tests). Playwright ran
`ai-talk-settings.spec.ts` and `ai-panels.spec.ts` against a fresh Vite test server
on port 1430 (36 tests passed), with desktop WebKit/Chromium plus iPhone, iPad
portrait/landscape and Android phone settings workflows. The settings workflow
checks touch activation, duplicate credential isolation, cancelled deletion,
deletion of every built-in and the last profile, reload persistence, clean
template restoration, CJK renaming, horizontal bounds and mobile touch heights.
Settings and inline deletion screenshots were saved and the iPad screenshots
visually inspected. These are browser tests with mocked Tauri IPC, not native
iPad acceptance or live provider inference. No iPad was connected (`idevice_id -l`
was empty); this Mac has Command Line Tools but no full Xcode or simulator tools.

### Subscription sign-in investigation (verified 2026-10-29)

**Status: researched, not implemented.** Current AI Talk requests use an API key
and the OpenAI-compatible Chat Completions protocol. OAuth credentials cannot
simply replace that key: login lifecycle and inference adapters are required.

| Route | Practical integration | Platform boundary |
| --- | --- | --- |
| Codex local client | Official app-server `account/read`, `account/login/start`, `account/login/cancel`; wait for `account/login/completed`. Use `model/list`, `thread/start` and `turn/start`, translate answer events and require a completed turn. | Desktop with Codex installed; processes are unavailable on iOS/Android. |
| Sign in with ChatGPT | Register the open-source client, authorize using PKCE, validate tokens and plan permission, refresh credentials, list account-specific models and call the Responses API. | Documented OSS flow requires an HTTP loopback callback on `127.0.0.1`; custom URI callbacks are not documented for this flow. Mobile feasibility needs a separate native prototype, including browser return and app suspension. |
| Claude local client | Official `claude auth login`, `claude auth status`; infer through the unmodified `claude -p` client with structured streaming output. | Desktop with Claude Code installed; mobile needs a separately designed remote runtime. Published official SDK guidance and newer help/legal guidance disagree about third-party subscription login; resolve that before shipping a public login feature. |

The lowest-effort technical route is desktop CLI integration, behind the
existing `external_processes` capability. Add a connection kind (`api-key`,
`codex-cli`, `claude-cli`) with a legacy default of `api-key`. Keep credentials
under the official client's management, expose only sanitized account/status
information, and do not copy CLI OAuth tokens into localStorage. Login controls
must support cancel, timeout, missing/unsupported CLI and browser failure.
Deleting a connection should remove its AI Talk configuration without logging
other applications out of a shared CLI account.

The inference bridge needs process discovery for packaged desktop apps, bounded
JSON/JSONL parsing, cancellation that terminates and reaps the owned process,
and terminal-error propagation. Subscribe before starting events to avoid losing
fast replies. Use the same connection adapter for chat and compaction. Pass only
explicitly selected writing context and disable agent tools, hooks, project
instructions and inherited MCP integrations; logging in must not grant a writing
chat implicit access to edit the user's files. Preserve user CLI configuration;
any required model/provider/environment overrides should affect only the owned
child process. A model catalog or successful login alone does not verify model
access: an actual completed inference is required.

Mobile should not show an enabled local-CLI login button. For a unified mobile
experience, evaluate the official ChatGPT sign-in route separately and define
an authenticated remote Claude execution service if that product scope is
chosen. This investigation did not find an equivalent public Claude consumer
OAuth integration suitable for directly embedding subscription inference into
both mobile apps. Claude's help page (October 7 update) says subscription usage
still works in Agent SDK / `claude -p`, and its legal page describes running the
unmodified binary in third-party products with each user's own credentials.
However, the SDK overview still says third-party claude.ai login needs prior
approval. These sources do not establish an unambiguous public embedded OAuth
route. Reusing extracted tokens against arbitrary APIs is not the documented
CLI integration.

For ChatGPT direct inference, the existing Chat Completions adapter is unsuitable:
the documented route uses Responses with `store: false`, `stream: true`, and the
full required history in `input`. Its preview excludes `temperature` and
`previous_response_id` over HTTP. First registration uses `dynamic_agent_client`
and saves the issued client ID; validate state, PKCE, nonce, ID-token signature
and granted plan scopes before activating the connection. Credentials belong in
protected native storage, with atomic refresh and explicit sign-out, rather than
the existing API-key localStorage record. Login, model listing and a completed
inference must be verified separately. This is a new integration, not a UI-only
change; no nonfunctional login controls have been added.

Official references checked for this investigation:

- [Codex app-server authentication and inference](https://learn.chatgpt.com/docs/app-server)
- [ChatGPT open-source client registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [ChatGPT plan inference and supported endpoint](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [ChatGPT preview request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Claude CLI authentication and structured output](https://code.claude.com/docs/en/cli-reference)
- [Claude plan usage through Agent SDK and print mode](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude SDK third-party login guidance](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Code in third-party products](https://code.claude.com/docs/en/legal-and-compliance)
