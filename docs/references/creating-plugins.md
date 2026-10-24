# Creating Plugins

Plugins are sandboxed via QuickJS with permissions (`read` exposes the document, `write` also lets commands replace text). Plugin commands appear in the command palette.

## Plugin Location

```
~/.novelist/plugins/<id>/
  manifest.toml
  index.js
```

The folder name is the plugin id: it must match `[a-z0-9][a-z0-9-]*` and equal
`[plugin] id` in `manifest.toml`. A `[ui] entry` must be a relative path inside
the folder (no `..`, no absolute path, no backslashes). Folders breaking these
rules are skipped. Only plugins shipped inside the app are reported as
built-in; a manifest cannot claim that status.

## Scaffolding a New Plugin

Open **Settings > Plugins** and click the **+** button in the section header. A dialog asks for:

- **ID** — required, matches `[a-z0-9][a-z0-9-]*` (lowercase, digits, hyphens; must start with a letter or digit). Must not collide with an existing plugin directory.
- **Display name** — optional; falls back to the ID.

On submit, Novelist calls the `scaffold_plugin` IPC command which creates `~/.novelist/plugins/<id>/` with a starter `manifest.toml` + `index.js`. The new plugin appears in the list immediately. A help tooltip (`?`) next to the section header summarizes the manifest fields and permission tiers.

The starter uses the same `[plugin]` manifest model as installed plugins and
registers an executable `uppercase-selection` command with `read`/`write`
permissions. QuickJS evaluates `index.js` as a synchronous ordinary script:
register commands through the global `novelist.registerCommand`, not an ES
module `export default` or an `activate()` callback. Failed reloads keep the
previous working commands; a successful reload replaces them atomically.

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

A load or command must finish within 500 ms of JS work; code stuck in native
work (for example a catastrophically backtracking regular expression) is
stopped after 2 s and the plugin is unloaded.

## UI plugins (iframes)

Panel and file-handler UIs run in an iframe sandboxed with
`allow-scripts allow-forms allow-modals` and **without** `allow-same-origin`.
Your document therefore has an opaque origin: no `localStorage`, IndexedDB or
cookies, no access to the host or other plugins' frames, no popups and no
top-level navigation. Navigating your own frame to another document
disconnects it from the host.

Talk to the host only through the `MessagePort` it hands you. Copy
`plugins/host-channel.ts` (or import it, as the bundled plugins do) and call it
synchronously at module top level, before any `await`:

```ts
import { connectToHost } from '../../host-channel';

const host = connectToHost((message) => {
  if (message.type === 'content-update') render(message.content as string);
});
host.post({ type: 'plugin-ready' });
```

The host transfers the port right after your iframe loads, with
`{ type: 'novelist-plugin-connect' }`; messages you post earlier are queued.
Window `message` events and `window.parent.postMessage` are ignored by the
host.

Ship the UI as one self-contained HTML file: build with `singleFilePlugin()`
from `plugins/vite-single-file.ts`, which inlines your scripts and styles and
adds a strict Content-Security-Policy (only your own inline scripts by hash,
no network, no frames). Separate module or stylesheet files cannot load from
the sandboxed frame. If you build your entry differently, add your own CSP:
without one, your iframe can still make network requests.

Content is shared according to your manifest permissions: panels receive
`{ type: 'content-update', content }` only with `read`; file handlers receive
`file-open`/`file-sync` only with `read` and may send `file-state`,
`file-save` and `mark-dirty` only with `write`. Panels may send
`{ type: 'navigate', position }` to scroll the editor. Everyone receives
`{ type: 'theme-update', theme }`.

## Plugin Templates

See the `plugins/` directory for reference implementations:

| Template | Type | Entry | What it shows |
|----------|------|-------|---------------|
| `canvas/` | `file-handler` (`.canvas`) | SvelteFlow whiteboard | Infinite pan/zoom canvas with text nodes + edges; reads/writes canvas JSON |
| `mindmap/` | (metadata-only)¹ | `markmap-view` SVG | Auto-rendered mindmap from markdown headings received over the host port (raw HTML rendered as text) |
| `kanban/` | `file-handler` (`.kanban`) | Trello-style board | Columns + cards with `svelte-dnd-action` drag-drop; persists to `.kanban` JSON |

¹ Mindmap is bundled for historical reasons but is no longer rendered as a
side panel — the main app now ships a first-party overlay triggered by
`Cmd+Shift+M` (see `app/lib/components/MindmapOverlay.svelte`). The plugin
dir remains as a reference for a markmap-based iframe integration.

### File-handler plugin conventions

- **manifest `[ui]`** — set `type = "file-handler"` and list `file_extensions = [".myext"]`. The app routes matching files to your iframe instead of CodeMirror.
- **`vite.config.ts`** — set `base: './'` and add `singleFilePlugin()` (see above).
- **Host ↔ plugin protocol** (see `app/lib/components/PluginFileEditor.svelte`; every message travels over the host port):
  - Plugin → host: `{ type: 'plugin-ready', capabilities?: ['file-sync'] }` once the UI has mounted. Declare `file-sync` only if you implement it.
  - Host → plugin: `{ type: 'file-open', documentId, revision, filePath, content, projectPath, locale }` on mount, tab change, reload, or (for plugins without `file-sync`) a sibling pane's edit. Reset editor state for the new document.
  - Host → plugin: `{ type: 'file-sync', documentId, revision, filePath, content, projectPath, locale }` when a sibling pane edited the document you already show. Adopt the token and content in place; keep caret, mode, scroll and focus, and drop undo history that predates the new content.
  - Host → plugin: `{ type: 'theme-update', theme: { '--novelist-*': ... } }` on theme switch.
  - Plugin → host: `{ type: 'file-state', documentId, revision, content }` immediately after editing; the host shares accepted content with every tab of that file.
  - Plugin → host: `{ type: 'file-save', documentId, revision, content }` to persist. `revision` must be a nonnegative integer that never decreases within one document session.
  - Host → plugin: `{ type: 'file-save-result', documentId, revision, ok, saved, error }`. Only a matching current token/revision with `saved: true` may clear the plugin's dirty state.
  - Plugin → host: `{ type: 'mark-dirty', documentId, revision }` when appropriate; never send a tokenless mutation.
  - Plugin → host: `{ type: 'open-project-file', documentId, relativePath }` for navigation scoped to the current document's project.

Every `documentId` belongs to one exact host snapshot, not a reusable file path.
Adopt each new `file-open`/`file-sync` token and its content; stop the old debounce timer.
If flushing pending work before switching documents, send it with its original
token and revision so the host can reject an obsolete snapshot. Never relabel
old work with a new token. Old-token messages cannot overwrite a reload or a
sibling edit. A racing unsynchronized edit is shown in the host's conflict banner
for explicit restore or dismissal; the host does not automatically merge it.
