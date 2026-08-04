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
  `assetProtocol` with scope `$HOME/.novelist/plugins/**`. Every UI
  plugin's `vite.config.ts` **must** set `base: './'` — absolute
  `/assets/...` paths resolve outside the plugin dir and 403.
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
dialog always exposes this type, independently of the deferred plugin scan.
Opening a literary project ensures the bundled `.litstudy` handler is enabled
before the file tree is committed.

EPUB/TXT inspection and project mutations live in
`core/src/commands/literary_study.rs`. Imported chapters are stored below
`学习内容/`; `.novelist/literary-study.json` records source metadata and the
ordered chapter paths. The native right panel reads a bounded overview through
`read_literary_study_overview`, while the iframe editor owns transcription,
inline comments, mistake markers, and revision-safe saves.

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
