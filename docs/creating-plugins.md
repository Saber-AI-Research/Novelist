# Creating Plugins

Plugins are sandboxed via QuickJS with permission tiers (read, write, execute). Plugin commands appear in the command palette.

## Plugin Location

```
~/.novelist/plugins/<id>/
  manifest.toml
  index.js
```

## Scaffolding a New Plugin

Open **Settings > Plugins** and click the **+** button in the section header. A dialog asks for:

- **ID** — required, matches `[a-z0-9][a-z0-9-]*` (lowercase, digits, hyphens; must start with a letter or digit). Must not collide with an existing plugin directory.
- **Display name** — optional; falls back to the ID.

On submit, Novelist calls the `scaffold_plugin` IPC command which creates `~/.novelist/plugins/<id>/` with a starter `manifest.toml` + `index.js`. The new plugin appears in the list immediately. A help tooltip (`?`) next to the section header summarizes the manifest fields and permission tiers.

You can still create plugin directories by hand — the scaffold dialog is just a shortcut.

## Example

**manifest.toml**:
```toml
[plugin]
id = "word-frequency"
name = "Word Frequency"
version = "1.0.0"
permissions = ["read"]
```

**index.js**:
```javascript
novelist.registerCommand("word-freq", "Show Word Frequency", function() {
  const doc = novelist.getDocument();
  const words = doc.split(/\s+/).filter(w => w.length > 0);
  // ... your logic here
});
```

Or ask your AI: *"Create a Novelist plugin that highlights overused words"*

## Plugin Templates

See the `plugins/` directory for reference implementations:

| Template | Type | Entry | What it shows |
|----------|------|-------|---------------|
| `canvas/` | `file-handler` (`.canvas`) | SvelteFlow whiteboard | Infinite pan/zoom canvas with text nodes + edges; reads/writes canvas JSON |
| `mindmap/` | (metadata-only)¹ | `markmap-view` SVG | Auto-rendered mindmap from markdown headings via postMessage |
| `kanban/` | `file-handler` (`.kanban`) | Trello-style board | Columns + cards with `svelte-dnd-action` drag-drop; persists to `.kanban` JSON |

¹ Mindmap is bundled for historical reasons but is no longer rendered as a
side panel — the main app now ships a first-party overlay triggered by
`Cmd+Shift+M` (see `app/lib/components/MindmapOverlay.svelte`). The plugin
dir remains as a reference for a markmap-based iframe integration.

### File-handler plugin conventions

- **manifest `[ui]`** — set `type = "file-handler"` and list `file_extensions = [".myext"]`. The app routes matching files to your iframe instead of CodeMirror.
- **`vite.config.ts`** — must set `base: './'`. Plugin assets are served via Tauri's `asset://` protocol from the plugin dir; absolute `/assets/...` paths 403.
- **Host ↔ plugin protocol** (see `app/lib/components/PluginFileEditor.svelte`):
  - Host → plugin: `{ type: 'file-open', filePath, content }` on mount and tab change
  - Host → plugin: `{ type: 'theme-update', theme: { '--novelist-*': ... } }` on theme switch
  - Plugin → host: `{ type: 'file-save', filePath, content }` to persist (the host writes atomically via `writeFile` + `registerWriteIgnore`)
  - Plugin → host: `{ type: 'mark-dirty' }` to signal unsaved changes in the tab
