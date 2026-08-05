# Plugin System

## Layout

- Plugins live in `~/.novelist/plugins/<id>/` with `manifest.toml` +
  `index.js`.
- Sandboxed via QuickJS with permission tiers: read, write, execute.
- Plugin commands appear in the command palette.
- Built-in plugins (`canvas`, `mindmap`, `kanban`) are bundled via
  `core/build.rs` → `core/bundled-plugins/` → Tauri resources → installed
  to `~/.novelist/plugins/` on startup (version-gated by
  `ensure_bundled_plugins`).

## WKWebView + asset protocol quirks

Getting UI plugins to work on macOS WKWebView was non-trivial. Violating
any of these rules causes silent 403s or blank iframes:

- **UI plugins use the asset protocol**: `tauri.conf.json` enables
  `assetProtocol` with scope `$HOME/.novelist/plugins/**`. On macOS,
  `convertFileSrc` encodes the absolute entry path as a single URL segment;
  WKWebView consequently resolves `./assets/...` at the protocol root instead
  of beside `index.html`. First-party file-handler plugins must therefore ship
  a self-contained HTML entry (the literary plugin uses
  `plugins/vite-single-file.ts`) rather than external relative JS/CSS assets.
- **Iframes are un-sandboxed**: `PluginPanel.svelte` and
  `PluginFileEditor.svelte` intentionally omit the `sandbox` attribute.
  WKWebView blocks custom-protocol main-resource loads from sandboxed
  iframes, which breaks every asset://-served plugin.
- **`.kanban` is a file-handler extension**: `Sidebar.svelte`'s
  `textExtensions` list routes these to the kanban plugin via
  `extensionStore.getFileHandler()`. Same pattern for `.canvas`.

## Mindmap overlay

Built into the app (not a plugin panel). Trigger with `Cmd+Shift+M`. The
overlay is implemented in `app/lib/components/MindmapOverlay.svelte`,
consumes active-editor content, and renders via `markmap-lib` +
`markmap-view` directly in Svelte (no iframe, so theme CSS variables
propagate naturally). Fold logic lives in `app/lib/utils/mindmap.ts`
(`applyFoldLevel`) and is unit-tested in
`tests/unit/utils/mindmap.test.ts`. The plugin in `plugins/mindmap/` is
retained as a reference implementation but is filtered out of the
side-panel list in `App.svelte`.

## Literary commentary projects

Literary commentary is a dedicated `literary-study` project type backed by
the bundled `literary-commentary` file-handler plugin. The New Project
dialog always exposes this type in its own `literary-study` category,
independently of the deferred plugin scan. The import dialog uses a bounded
preview region with internal scrolling and a non-shrinking action footer so
the create/replace action remains reachable in compact desktop windows.
Opening a literary project ensures the bundled `.litstudy` handler is enabled
before the file tree is committed.

EPUB/TXT inspection and project mutations live in
`core/src/commands/literary_study.rs`. Imported chapters are stored below
`学习内容/`; `.novelist/literary-study.json` records source metadata and the
ordered chapter paths plus the selected import layout. The import dialog offers
two folder strategies (`by-volume` and `flat`) and two numbering strategies
(`global` and `per-volume`; flat layout always uses global numbering to prevent
collisions). By-volume import no longer creates a synthetic `章节/` directory:
unvolumed front matter lives directly under `学习内容/`, while real volumes get
stable numbered folders. Filename cleanup is enabled by default and removes
redundant leading forms such as `0004 第一章` or `第一卷` without changing the
chapter/volume titles stored inside `.litstudy` data. Bare structural headings
become a concise numbered filename such as `0004.litstudy`. Components are
UTF-8-byte bounded before writing so long CJK titles remain portable.

The native right panel reads a bounded overview through
`read_literary_study_overview`, while the iframe editor owns transcription,
inline comments, mistake markers, and revision-safe saves. Its single-file
entry posts `plugin-ready` after mounting; the host waits for that handshake
before sending the document and presents a retryable error instead of a blank
editor when startup fails. The transparent input capture follows the rendered
caret so the operating-system IME candidate window opens beside the current
writing position. Pre-edit pinyin is rendered as temporary underlined text but
never compared or saved; `compositionend` is the authoritative transaction, so
selecting a candidate replaces the pinyin and commits the selected CJK text
exactly once. Transcription is the default interaction; typing `【` enters inline
comment input and `】` returns to transcription (with
`Cmd/Ctrl+Shift+Enter` retained as a keyboard-only toggle). Backspace deletes
the actual rendered tail, including comments after returning to transcription;
Option/Ctrl+Backspace and Command+Backspace retain word/line deletion, while
Command/Ctrl+Z and redo restore complete input transactions. Other system
shortcuts are not intercepted. F6 is the plugin-specific assist key: each
press commits exactly the next reference character as one ordinary edit and
holding it follows the platform key-repeat rate.

Replacing a book is a staged transaction. Existing `.litstudy` files move to a
temporary backup, replacement files move in from a staging directory, and the
project config plus metadata are written atomically. Compatible chapter
progress is preserved by volume/title and source-prefix matching. Any collision
or write failure rolls the chapter files and metadata back before returning an
error.

## Plugin scaffolding

`scaffold_plugin(id, display_name?)` Rust command creates
`~/.novelist/plugins/<id>/` with a starter `manifest.toml` + `index.js`.
Triggered from Settings > Plugins via the "+" button and
`PluginScaffoldDialog.svelte`. ID pattern: `[a-z0-9][a-z0-9-]*`.

`HelpTooltip.svelte` is used in Settings > Plugins to explain the
manifest/permissions model inline.
