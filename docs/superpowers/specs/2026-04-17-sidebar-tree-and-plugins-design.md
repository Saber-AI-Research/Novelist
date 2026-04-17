---
name: Sidebar folder tree + plugin add/help
date: 2026-04-17
status: draft
---

# Design — Sidebar Folder Tree, Drag-Drop, Plugin Add Button, Help Tooltip

Three related UX improvements:

1. **Sidebar folder tree** — expandable sub-folders (lazy-loaded) + drag-and-drop to move files or folders into folders (or back to project root).
2. **Plugins `+` button** — adds a "+" button to the Plugins section of Settings with two actions: open plugins folder, or scaffold a new plugin from a minimal template.
3. **Help tooltip (`?` hover card)** — inline help explaining where plugins live and offering a one-click "Copy prompt" for Claude Code.

Each piece is small and self-contained. They share one file (`Sidebar.svelte` for #1, `Settings.svelte` for #2 and #3) so we'll land them in sequence.

---

## 1. Sidebar Folder Tree + Drag-Drop

### Data model

Today `projectStore.files: FileEntry[]` holds only the project root's direct children (non-recursive). Extend each folder node to carry expansion state and lazily-loaded children.

A new interface used purely on the frontend (the Rust `FileEntry` stays as-is):

```ts
interface FileNode extends FileEntry {
  children?: FileNode[];   // undefined = not loaded yet; [] = loaded, empty
  expanded: boolean;       // UI state
  loading: boolean;        // while list_directory is in flight
}
```

Store extensions (`app/lib/stores/project.svelte.ts`):

- `files` becomes `FileNode[]` (root level only until expanded).
- `expandFolder(path: string)` — if `children === undefined`, call `list_directory(path)` and populate; set `expanded = true`.
- `collapseFolder(path: string)` — set `expanded = false`; preserve `children` cache.
- `refreshFolder(path: string)` — re-fetch a previously-loaded folder; used by file-watcher events.

### File watcher integration

The existing watcher emits events for create/delete/rename under the project root. Extend the handler that currently calls `listDirectory(dirPath)` for the root to:

- Resolve the event path to its parent directory.
- Walk the in-memory tree to find the parent `FileNode`.
- If parent is the project root, or if parent has `children !== undefined` (already loaded), call `refreshFolder(parent.path)`.
- Otherwise do nothing — the user hasn't expanded that folder; lazy-loading handles it on next expand.

### Rendering

Extract a recursive `FileTreeNode.svelte` from `Sidebar.svelte`:

```svelte
<!-- FileTreeNode.svelte -->
<script>
  let { node, depth } = $props();
</script>

<div style="padding-left: {depth * 12 + 8}px;">
  {#if node.is_dir}
    <button onclick={() => toggle(node)}>
      <Chevron direction={node.expanded ? 'down' : 'right'} />
      <FolderIcon /> {node.name}
    </button>
    {#if node.expanded && node.children}
      {#each sortChildren(node.children) as child}
        <FileTreeNode node={child} depth={depth + 1} />
      {/each}
    {/if}
  {:else}
    <!-- file rendering (same as today) -->
  {/if}
</div>
```

`Sidebar.svelte`'s `{#each sortedFiles as entry}` becomes `{#each sortedFiles as entry}<FileTreeNode node={entry} depth={0} />{/each}`.

Chevron toggles are keyboard-accessible (Enter/Space). Existing context-menu, rename, context actions still work at every depth.

### Drag-and-drop

HTML5 Drag API — no library needed.

- Every node (file and folder) sets `draggable="true"`.
- `dragstart` writes `{ sourcePath }` to `dataTransfer.setData('application/x-novelist-path', path)`.
- Every folder node + a root-level drop zone (the empty area of `.sidebar-files`) listens for:
  - `dragover` → `preventDefault()` to allow drop; add CSS class `drag-over` for visual feedback.
  - `dragleave` → remove the class.
  - `drop` → read the source path, validate, call `move_item`.

**Front-end validation before calling `move_item`:**

1. `target === sourceParent` → no-op, ignore silently.
2. `target === source` → reject (drop on self).
3. `target.path.startsWith(source.path + '/')` → reject (would move a folder into its own descendant). Show a brief red flash.

Invalid drops get `dataTransfer.dropEffect = 'none'` during `dragover` so the cursor shows a "prohibited" indicator.

**Post-move UI updates:**

After `move_item` returns `new_path`:

- Refresh the source's parent folder and the target folder.
- Walk `tabsStore.tabs` and update any tab whose `filePath` starts with `source_path`:
  ```ts
  for (const tab of tabsStore.tabs) {
    if (tab.filePath === source || tab.filePath.startsWith(source + '/')) {
      tab.filePath = newPath + tab.filePath.slice(source.length);
    }
  }
  ```

### New Rust command — `move_item`

Add to `core/src/commands/file.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn move_item(source_path: String, target_dir: String) -> Result<String, AppError> {
    let source = validate_path(&source_path)?;
    let target = validate_path(&target_dir)?;

    if !target.is_dir() {
        return Err(AppError::NotADirectory(target_dir));
    }

    // Reject moving a folder into its own descendant.
    if target.starts_with(&source) {
        return Err(AppError::InvalidInput(
            "Cannot move a folder into its own descendant".into(),
        ));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Source has no file name".into()))?;
    let mut dest = target.join(file_name);

    // Auto-number on collision: "foo.md" → "foo 2.md" → "foo 3.md".
    if dest.exists() {
        let stem = dest.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let ext = dest.extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 2u32;
        loop {
            dest = target.join(format!("{stem} {counter}{ext}"));
            if !dest.exists() { break; }
            counter += 1;
        }
    }

    // rename() fails across devices; fall back to copy+remove using the existing
    // copy_dir_recursive helper (already in core/src/commands/plugin.rs and template.rs —
    // hoist one into a shared module like core/src/fs_utils.rs during implementation).
    match tokio::fs::rename(&source, &dest).await {
        Ok(_) => {}
        Err(e) if e.raw_os_error() == Some(18) /* EXDEV */ => {
            if source.is_dir() {
                copy_dir_recursive(&source, &dest).await?;
                tokio::fs::remove_dir_all(&source).await?;
            } else {
                tokio::fs::copy(&source, &dest).await?;
                tokio::fs::remove_file(&source).await?;
            }
        }
        Err(e) => return Err(e.into()),
    }

    Ok(dest.to_string_lossy().to_string())
}
```

Register in `core/src/lib.rs` (both `tauri_specta::Builder` and `invoke_handler!`). Regenerate bindings via `pnpm tauri dev`.

`validate_path` already rejects paths that escape the project root (uses canonicalize + prefix check), so that concern is covered upstream.

### Tests

**Rust unit** (`core/src/commands/file.rs`):

- `test_move_item_basic` — move `a.md` from root into subfolder, assert new path, assert source gone.
- `test_move_item_collision` — destination has same name, assert auto-numbered suffix.
- `test_move_item_into_descendant_fails` — move `parent/` into `parent/child/`, assert `InvalidInput`.
- `test_move_item_rejects_outside_project` — validate_path catches this; assert error.

**Vitest** (`tests/unit/stores/project-tree.test.ts` — new):

- `expandFolder` loads children once, subsequent calls are no-ops.
- `refreshFolder` replaces children but preserves `expanded`.

**Playwright** (extend `tests/e2e/specs/sidebar.spec.ts`):

- Create subfolder → click chevron → verify children appear → create file in subfolder → drag a root-level `.md` onto subfolder → verify the dragged file now appears inside the expanded subfolder and is gone from root.

---

## 2. Plugins `+` Button

### Placement

In `Settings.svelte`, where the `activeSection === 'plugins'` pane renders:

```svelte
<h3>{t('settings.plugins')}</h3>
```

Put a flex container with the heading and a `+` icon button on the right, matching the sidebar's `sidebar-icon-btn` style.

### Click handler

Clicking `+` opens a small dropdown (same visual pattern as the existing context menu) with two items:

1. **Open plugins folder**
   - Ensure `~/.novelist/plugins/` exists (`create_dir_all` if missing).
   - Call `reveal_in_file_manager(plugins_dir)`.
2. **Create from template…**
   - Opens an inline dialog inside the Plugins pane (not a modal).

### Create-from-template dialog

Two fields:

- **Plugin ID** — required. Live validation: `^[a-z0-9][a-z0-9-]*$`. Show red hint + disabled confirm when invalid or when the ID already exists in `listPlugins()` output.
- **Display name** — optional, defaults to the ID.

Buttons: Cancel / Create.

On Create:

1. Call new Rust command `scaffold_plugin(id, display_name)`.
2. Call `listPlugins()` to refresh the Community section.
3. Call `reveal_in_file_manager(new_plugin_dir)` so the user can immediately edit with Claude Code.

### New Rust command — `scaffold_plugin`

Add to `core/src/commands/plugin.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn scaffold_plugin(
    id: String,
    display_name: Option<String>,
) -> Result<String, AppError> {
    // Validate ID format without adding a regex dep: must be non-empty, start with
    // [a-z0-9], and otherwise contain only [a-z0-9-].
    let valid = !id.is_empty()
        && id.chars().next().map_or(false, |c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "Plugin ID must match [a-z0-9][a-z0-9-]*, got '{id}'"
        )));
    }

    let dir = plugins_dir().join(&id);
    if dir.exists() {
        return Err(AppError::InvalidInput(format!(
            "Plugin directory already exists: {}", dir.display()
        )));
    }

    let name = display_name.unwrap_or_else(|| id.clone());
    let manifest = format!(
        "id = \"{id}\"\n\
         name = \"{name}\"\n\
         version = \"0.1.0\"\n\
         author = \"\"\n\
         description = \"\"\n\
         permissions = []\n\
         entry = \"index.js\"\n"
    );
    let index_js = "// Minimal Novelist plugin — runs in QuickJS sandbox.\n\
         export default {\n\
         \u{0020}\u{0020}activate(ctx) {\n\
         \u{0020}\u{0020}\u{0020}\u{0020}// ctx.registerCommand({ id: \"...\", title: \"...\", run: () => {} });\n\
         \u{0020}\u{0020}}\n\
         };\n";

    // Atomic-ish scaffold: write to <id>.tmp then rename.
    let tmp = plugins_dir().join(format!("{id}.tmp"));
    tokio::fs::create_dir_all(&tmp).await?;
    tokio::fs::write(tmp.join("manifest.toml"), manifest).await?;
    tokio::fs::write(tmp.join("index.js"), index_js).await?;
    tokio::fs::rename(&tmp, &dir).await?;

    Ok(dir.to_string_lossy().to_string())
}
```

Register in `core/src/lib.rs` alongside `list_plugins` / `set_plugin_enabled`.

Error handling reuses existing `AppError` variants — `InvalidInput` covers both "bad ID format" and "already exists" without needing a new variant.

### Tests

**Rust unit** (`core/src/commands/plugin.rs`):

- `test_scaffold_plugin_creates_manifest_and_index` — call with `"foo"`, assert both files exist with expected content.
- `test_scaffold_plugin_rejects_invalid_id` — e.g. `"Foo"`, `"foo bar"`, `""`.
- `test_scaffold_plugin_rejects_existing` — create `foo`, call again, assert error.

**Vitest** (`tests/unit/components/plugin-scaffold-dialog.test.ts` — new):

- Invalid IDs disable the Create button.
- Duplicate IDs (against a mock `listPlugins` response) disable the Create button.

**Playwright** (extend `tests/e2e/specs/settings.spec.ts`):

- Open Settings > Plugins → click `+` → choose Create from template → type `foo` → confirm → verify `foo` appears in Community Plugins.

---

## 3. `?` Help Tooltip

### Placement

The existing info card at the bottom of the Plugins pane renders "Create a plugin / Plugins live in ~/.novelist/plugins/<id>/ / Use Claude Code: ...". Keep the card, but add a `?` icon immediately after the "Create a plugin" heading. Hover (or click) the `?` to show a card with more detail + a Copy button for the suggested prompt.

### Card contents

```
Creating plugins

Plugins live in:
  ~/.novelist/plugins/<id>/

Each plugin needs:
  • manifest.toml — metadata & permissions
  • index.js — plugin code

Let Claude Code do it for you:
  ┌─────────────────────────────────────────────────┐
  │ Create a Novelist plugin that counts sentences. │  [Copy]
  └─────────────────────────────────────────────────┘
```

The "Copy" button writes the prompt string to the clipboard via `navigator.clipboard.writeText`, then flips its label to "Copied" for 1.5s.

### Interaction

- Hover delay 300ms before showing (avoid flicker).
- Staying on the card keeps it open; leaving both the `?` and the card closes it after 150ms.
- Clicking `?` toggles the card (keyboard + touch support).
- `svelte:window onclick` closes it when clicking outside, same as `context-menu` and `project-switcher`.

### Component

Extract a reusable `HelpTooltip.svelte`:

```svelte
<script>
  let { title } = $props();
  let open = $state(false);
  let buttonEl = $state();
</script>

<button bind:this={buttonEl} onclick={() => open = !open} aria-label={title}>?</button>
{#if open}
  <div class="help-card" role="tooltip">
    <slot />
  </div>
{/if}
```

Use via:

```svelte
<HelpTooltip title={t('settings.plugins.helpTitle')}>
  ...card content with a {@render copyButton(promptText)}...
</HelpTooltip>
```

### i18n keys (new)

```ts
'settings.plugins.helpTitle': 'Creating plugins',
'settings.plugins.helpLetClaude': 'Let Claude Code do it for you:',
'settings.plugins.copy': 'Copy',
'settings.plugins.copied': 'Copied',
```

Existing keys `pluginPath`, `pluginNeeds`, `manifest`, `indexJs`, `aiSuggestion` are reused inside the card. Both `en.ts` and `zh-CN.ts` get the new keys.

### Tests

**Playwright** (same settings spec as §2):

- Hover `?` → verify card visible.
- Click Copy → read `navigator.clipboard` via a test hook → assert content matches the prompt string.
- Verify button label becomes "Copied".

---

## Architectural notes

- No new dependencies. All features use existing libraries (Tokio for fs, Svelte 5 runes, HTML5 Drag API, `navigator.clipboard`). Plugin ID validation is a ~3-line manual ASCII check, not a regex dep.
- Implementation should hoist the two existing `copy_dir_recursive` copies (in `commands/plugin.rs` and `commands/template.rs`) into a shared `core/src/fs_utils.rs` and reuse it from `move_item` as well. This is a minor refactor in service of the current goal.
- One new Svelte component per concern keeps files focused:
  - `app/lib/components/FileTreeNode.svelte` (recursive tree)
  - `app/lib/components/PluginScaffoldDialog.svelte`
  - `app/lib/components/HelpTooltip.svelte`
- Two new Rust commands: `move_item`, `scaffold_plugin`.
- Auto-generated `app/lib/ipc/commands.ts` regenerates on `pnpm tauri dev` — do not edit by hand.

## Out of scope

- Custom drag-to-reorder within a folder (would need a persisted `order` field).
- Multi-select drag (drag one item at a time for v1).
- Installing plugins from ZIP/URL — a "Create from template" seed + external editing via Claude Code covers the intended workflow.
- Plugin uninstall button in Settings — tracked separately.
