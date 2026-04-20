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

## Plugin scaffolding

`scaffold_plugin(id, display_name?)` Rust command creates
`~/.novelist/plugins/<id>/` with a starter `manifest.toml` + `index.js`.
Triggered from Settings > Plugins via the "+" button and
`PluginScaffoldDialog.svelte`. ID pattern: `[a-z0-9][a-z0-9-]*`.

`HelpTooltip.svelte` is used in Settings > Plugins to explain the
manifest/permissions model inline.
