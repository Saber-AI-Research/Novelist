# Sidebar Tree, Drag-Drop, Plugin Add Button, Help Tooltip, Language Scope — Implementation Plan

> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lazy-loading expandable sub-folders + drag-drop in the sidebar, a "+" button with folder/scaffold actions in Settings > Plugins, a "?" help card with a Copy-prompt button, and scope the language picker to Settings > Editor only.

**Architecture:** Extend `projectStore` with a recursive `FileNode` model (lazy `children`), factor a `FileTreeNode.svelte` recursive component, add `move_item` + `scaffold_plugin` Tauri commands, and two small Svelte components (`PluginScaffoldDialog.svelte`, `HelpTooltip.svelte`). Everything else is edits in `Sidebar.svelte` / `Settings.svelte` / i18n locales.

**Tech Stack:** Svelte 5 runes, CodeMirror 6, Tauri v2 + `tauri-specta` (auto-regenerated `app/lib/ipc/commands.ts`), Tokio async fs, Playwright, Vitest.

**Spec:** `docs/exec-plans/completed/2026-04-17-sidebar-tree-and-plugins-design.md`

---

## Cross-cutting reminders

- **Never hand-edit `app/lib/ipc/commands.ts`** — it's regenerated. After adding/changing a Rust command, run `pnpm tauri dev` once (or `cargo build --features codegen -p novelist-core` from `core/`) to regenerate.
- **Command registration lives in `core/src/lib.rs` in TWO places** — both the `#[cfg(feature = "sync")]` and `#[cfg(not(feature = "sync"))]` builders. Miss either and the command works in one build but not the other.
- **Don't add new `AppError` variants** — `InvalidInput(String)` covers both "bad input" and "already exists" messaging, matching existing code in `file.rs:399` (`AppError::Custom(format!("Already exists: …"))`) and `file.rs:129` (`AppError::InvalidInput`).
- **`validate_path` does NOT require the project root** — it only rejects `..` traversal and system paths. So commands can operate on `~/.novelist/plugins/` safely.
- **EXDEV / cross-device moves: skip the fallback.** Source and target for `move_item` are both under the same project tree (front-end validates this), so a simple `tokio::fs::rename` is enough. Don't re-invent `copy_dir_recursive` for a case that can't happen.
- **Use `pnpm`, not `npm`** — matches project scripts. Tests: `pnpm test` / `pnpm test:rust` / `pnpm test:e2e:browser`.

---

# Phase 1 — Sidebar Folder Tree + Drag-Drop

## Task 1: Add `move_item` Rust command

**Files:**
- Modify: `core/src/commands/file.rs` (append a command + 4 tests in the `#[cfg(test)] mod tests` block near line 672).

- [ ] **Step 1: Write the failing tests**

Append inside `#[cfg(test)] mod tests { … }` in `core/src/commands/file.rs`, right after `test_rename_item_target_exists` (around line 804):

```rust
#[tokio::test]
async fn test_move_item_basic() {
    let dir = TempDir::new().unwrap();
    let src_file = dir.path().join("a.md");
    fs::write(&src_file, "hello").unwrap();
    let subdir = dir.path().join("sub");
    fs::create_dir(&subdir).unwrap();

    let new_path = move_item(
        src_file.to_string_lossy().to_string(),
        subdir.to_string_lossy().to_string(),
    )
    .await
    .unwrap();

    assert!(!src_file.exists());
    assert!(Path::new(&new_path).exists());
    assert_eq!(fs::read_to_string(&new_path).unwrap(), "hello");
    assert!(new_path.ends_with("sub/a.md"));
}

#[tokio::test]
async fn test_move_item_collision_auto_numbers() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("a.md");
    fs::write(&src, "src").unwrap();
    let subdir = dir.path().join("sub");
    fs::create_dir(&subdir).unwrap();
    fs::write(subdir.join("a.md"), "existing").unwrap();

    let new_path = move_item(
        src.to_string_lossy().to_string(),
        subdir.to_string_lossy().to_string(),
    )
    .await
    .unwrap();

    assert!(new_path.ends_with("a 2.md"));
    assert_eq!(fs::read_to_string(subdir.join("a.md")).unwrap(), "existing");
    assert_eq!(fs::read_to_string(&new_path).unwrap(), "src");
}

#[tokio::test]
async fn test_move_item_into_own_descendant_fails() {
    let dir = TempDir::new().unwrap();
    let parent = dir.path().join("parent");
    fs::create_dir(&parent).unwrap();
    let child = parent.join("child");
    fs::create_dir(&child).unwrap();

    let result = move_item(
        parent.to_string_lossy().to_string(),
        child.to_string_lossy().to_string(),
    )
    .await;
    assert!(result.is_err());
    assert!(parent.exists());
    assert!(child.exists());
}

#[tokio::test]
async fn test_move_item_target_not_a_directory() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("a.md");
    fs::write(&src, "").unwrap();
    let not_dir = dir.path().join("b.md");
    fs::write(&not_dir, "").unwrap();

    let result = move_item(
        src.to_string_lossy().to_string(),
        not_dir.to_string_lossy().to_string(),
    )
    .await;
    assert!(result.is_err());
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd core && cargo test --no-default-features --features codegen commands::file::tests::test_move_item -- --nocapture
```

Expected: compile error or 4 tests fail with `unresolved import` / "cannot find function `move_item`".

- [ ] **Step 3: Implement `move_item`**

Append immediately after `rename_item` (around `core/src/commands/file.rs:406`):

```rust
/// Move a file or folder into `target_dir`. Auto-numbers on collision
/// ("a.md" -> "a 2.md"). Rejects moving a folder into its own descendant.
#[tauri::command]
#[specta::specta]
pub async fn move_item(source_path: String, target_dir: String) -> Result<String, AppError> {
    let source = validate_path(&source_path)?;
    let target = validate_path(&target_dir)?;

    if !source.exists() {
        return Err(AppError::FileNotFound(source_path));
    }
    if !target.is_dir() {
        return Err(AppError::NotADirectory(target_dir));
    }

    // Reject moving a folder into its own descendant.
    // Canonicalize both so symlinks and trailing slashes don't spoof the check.
    let src_canon = tokio::fs::canonicalize(&source).await?;
    let tgt_canon = tokio::fs::canonicalize(&target).await?;
    if tgt_canon.starts_with(&src_canon) {
        return Err(AppError::InvalidInput(
            "Cannot move a folder into its own descendant".to_string(),
        ));
    }

    let file_name = source
        .file_name()
        .ok_or_else(|| AppError::InvalidInput("Source has no file name".to_string()))?;
    let mut dest = target.join(file_name);

    // Auto-number on collision: "foo.md" -> "foo 2.md" -> "foo 3.md".
    if dest.exists() {
        let stem = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let ext = dest
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let mut counter = 2u32;
        loop {
            dest = target.join(format!("{stem} {counter}{ext}"));
            if !dest.exists() {
                break;
            }
            counter += 1;
        }
    }

    // Source & target are both inside the project tree (frontend guarantees this via
    // validate_path). Same filesystem -> plain rename is enough.
    tokio::fs::rename(&source, &dest).await?;
    Ok(dest.to_string_lossy().to_string())
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd core && cargo test --no-default-features --features codegen commands::file::tests::test_move_item -- --nocapture
```

Expected: 4 tests pass.

- [ ] **Step 5: Run full `file.rs` test module to catch regressions**

```bash
cd core && cargo test --no-default-features --features codegen commands::file::tests
```

Expected: all pre-existing tests still pass plus the 4 new ones.

- [ ] **Step 6: Commit**

```bash
git add core/src/commands/file.rs
git commit -m "feat(core): add move_item command for sidebar drag-drop"
```

---

## Task 2: Register `move_item` + regenerate TypeScript bindings

**Files:**
- Modify: `core/src/lib.rs` (3 places: `use commands::file::{…}` import, and both `collect_commands![…]` lists).

- [ ] **Step 1: Add to the import line**

In `core/src/lib.rs:12-16`, extend:

```rust
use commands::file::{
    create_directory, create_file, create_scratch_file, delete_item, duplicate_file,
    get_file_encoding, list_directory, move_item, read_file, read_image_data_uri, rename_item,
    reveal_in_file_manager, search_in_project, write_binary_file, write_file, EncodingState,
};
```

(Added `move_item` alphabetically between `list_directory` and `read_file`.)

- [ ] **Step 2: Register in both command builders**

In `core/src/lib.rs`, inside `collect_commands![…]` for `#[cfg(feature = "sync")]` (around line 85) add `move_item,` immediately after `rename_item,`:

```rust
        rename_item,
        move_item,
        delete_item,
```

Do the same inside the `#[cfg(not(feature = "sync"))]` branch (around line 146-147):

```rust
        rename_item,
        move_item,
        delete_item,
```

- [ ] **Step 3: Regenerate bindings and confirm `moveItem` appears**

```bash
cd core && cargo build --features codegen --no-default-features
```

Then:

```bash
grep -n "moveItem" ../app/lib/ipc/commands.ts
```

Expected: one line like `moveItem: (sourcePath: string, targetDir: String) => …` (casing is `moveItem`).

- [ ] **Step 4: Run the full Rust suite**

```bash
pnpm test:rust
```

Expected: 160+ tests pass (pre-existing count + 4 from Task 1).

- [ ] **Step 5: Commit**

```bash
git add core/src/lib.rs app/lib/ipc/commands.ts
git commit -m "feat(core): register move_item command and regen TS bindings"
```

---

## Task 3: Extend `projectStore` with tree model

**Files:**
- Modify: `app/lib/stores/project.svelte.ts`
- Test: `tests/unit/stores/project-tree.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/stores/project-tree.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { projectStore, type FileNode } from '../../../app/lib/stores/project.svelte';

vi.mock('../../../app/lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
  },
}));

import { commands } from '../../../app/lib/ipc/commands';

function node(name: string, isDir: boolean, path = `/proj/${name}`): FileNode {
  return { name, path, is_dir: isDir, size: 0, expanded: false, loading: false };
}

describe('projectStore tree extensions', () => {
  beforeEach(() => {
    projectStore.close();
    vi.clearAllMocks();
  });

  it('expandFolder lazily loads children on first call', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.expanded).toBe(true);
    expect(sub.children).toHaveLength(1);
    expect(sub.children![0].name).toBe('a.md');
    expect(commands.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('expandFolder does not re-fetch when children already loaded', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({ status: 'ok', data: [] });

    await projectStore.expandFolder('/proj/sub');
    await projectStore.collapseFolder('/proj/sub');
    await projectStore.expandFolder('/proj/sub');

    expect(commands.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('collapseFolder preserves cached children', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');
    await projectStore.collapseFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.expanded).toBe(false);
    expect(sub.children).toHaveLength(1);
  });

  it('refreshFolder re-fetches an already-loaded folder', async () => {
    projectStore.setProject('/proj', null, [node('sub', true)]);
    (commands.listDirectory as any).mockResolvedValueOnce({
      status: 'ok',
      data: [{ name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 }],
    });

    await projectStore.expandFolder('/proj/sub');

    (commands.listDirectory as any).mockResolvedValueOnce({
      status: 'ok',
      data: [
        { name: 'a.md', path: '/proj/sub/a.md', is_dir: false, size: 0 },
        { name: 'b.md', path: '/proj/sub/b.md', is_dir: false, size: 0 },
      ],
    });

    await projectStore.refreshFolder('/proj/sub');

    const sub = projectStore.files.find(f => f.path === '/proj/sub')!;
    expect(sub.children).toHaveLength(2);
    expect(sub.expanded).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
pnpm test -- tests/unit/stores/project-tree.test.ts
```

Expected: fails with "FileNode type not exported" / `expandFolder is not a function`.

- [ ] **Step 3: Extend the store**

Replace the whole body of `app/lib/stores/project.svelte.ts` with:

```ts
import type { FileEntry, ProjectConfig } from '$lib/ipc/commands';
import { commands } from '$lib/ipc/commands';

export interface FileNode extends FileEntry {
  /** undefined = children never loaded; [] = loaded but empty. */
  children?: FileNode[];
  expanded: boolean;
  loading: boolean;
  /** UI-only: set during dragover on this folder so the component can highlight it. */
  dragOver?: boolean;
}

function toNode(entry: FileEntry): FileNode {
  return { ...entry, expanded: false, loading: false };
}

/** Walk the tree depth-first and return the first FileNode with the given path. */
function findNode(nodes: FileNode[], path: string): FileNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return undefined;
}

class ProjectStore {
  dirPath = $state<string | null>(null);
  config = $state<ProjectConfig | null>(null);
  files = $state<FileNode[]>([]);
  isLoading = $state(false);
  singleFileMode = $state(false);

  get isOpen() { return this.dirPath !== null || this.singleFileMode; }

  get name() {
    if (this.config) return this.config.project.name;
    if (this.dirPath) {
      const parts = this.dirPath.split('/');
      return parts[parts.length - 1] || 'Untitled';
    }
    return 'No Project';
  }

  enterSingleFileMode() {
    this.singleFileMode = true;
    this.dirPath = null;
    this.config = null;
    this.files = [];
  }

  setProject(dirPath: string, config: ProjectConfig | null, files: FileEntry[]) {
    this.dirPath = dirPath;
    this.config = config;
    this.files = files.map(toNode);
    this.isLoading = false;
    this.singleFileMode = false;
  }

  /** Replace the project-root children. Used by legacy callers; preserves expansion state of still-present folders. */
  updateFiles(files: FileEntry[]) {
    const prev = new Map(this.files.map(n => [n.path, n]));
    this.files = files.map(e => {
      const existing = prev.get(e.path);
      if (existing && existing.is_dir && e.is_dir) {
        return { ...e, children: existing.children, expanded: existing.expanded, loading: false };
      }
      return toNode(e);
    });
  }

  close() {
    this.dirPath = null;
    this.config = null;
    this.files = [];
    this.singleFileMode = false;
  }

  /** Find a folder node anywhere in the tree. */
  findFolder(path: string): FileNode | undefined {
    const n = findNode(this.files, path);
    return n && n.is_dir ? n : undefined;
  }

  /** Expand a folder, loading its children the first time. */
  async expandFolder(path: string): Promise<void> {
    const node = this.findFolder(path);
    if (!node) return;
    if (node.children === undefined) {
      node.loading = true;
      const result = await commands.listDirectory(path);
      if (result.status === 'ok') {
        node.children = result.data.map(toNode);
      } else {
        node.children = [];
      }
      node.loading = false;
    }
    node.expanded = true;
  }

  collapseFolder(path: string): void {
    const node = this.findFolder(path);
    if (node) node.expanded = false;
  }

  /** Re-fetch children for a previously-loaded folder (used by file watcher + post-move). */
  async refreshFolder(path: string): Promise<void> {
    // Project root is represented by `this.files` (no wrapper node).
    if (path === this.dirPath) {
      const result = await commands.listDirectory(path);
      if (result.status === 'ok') this.updateFiles(result.data);
      return;
    }
    const node = this.findFolder(path);
    if (!node || node.children === undefined) return; // not loaded -> nothing to refresh
    const result = await commands.listDirectory(path);
    if (result.status !== 'ok') return;
    const prev = new Map(node.children.map(n => [n.path, n]));
    node.children = result.data.map(e => {
      const existing = prev.get(e.path);
      if (existing && existing.is_dir && e.is_dir) {
        return { ...e, children: existing.children, expanded: existing.expanded, loading: false };
      }
      return toNode(e);
    });
  }
}

export const projectStore = new ProjectStore();
```

- [ ] **Step 4: Run the tests**

```bash
pnpm test -- tests/unit/stores/project-tree.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Run the full frontend suite to catch regressions**

```bash
pnpm test
```

Expected: all previously passing tests still pass. `projectStore.files` type changed from `FileEntry[]` to `FileNode[]`, but since `FileNode extends FileEntry`, callers reading `name`/`path`/`is_dir`/`size` still compile. If `pnpm check` complains somewhere, fix locally (see Task 5 for the Sidebar consumer).

- [ ] **Step 6: Commit**

```bash
git add app/lib/stores/project.svelte.ts tests/unit/stores/project-tree.test.ts
git commit -m "feat(sidebar): add FileNode tree model to projectStore"
```

---

## Task 4: `FileTreeNode.svelte` recursive component

**Files:**
- Create: `app/lib/components/FileTreeNode.svelte`
- Test: none at unit level — DOM recursion is covered by the Playwright test in Task 7.

- [ ] **Step 1: Create the component**

Create `app/lib/components/FileTreeNode.svelte`:

```svelte
<script lang="ts">
  import { projectStore, type FileNode } from '$lib/stores/project.svelte';
  import { tabsStore } from '$lib/stores/tabs.svelte';
  import { commands } from '$lib/ipc/commands';

  interface Props {
    node: FileNode;
    depth: number;
    onContextMenu: (e: MouseEvent, node: FileNode) => void;
    onFileOpen: (node: FileNode) => void | Promise<void>;
    onDragStart: (e: DragEvent, node: FileNode) => void;
    onDragOver: (e: DragEvent, node: FileNode) => void;
    onDragLeave: (e: DragEvent, node: FileNode) => void;
    onDrop: (e: DragEvent, node: FileNode) => void | Promise<void>;
    isTextFile: (name: string) => boolean;
  }

  let {
    node,
    depth,
    onContextMenu,
    onFileOpen,
    onDragStart,
    onDragOver,
    onDragLeave,
    onDrop,
    isTextFile,
  }: Props = $props();

  // Sort: folders first, then files, both alphabetical.
  function sortChildren(children: FileNode[]): FileNode[] {
    const dirs = children.filter(c => c.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    const files = children.filter(c => !c.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  async function toggleFolder() {
    if (node.expanded) projectStore.collapseFolder(node.path);
    else await projectStore.expandFolder(node.path);
  }

  const indentPx = $derived(depth * 12 + 6);
</script>

{#if node.is_dir}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    role="treeitem"
    aria-expanded={node.expanded}
    tabindex="0"
    class="tree-row tree-dir"
    class:drag-over={node.dragOver}
    style="padding-left: {indentPx}px;"
    data-testid="sidebar-folder-{node.name}"
    oncontextmenu={(e) => onContextMenu(e, node)}
    ondragover={(e) => onDragOver(e, node)}
    ondragleave={(e) => onDragLeave(e, node)}
    ondrop={(e) => onDrop(e, node)}
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFolder(); } }}
  >
    <button
      class="tree-chevron"
      aria-label={node.expanded ? 'Collapse' : 'Expand'}
      onclick={toggleFolder}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
        <path d={node.expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
      </svg>
    </button>
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M2 4h4l2 2h6v7H2z" />
    </svg>
    <span class="tree-name">{node.name}</span>
  </div>

  {#if node.expanded && node.children}
    {#each sortChildren(node.children) as child (child.path)}
      <svelte:self
        node={child}
        depth={depth + 1}
        {onContextMenu}
        {onFileOpen}
        {onDragStart}
        {onDragOver}
        {onDragLeave}
        {onDrop}
        {isTextFile}
      />
    {/each}
  {/if}
{:else if isTextFile(node.name)}
  <button
    class="tree-row tree-file"
    class:tree-file-active={tabsStore.activeTab?.filePath === node.path}
    style="padding-left: {indentPx + 16}px;"
    data-testid="sidebar-file-{node.name}"
    draggable="true"
    ondragstart={(e) => onDragStart(e, node)}
    onclick={() => onFileOpen(node)}
    oncontextmenu={(e) => onContextMenu(e, node)}
  >
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
    <span class="tree-name">{node.name.replace(/\.(md|markdown|txt|json|jsonl|csv)$/i, '')}</span>
    <span class="tree-ext">.{node.name.split('.').pop()}</span>
  </button>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    role="treeitem"
    class="tree-row tree-file tree-disabled"
    style="padding-left: {indentPx + 16}px;"
    oncontextmenu={(e) => onContextMenu(e, node)}
  >
    <svg class="tree-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
    </svg>
    <span class="tree-name">{node.name}</span>
  </div>
{/if}

<style>
  .tree-row {
    display: flex;
    align-items: center;
    width: 100%;
    padding-top: 5px;
    padding-bottom: 5px;
    padding-right: 8px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-sidebar-text);
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
    transition: background 80ms;
    white-space: nowrap;
    overflow: hidden;
    gap: 6px;
  }
  .tree-row:hover { background: var(--novelist-sidebar-hover); }
  .tree-dir {
    cursor: default;
    color: var(--novelist-text-secondary);
    font-size: 0.92rem;
  }
  .tree-chevron {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--novelist-text-secondary);
    cursor: pointer;
    flex-shrink: 0;
  }
  .tree-chevron:hover { color: var(--novelist-text); }
  .tree-icon { flex-shrink: 0; opacity: 0.5; }
  .tree-file-active {
    background: var(--novelist-sidebar-active) !important;
    color: var(--novelist-text);
  }
  .tree-file-active .tree-icon { opacity: 0.75; }
  .tree-disabled { cursor: default; opacity: 0.35; }
  .tree-name { overflow: hidden; text-overflow: ellipsis; }
  .tree-ext {
    color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
    font-size: 0.78rem;
    flex-shrink: 0;
  }
  .drag-over {
    background: color-mix(in srgb, var(--novelist-accent) 18%, transparent) !important;
    outline: 1px dashed var(--novelist-accent);
    outline-offset: -1px;
  }
</style>
```

- [ ] **Step 2: Confirm it compiles**

```bash
pnpm check
```

Expected: no new errors (pre-existing warnings ok).

- [ ] **Step 3: Commit**

```bash
git add app/lib/components/FileTreeNode.svelte
git commit -m "feat(sidebar): add FileTreeNode recursive component"
```

---

## Task 5: Wire `Sidebar.svelte` to use the tree component + drag-drop

**Files:**
- Modify: `app/lib/components/Sidebar.svelte`

- [ ] **Step 1: Replace the flat `{#each}` in Sidebar.svelte with recursive rendering**

(`FileNode.dragOver?: boolean` was already added to the interface in Task 3 — no store changes needed here.)

In `app/lib/components/Sidebar.svelte`:

- At the top of `<script lang="ts">`, add the import:

  ```ts
  import FileTreeNode from '$lib/components/FileTreeNode.svelte';
  import type { FileNode } from '$lib/stores/project.svelte';
  ```

- Change `sortedFiles` (currently at line 75-79) so its type is `FileNode[]`:

  ```ts
  let sortedFiles = $derived.by<FileNode[]>(() => {
    const dirs = projectStore.files.filter(f => f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    const files = projectStore.files.filter(f => !f.is_dir).sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  });
  ```

- Change every `FileEntry` reference in this file to `FileNode` (look for the context-menu state `contextMenu = $state<{ x: number; y: number; entry: FileEntry } | null>(null);` — change to `FileNode`, and `renaming = $state<FileEntry | null>(null);` — change to `FileNode`). Function params `entry: FileEntry` become `entry: FileNode` throughout. Delete the now-unused `import type { FileEntry, RecentProject } from '$lib/ipc/commands';` — replace with `import type { RecentProject } from '$lib/ipc/commands';` (FileNode is imported from the store).

- Add drag-drop handler functions (paste inside `<script>`, after the existing context-menu helpers):

  ```ts
  let draggedNode = $state<FileNode | null>(null);

  function handleDragStart(e: DragEvent, node: FileNode) {
    if (!e.dataTransfer) return;
    draggedNode = node;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-novelist-path', node.path);
  }

  function isDescendant(source: FileNode, targetPath: string): boolean {
    if (!source.is_dir) return false;
    return targetPath === source.path || targetPath.startsWith(source.path + '/');
  }

  function handleDragOverFolder(e: DragEvent, target: FileNode) {
    if (!draggedNode) return;
    if (!target.is_dir) return;
    if (isDescendant(draggedNode, target.path)) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    target.dragOver = true;
  }

  function handleDragLeaveFolder(_e: DragEvent, target: FileNode) {
    target.dragOver = false;
  }

  async function handleDropOnFolder(e: DragEvent, target: FileNode) {
    e.preventDefault();
    target.dragOver = false;
    const source = draggedNode;
    draggedNode = null;
    if (!source || !target.is_dir) return;
    if (isDescendant(source, target.path)) return;
    if (source.path === target.path) return;

    const parentPath = source.path.slice(0, source.path.lastIndexOf('/'));
    if (parentPath === target.path) return; // no-op: already in that folder

    const result = await commands.moveItem(source.path, target.path);
    if (result.status !== 'ok') {
      console.error('Move failed:', result.error);
      return;
    }
    const newPath = result.data;

    // Update any open tab whose path starts with the moved source.
    for (const pane of tabsStore.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === source.path) {
          tabsStore.updateFilePath(tab.id, newPath);
        } else if (tab.filePath.startsWith(source.path + '/')) {
          tabsStore.updateFilePath(tab.id, newPath + tab.filePath.slice(source.path.length));
        }
      }
    }

    // Refresh affected folders.
    await projectStore.refreshFolder(parentPath);
    await projectStore.refreshFolder(target.path);
  }

  // Root drop zone handlers (drop onto empty sidebar area = move to project root).
  let rootDragOver = $state(false);

  function handleDragOverRoot(e: DragEvent) {
    if (!draggedNode || !projectStore.dirPath) return;
    if (isDescendant(draggedNode, projectStore.dirPath)) return; // can't happen for items outside root
    const parentPath = draggedNode.path.slice(0, draggedNode.path.lastIndexOf('/'));
    if (parentPath === projectStore.dirPath) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    rootDragOver = true;
  }

  function handleDragLeaveRoot() { rootDragOver = false; }

  async function handleDropOnRoot(e: DragEvent) {
    e.preventDefault();
    rootDragOver = false;
    const source = draggedNode;
    draggedNode = null;
    if (!source || !projectStore.dirPath) return;
    const parentPath = source.path.slice(0, source.path.lastIndexOf('/'));
    if (parentPath === projectStore.dirPath) return;

    const result = await commands.moveItem(source.path, projectStore.dirPath);
    if (result.status !== 'ok') return;
    const newPath = result.data;
    for (const pane of tabsStore.panes) {
      for (const tab of pane.tabs) {
        if (tab.filePath === source.path || tab.filePath.startsWith(source.path + '/')) {
          const rest = tab.filePath.slice(source.path.length);
          tabsStore.updateFilePath(tab.id, newPath + rest);
        }
      }
    }
    await projectStore.refreshFolder(parentPath);
    await projectStore.refreshFolder(projectStore.dirPath);
  }
  ```

- Replace the `{#each sortedFiles as entry} … {/each}` block (currently lines 397-437) with:

  ```svelte
  {#each sortedFiles as entry (entry.path)}
    {#if renaming && renaming.path === entry.path}
      <div class="sidebar-input-row">
        <input
          bind:this={renameInput}
          bind:value={renameValue}
          onkeydown={handleRenameKeydown}
          onblur={confirmRename}
          class="sidebar-input"
          data-testid="sidebar-input"
        />
      </div>
    {:else}
      <FileTreeNode
        node={entry}
        depth={0}
        onContextMenu={handleContextMenu}
        onFileOpen={openFile}
        onDragStart={handleDragStart}
        onDragOver={handleDragOverFolder}
        onDragLeave={handleDragLeaveFolder}
        onDrop={handleDropOnFolder}
        {isTextFile}
      />
    {/if}
  {/each}
  ```

  NOTE: `openFile` is already defined. Its signature stays `async function openFile(entry: FileEntry)` — extend the param type to `FileNode`.

- Wrap the `<div class="sidebar-files">` so its empty tail acts as the root drop zone. Edit the outer div opening tag:

  ```svelte
  <div
    class="sidebar-files"
    class:drag-over-root={rootDragOver}
    bind:this={filesContainer}
    ondragover={handleDragOverRoot}
    ondragleave={handleDragLeaveRoot}
    ondrop={handleDropOnRoot}
  >
  ```

- Add matching CSS to the `<style>` block:

  ```css
  .sidebar-files.drag-over-root {
    box-shadow: inset 0 0 0 2px var(--novelist-accent);
  }
  ```

- [ ] **Step 2: Type-check**

```bash
pnpm check
```

Expected: no errors related to our changes.

- [ ] **Step 3: Run the unit suite**

```bash
pnpm test
```

Expected: all green (existing tests plus Task 3's new ones).

- [ ] **Step 4: Commit**

```bash
git add app/lib/components/Sidebar.svelte
git commit -m "feat(sidebar): recursive tree + HTML5 drag-drop with root drop zone"
```

---

## Task 6: Auto-refresh expanded folders on file-watcher events

**Files:**
- Modify: `app/App.svelte` (the `listen<{ path: string }>('file-changed', …)` handler around line 683)

- [ ] **Step 1: Extend the listener**

In `app/App.svelte`, replace the current handler (lines 683-696) with:

```ts
listen<{ path: string }>('file-changed', async (event) => {
  const { path } = event.payload;

  // Refresh tab content if a currently-open file changed on disk.
  const tab = tabsStore.findByPath(path);
  if (tab) {
    if (!tab.isDirty) {
      const result = await commands.readFile(path);
      if (result.status === 'ok') {
        tabsStore.reloadContent(tab.id, result.data);
      }
    } else {
      conflictFilePath = path;
    }
  }

  // Also refresh the sidebar folder containing the changed path, IF it's
  // been loaded (expanded at least once). Non-loaded folders get content
  // lazily on next expand, so there's nothing to do for them.
  const parentPath = path.slice(0, path.lastIndexOf('/'));
  if (parentPath) {
    await projectStore.refreshFolder(parentPath);
  }
}).then(fn => { unlistenFileChanged = fn; });
```

- [ ] **Step 2: Type-check**

```bash
pnpm check
```

Expected: clean.

- [ ] **Step 3: Run unit tests**

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add app/App.svelte
git commit -m "feat(sidebar): refresh tree on file-watcher events for loaded folders"
```

---

## Task 7: Playwright E2E for tree + drag-drop

**Files:**
- Modify: `tests/e2e/fixtures/tauri-mock.ts` (add `move_item` + make `list_directory` subfolder-aware)
- Create or extend: `tests/e2e/specs/sidebar.spec.ts`

- [ ] **Step 1: Extend the Tauri mock to support subfolders and `move_item`**

In `tests/e2e/fixtures/tauri-mock.ts`, locate the `handleInvoke` switch (around line 24) and replace the `list_directory` and add `move_item`:

```js
          case 'list_directory': {
            const prefix = args.path.endsWith('/') ? args.path : args.path + '/';
            return files.filter(f => {
              if (!f.path.startsWith(prefix)) return false;
              const rest = f.path.slice(prefix.length);
              return rest.length > 0 && !rest.includes('/');
            });
          }
          case 'move_item': {
            const src = args.sourcePath;
            const parent = args.targetDir.endsWith('/') ? args.targetDir : args.targetDir + '/';
            const name = src.slice(src.lastIndexOf('/') + 1);
            const dest = parent + name;
            for (let i = 0; i < files.length; i++) {
              if (files[i].path === src) {
                files[i] = { ...files[i], path: dest };
              } else if (files[i].path.startsWith(src + '/')) {
                files[i] = { ...files[i], path: dest + files[i].path.slice(src.length) };
              }
            }
            return dest;
          }
```

(The existing `list_directory` always returned the full list; now it correctly scopes to a single directory level, which the real Rust command does too.)

- [ ] **Step 2: Seed mock data with a nested folder**

Find where the fixture sets up `files` (check `tests/e2e/fixtures/mock-data.ts` or `app-fixture.ts`). Add a subfolder and a file inside it to the default seed:

```ts
// Inside the default mock files array
{ name: 'drafts', path: '/mock/project/drafts', is_dir: true, size: 0 },
{ name: 'chapter-1.md', path: '/mock/project/drafts/chapter-1.md', is_dir: false, size: 42 },
```

(Adjust paths to match whatever project dir the fixture already uses.)

- [ ] **Step 3: Write the E2E test**

Add to `tests/e2e/specs/sidebar.spec.ts`:

```ts
test('folder expand/collapse + drag a root file into subfolder', async ({ app }) => {
  // Subfolder visible but collapsed.
  const folder = app.getByTestId('sidebar-folder-drafts');
  await expect(folder).toBeVisible();

  // Child is NOT visible before expand.
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toHaveCount(0);

  // Click the chevron (it's the first <button> inside the folder row).
  await folder.getByRole('button', { name: /Expand/i }).click();
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toBeVisible();

  // Drag a root-level file into the subfolder.
  const rootFile = app.getByTestId('sidebar-file-notes.md');
  await rootFile.dragTo(folder);

  // After drop the file should appear inside drafts/.
  await expect(app.getByTestId('sidebar-file-notes.md')).toBeVisible();
  // And drafts should now contain TWO files (chapter-1.md + notes.md). Assert by
  // finding them both inside the expanded folder's aria-level context or by
  // checking their sidebar-file testids are both present.
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toBeVisible();
});

test('clicking chevron toggles expansion without refetching', async ({ app, mockState }) => {
  const folder = app.getByTestId('sidebar-folder-drafts');
  const chevron = folder.getByRole('button', { name: /Expand|Collapse/i });
  await chevron.click();
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toBeVisible();
  await chevron.click();
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toHaveCount(0);
  await chevron.click();
  await expect(app.getByTestId('sidebar-file-chapter-1.md')).toBeVisible();
});
```

(The `notes.md` file in the test assumes it already exists in mock seed data. If the seed file name is different, adjust.)

- [ ] **Step 4: Run the tests**

```bash
pnpm test:e2e:browser -- sidebar.spec.ts
```

Expected: new tests pass. If the first test fails because Playwright's `dragTo` doesn't trigger the Svelte handlers, switch to manual events:

```ts
await rootFile.dispatchEvent('dragstart');
await folder.dispatchEvent('dragover');
await folder.dispatchEvent('drop');
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/fixtures/tauri-mock.ts tests/e2e/specs/sidebar.spec.ts \
       tests/e2e/fixtures/mock-data.ts
git commit -m "test(e2e): sidebar folder tree and drag-drop"
```

---

# Phase 2 — Plugins "+" Button with Dropdown

## Task 8: Add `scaffold_plugin` Rust command

**Files:**
- Modify: `core/src/commands/plugin.rs` (append command + tests)

- [ ] **Step 1: Find or create the `#[cfg(test)] mod tests` block**

Check whether `core/src/commands/plugin.rs` already has a test module. If not, append this at the end of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // Helper: create a scoped plugins_dir for isolation. We override HOME so
    // `dirs::home_dir()` returns the temp dir.
    fn with_temp_home<F>(test: F)
    where
        F: FnOnce(&TempDir),
    {
        let tmp = TempDir::new().unwrap();
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        test(&tmp);
        if let Some(h) = old { std::env::set_var("HOME", h); } else { std::env::remove_var("HOME"); }
    }
}
```

If the test module exists, skip creating the scaffold — just add the four tests below to the existing `mod tests` block.

- [ ] **Step 2: Write the failing tests**

Add inside `mod tests`:

```rust
#[tokio::test]
async fn test_scaffold_plugin_creates_files() {
    let tmp = TempDir::new().unwrap();
    let old = std::env::var_os("HOME");
    std::env::set_var("HOME", tmp.path());

    let result = scaffold_plugin("sentence-counter".to_string(), Some("Sentence Counter".into())).await.unwrap();
    assert!(result.ends_with("/.novelist/plugins/sentence-counter"));
    let dir = std::path::PathBuf::from(&result);
    assert!(dir.join("manifest.toml").is_file());
    assert!(dir.join("index.js").is_file());
    let manifest = std::fs::read_to_string(dir.join("manifest.toml")).unwrap();
    assert!(manifest.contains("id = \"sentence-counter\""));
    assert!(manifest.contains("name = \"Sentence Counter\""));

    if let Some(h) = old { std::env::set_var("HOME", h); } else { std::env::remove_var("HOME"); }
}

#[tokio::test]
async fn test_scaffold_plugin_rejects_invalid_id() {
    for bad in ["", "Foo", "foo bar", "_foo", "foo/bar", "-foo"] {
        let result = scaffold_plugin(bad.to_string(), None).await;
        assert!(result.is_err(), "expected error for id '{bad}'");
    }
}

#[tokio::test]
async fn test_scaffold_plugin_rejects_duplicate() {
    let tmp = TempDir::new().unwrap();
    let old = std::env::var_os("HOME");
    std::env::set_var("HOME", tmp.path());

    scaffold_plugin("dup".to_string(), None).await.unwrap();
    let second = scaffold_plugin("dup".to_string(), None).await;
    assert!(second.is_err());

    if let Some(h) = old { std::env::set_var("HOME", h); } else { std::env::remove_var("HOME"); }
}

#[tokio::test]
async fn test_scaffold_plugin_defaults_display_name_to_id() {
    let tmp = TempDir::new().unwrap();
    let old = std::env::var_os("HOME");
    std::env::set_var("HOME", tmp.path());

    let result = scaffold_plugin("foo".to_string(), None).await.unwrap();
    let manifest = std::fs::read_to_string(std::path::Path::new(&result).join("manifest.toml")).unwrap();
    assert!(manifest.contains("name = \"foo\""));

    if let Some(h) = old { std::env::set_var("HOME", h); } else { std::env::remove_var("HOME"); }
}
```

NOTE: Tests mutate `HOME` env var. Running them in parallel with other home-dependent tests would race. The existing `#[tokio::test]` style in the project already uses TempDir without env mutation (because commands take an explicit path arg). This is the exception because `plugins_dir()` reads `dirs::home_dir()` internally. If the existing plugin test module already establishes a convention (e.g. using `#[serial]`), follow it; otherwise accept that scaffold tests serialize via the `HOME` lock implicitly.

- [ ] **Step 3: Run to confirm failure**

```bash
cd core && cargo test --no-default-features --features codegen commands::plugin::tests::test_scaffold
```

Expected: compile error ("cannot find function `scaffold_plugin`").

- [ ] **Step 4: Implement `scaffold_plugin`**

Add inside `core/src/commands/plugin.rs` (after `set_plugin_enabled`, before the `#[cfg(test)]` block):

```rust
/// Create a minimal plugin at ~/.novelist/plugins/<id>/ with manifest.toml + index.js.
/// ID must match `[a-z0-9][a-z0-9-]*`. display_name defaults to id.
#[tauri::command]
#[specta::specta]
pub async fn scaffold_plugin(
    id: String,
    display_name: Option<String>,
) -> Result<String, AppError> {
    // Manual validation (no regex dep): non-empty, starts with [a-z0-9], remaining chars [a-z0-9-].
    let valid = !id.is_empty()
        && id
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .unwrap_or(false)
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !valid {
        return Err(AppError::InvalidInput(format!(
            "Plugin ID must match [a-z0-9][a-z0-9-]*, got '{id}'"
        )));
    }

    let plugins = plugins_dir();
    tokio::fs::create_dir_all(&plugins).await?;
    let dir = plugins.join(&id);
    if dir.exists() {
        return Err(AppError::InvalidInput(format!(
            "Plugin directory already exists: {}",
            dir.display()
        )));
    }

    let name = display_name.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| id.clone());

    let manifest = format!(
        "id = \"{id}\"\n\
         name = \"{name}\"\n\
         version = \"0.1.0\"\n\
         author = \"\"\n\
         description = \"\"\n\
         permissions = []\n\
         entry = \"index.js\"\n"
    );
    let index_js = "// Minimal Novelist plugin - runs in QuickJS sandbox.\n\
export default {\n\
  activate(ctx) {\n\
    // ctx.registerCommand({ id: \"example\", title: \"Example\", run: () => {} });\n\
  }\n\
};\n";

    // Write to <id>.tmp then rename, so a partial failure doesn't leave a half-baked dir.
    let tmp = plugins.join(format!("{id}.tmp"));
    if tmp.exists() {
        tokio::fs::remove_dir_all(&tmp).await?;
    }
    tokio::fs::create_dir_all(&tmp).await?;
    tokio::fs::write(tmp.join("manifest.toml"), manifest).await?;
    tokio::fs::write(tmp.join("index.js"), index_js).await?;
    tokio::fs::rename(&tmp, &dir).await?;

    Ok(dir.to_string_lossy().to_string())
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
cd core && cargo test --no-default-features --features codegen commands::plugin::tests::test_scaffold
```

Expected: 4 tests pass.

- [ ] **Step 6: Run full plugin test module**

```bash
cd core && cargo test --no-default-features --features codegen commands::plugin::tests
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/commands/plugin.rs
git commit -m "feat(plugins): add scaffold_plugin command"
```

---

## Task 9: Register `scaffold_plugin` + regenerate bindings

**Files:**
- Modify: `core/src/lib.rs`

- [ ] **Step 1: Extend the plugin import**

In `core/src/lib.rs:17-20`, add `scaffold_plugin`:

```rust
use commands::plugin::{
    get_plugin_commands, invoke_plugin_command, list_plugins, load_plugin, scaffold_plugin,
    set_plugin_document_state, set_plugin_enabled, unload_plugin,
};
```

- [ ] **Step 2: Register in both command lists**

In both `collect_commands![…]` bodies, add `scaffold_plugin,` immediately after `set_plugin_enabled,`.

- [ ] **Step 3: Regenerate bindings**

```bash
cd core && cargo build --features codegen --no-default-features
grep -n "scaffoldPlugin" ../app/lib/ipc/commands.ts
```

Expected: a line defining `scaffoldPlugin: (id: string, displayName: string | null) => …`.

- [ ] **Step 4: Run all Rust tests**

```bash
pnpm test:rust
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add core/src/lib.rs app/lib/ipc/commands.ts
git commit -m "feat(plugins): register scaffold_plugin and regen TS bindings"
```

---

## Task 10: `PluginScaffoldDialog.svelte`

**Files:**
- Create: `app/lib/components/PluginScaffoldDialog.svelte`

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import { commands } from '$lib/ipc/commands';
  import { t } from '$lib/i18n';

  interface Props {
    existingIds: string[];
    onCancel: () => void;
    onCreated: (pluginPath: string) => void;
  }
  let { existingIds, onCancel, onCreated }: Props = $props();

  let id = $state('');
  let name = $state('');
  let busy = $state(false);
  let errorMsg = $state('');

  const idPattern = /^[a-z0-9][a-z0-9-]*$/;

  let validation = $derived.by<string>(() => {
    if (id.length === 0) return '';
    if (!idPattern.test(id)) return t('settings.plugins.scaffold.invalidId');
    if (existingIds.includes(id)) return t('settings.plugins.scaffold.idTaken');
    return '';
  });

  let canSubmit = $derived(id.length > 0 && validation === '' && !busy);

  async function submit() {
    if (!canSubmit) return;
    busy = true;
    errorMsg = '';
    const result = await commands.scaffoldPlugin(id, name.trim() || null);
    busy = false;
    if (result.status === 'ok') {
      onCreated(result.data);
    } else {
      errorMsg = typeof result.error === 'string' ? result.error : 'Unknown error';
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Enter' && canSubmit) { e.preventDefault(); submit(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scaffold-overlay" onkeydown={onKeydown}>
  <div class="scaffold-panel" data-testid="plugin-scaffold-dialog">
    <h4 class="scaffold-title">{t('settings.plugins.scaffold.title')}</h4>

    <label class="scaffold-label" for="scaffold-id">{t('settings.plugins.scaffold.id')}</label>
    <input
      id="scaffold-id"
      class="scaffold-input"
      bind:value={id}
      placeholder="my-plugin"
      autocomplete="off"
      data-testid="plugin-scaffold-id"
    />
    {#if validation}
      <p class="scaffold-hint">{validation}</p>
    {/if}

    <label class="scaffold-label" for="scaffold-name">{t('settings.plugins.scaffold.name')}</label>
    <input
      id="scaffold-name"
      class="scaffold-input"
      bind:value={name}
      placeholder={id || 'My Plugin'}
      autocomplete="off"
    />

    {#if errorMsg}
      <p class="scaffold-error">{errorMsg}</p>
    {/if}

    <div class="scaffold-actions">
      <button class="scaffold-btn" onclick={onCancel} disabled={busy}>{t('settings.plugins.scaffold.cancel')}</button>
      <button
        class="scaffold-btn scaffold-btn-primary"
        onclick={submit}
        disabled={!canSubmit}
        data-testid="plugin-scaffold-create"
      >{t('settings.plugins.scaffold.create')}</button>
    </div>
  </div>
</div>

<style>
  .scaffold-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .scaffold-panel {
    min-width: 320px;
    padding: 16px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    color: var(--novelist-text);
  }
  .scaffold-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 12px; }
  .scaffold-label { display: block; font-size: 0.75rem; margin-top: 8px; margin-bottom: 4px; color: var(--novelist-text-secondary); }
  .scaffold-input {
    width: 100%;
    padding: 6px 10px;
    font-size: 0.85rem;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: var(--novelist-bg-secondary);
    color: var(--novelist-text);
    outline: none;
  }
  .scaffold-input:focus { border-color: var(--novelist-accent); }
  .scaffold-hint { color: #e5484d; font-size: 0.72rem; margin-top: 4px; }
  .scaffold-error { color: #e5484d; font-size: 0.72rem; margin-top: 8px; }
  .scaffold-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .scaffold-btn {
    padding: 5px 12px;
    font-size: 0.78rem;
    border: 1px solid var(--novelist-border);
    border-radius: 5px;
    background: transparent;
    color: var(--novelist-text);
    cursor: pointer;
  }
  .scaffold-btn:hover:not(:disabled) { border-color: var(--novelist-accent); }
  .scaffold-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .scaffold-btn-primary {
    background: var(--novelist-accent);
    color: #fff;
    border-color: var(--novelist-accent);
  }
</style>
```

- [ ] **Step 2: Type-check**

```bash
pnpm check
```

Expected: will flag missing i18n keys (`settings.plugins.scaffold.*`). That's fixed in Task 14. For now, if `check` is strict, temporarily replace each `t('settings.plugins.scaffold.xxx')` with its English fallback string until Task 14 — OR do Task 14 first.

**Re-order decision:** do Task 14 immediately after this one; defer committing this component until the i18n keys exist (one commit = one coherent change).

- [ ] **Step 3: Do NOT commit yet**

Proceed to Task 11 (Settings integration) and Task 14 (i18n). Commit all three together in Task 14's commit.

---

## Task 11: Add "+" button + dropdown to Settings > Plugins

**Files:**
- Modify: `app/lib/components/Settings.svelte`

- [ ] **Step 1: Add `get_plugins_dir` Rust command**

Edit `core/src/commands/plugin.rs` — append above `scaffold_plugin`:

```rust
/// Return the absolute path of ~/.novelist/plugins/, creating it if missing.
#[tauri::command]
#[specta::specta]
pub async fn get_plugins_dir() -> Result<String, AppError> {
    let dir = plugins_dir();
    tokio::fs::create_dir_all(&dir).await?;
    Ok(dir.to_string_lossy().to_string())
}
```

Then in `core/src/lib.rs`:
- Add `get_plugins_dir` to the `use commands::plugin::{…}` import list.
- Add `get_plugins_dir,` to BOTH `collect_commands![…]` builders (alongside `scaffold_plugin,`).

Regenerate bindings:

```bash
cd core && cargo build --features codegen --no-default-features
grep -n "getPluginsDir" ../app/lib/ipc/commands.ts
```

Expected: one line defining `getPluginsDir`.

- [ ] **Step 2: Add state and helpers to Settings.svelte**

In `app/lib/components/Settings.svelte` `<script>`, near the existing plugin state (around line 126-145), add:

```ts
import PluginScaffoldDialog from '$lib/components/PluginScaffoldDialog.svelte';

let pluginAddMenuOpen = $state(false);
let scaffoldDialogOpen = $state(false);

async function openPluginsFolder() {
  pluginAddMenuOpen = false;
  const result = await commands.getPluginsDir();
  if (result.status === 'ok') {
    await commands.revealInFileManager(result.data);
  }
}

function openScaffoldDialog() {
  pluginAddMenuOpen = false;
  scaffoldDialogOpen = true;
}

async function onPluginScaffolded(pluginPath: string) {
  scaffoldDialogOpen = false;
  await loadPlugins();
  await commands.revealInFileManager(pluginPath);
}
```

- [ ] **Step 3: Change the heading row to include a "+" button**

Find the plugins section header (around `Settings.svelte:663`):

```svelte
<h3 class="text-xs font-semibold uppercase tracking-wide mb-4" style="color: var(--novelist-text-secondary);">{t('settings.plugins')}</h3>
```

Replace with:

```svelte
<div class="flex items-center justify-between mb-4" style="position: relative;">
  <h3 class="text-xs font-semibold uppercase tracking-wide" style="color: var(--novelist-text-secondary);">{t('settings.plugins')}</h3>
  <button
    class="plugin-add-btn"
    data-testid="plugin-add-btn"
    onclick={(e) => { e.stopPropagation(); pluginAddMenuOpen = !pluginAddMenuOpen; }}
    title={t('settings.plugins.add')}
    aria-label={t('settings.plugins.add')}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
      <path d="M8 3v10M3 8h10" />
    </svg>
  </button>
  {#if pluginAddMenuOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="plugin-add-menu" data-testid="plugin-add-menu" onclick={(e) => e.stopPropagation()}>
      <button class="plugin-add-menu-item" onclick={openPluginsFolder}>{t('settings.plugins.openFolder')}</button>
      <button class="plugin-add-menu-item" onclick={openScaffoldDialog}>{t('settings.plugins.createFromTemplate')}</button>
    </div>
  {/if}
</div>

<svelte:window onclick={() => { pluginAddMenuOpen = false; }} />

{#if scaffoldDialogOpen}
  <PluginScaffoldDialog
    existingIds={plugins.map(p => p.id)}
    onCancel={() => scaffoldDialogOpen = false}
    onCreated={onPluginScaffolded}
  />
{/if}
```

- [ ] **Step 4: Add matching CSS to the existing `<style>` block**

```css
.plugin-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--novelist-text-tertiary, var(--novelist-text-secondary));
  cursor: pointer;
  transition: background 100ms, color 100ms;
}
.plugin-add-btn:hover {
  background: var(--novelist-sidebar-hover);
  color: var(--novelist-accent);
}
.plugin-add-menu {
  position: absolute;
  top: 28px;
  right: 0;
  z-index: 30;
  min-width: 180px;
  padding: 4px;
  border-radius: 8px;
  background: var(--novelist-bg);
  border: 1px solid var(--novelist-border);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
}
.plugin-add-menu-item {
  display: block;
  width: 100%;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--novelist-text);
  font-size: 0.78rem;
  text-align: left;
  cursor: pointer;
}
.plugin-add-menu-item:hover { background: var(--novelist-sidebar-hover); }
```

- [ ] **Step 5: Type-check (expect i18n key errors to remain until Task 14)**

```bash
pnpm check
```

Expected: missing keys `settings.plugins.add`, `settings.plugins.openFolder`, `settings.plugins.createFromTemplate`, `settings.plugins.scaffold.*` — all added in Task 14.

- [ ] **Step 6: Do NOT commit yet**

Commit this along with Task 14 so the "+" button never appears in git history without its i18n strings.

---

## Task 12: (merged into Task 11 — deliberate)

Skipped: Phase 2's i18n keys are added in Task 14 alongside Phase 3's. That keeps all new localized strings in one commit.

---

# Phase 3 — "?" Help Tooltip

## Task 13: `HelpTooltip.svelte` component

**Files:**
- Create: `app/lib/components/HelpTooltip.svelte`

- [ ] **Step 1: Create the component**

```svelte
<script lang="ts">
  import { onDestroy } from 'svelte';

  interface Props {
    /** Accessible label for the "?" trigger. */
    label: string;
    /** Card content. */
    children: import('svelte').Snippet;
  }
  let { label, children }: Props = $props();

  let open = $state(false);
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleOpen() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (open) return;
    openTimer = setTimeout(() => { open = true; openTimer = null; }, 300);
  }

  function scheduleClose() {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    closeTimer = setTimeout(() => { open = false; closeTimer = null; }, 150);
  }

  function toggle(e: Event) {
    e.stopPropagation();
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    open = !open;
  }

  function closeFromWindow() { open = false; }

  onDestroy(() => {
    if (openTimer) clearTimeout(openTimer);
    if (closeTimer) clearTimeout(closeTimer);
  });
</script>

<svelte:window onclick={closeFromWindow} />

<span class="help-wrap" onmouseenter={scheduleOpen} onmouseleave={scheduleClose}>
  <button
    type="button"
    class="help-trigger"
    aria-label={label}
    data-testid="help-trigger"
    onclick={toggle}
  >?</button>
  {#if open}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="help-card"
      role="tooltip"
      data-testid="help-card"
      onclick={(e) => e.stopPropagation()}
      onmouseenter={scheduleOpen}
      onmouseleave={scheduleClose}
    >
      {@render children()}
    </div>
  {/if}
</span>

<style>
  .help-wrap { position: relative; display: inline-flex; align-items: center; }
  .help-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    margin-left: 6px;
    border-radius: 50%;
    border: 1px solid var(--novelist-border);
    background: transparent;
    color: var(--novelist-text-secondary);
    font-size: 0.68rem;
    font-weight: 600;
    cursor: help;
  }
  .help-trigger:hover { border-color: var(--novelist-accent); color: var(--novelist-accent); }
  .help-card {
    position: absolute;
    top: 22px;
    left: -4px;
    z-index: 40;
    min-width: 280px;
    max-width: 360px;
    padding: 12px 14px;
    border-radius: 8px;
    background: var(--novelist-bg);
    border: 1px solid var(--novelist-border);
    box-shadow: 0 6px 20px rgba(0,0,0,0.12);
    color: var(--novelist-text);
    font-size: 0.78rem;
    line-height: 1.5;
  }
</style>
```

- [ ] **Step 2: Type-check**

```bash
pnpm check
```

Expected: no errors from this new file.

- [ ] **Step 3: Do NOT commit yet**

Commit with Task 14.

---

## Task 14: Add i18n keys + plug HelpTooltip into Settings.svelte + commit Phase 2/3

**Files:**
- Modify: `app/lib/i18n/locales/en.ts`
- Modify: `app/lib/i18n/locales/zh-CN.ts`
- Modify: `app/lib/components/Settings.svelte` (wire HelpTooltip into the info card at ~line 692)

- [ ] **Step 1: Add keys to `en.ts`**

In `app/lib/i18n/locales/en.ts`, find the existing `'settings.plugins.*'` block (around lines 234, 301-313). Add these keys (place them together for readability, alphabetical within the block):

```ts
  'settings.plugins.add': 'Add plugin',
  'settings.plugins.openFolder': 'Open plugins folder',
  'settings.plugins.createFromTemplate': 'Create from template…',

  'settings.plugins.scaffold.title': 'New plugin',
  'settings.plugins.scaffold.id': 'Plugin ID',
  'settings.plugins.scaffold.name': 'Display name (optional)',
  'settings.plugins.scaffold.invalidId': 'ID must be lowercase letters, digits, or hyphens, starting with a letter or digit',
  'settings.plugins.scaffold.idTaken': 'A plugin with this ID already exists',
  'settings.plugins.scaffold.create': 'Create',
  'settings.plugins.scaffold.cancel': 'Cancel',

  'settings.plugins.helpTitle': 'Creating plugins',
  'settings.plugins.helpIntro': 'Plugins live in:',
  'settings.plugins.helpNeeds': 'Each plugin needs:',
  'settings.plugins.helpManifest': 'manifest.toml — metadata & permissions',
  'settings.plugins.helpIndex': 'index.js — plugin code',
  'settings.plugins.helpLetClaude': 'Let Claude Code do it for you:',
  'settings.plugins.helpPrompt': 'Create a Novelist plugin that counts sentences.',
  'settings.plugins.copy': 'Copy',
  'settings.plugins.copied': 'Copied',
```

- [ ] **Step 2: Add matching keys to `zh-CN.ts`**

```ts
  'settings.plugins.add': '添加插件',
  'settings.plugins.openFolder': '打开插件目录',
  'settings.plugins.createFromTemplate': '从模板创建…',

  'settings.plugins.scaffold.title': '新建插件',
  'settings.plugins.scaffold.id': '插件 ID',
  'settings.plugins.scaffold.name': '显示名称（可选）',
  'settings.plugins.scaffold.invalidId': 'ID 只能包含小写字母、数字或连字符，必须以字母或数字开头',
  'settings.plugins.scaffold.idTaken': '已存在同 ID 的插件',
  'settings.plugins.scaffold.create': '创建',
  'settings.plugins.scaffold.cancel': '取消',

  'settings.plugins.helpTitle': '创建插件',
  'settings.plugins.helpIntro': '插件位于：',
  'settings.plugins.helpNeeds': '每个插件需要：',
  'settings.plugins.helpManifest': 'manifest.toml — 元数据和权限',
  'settings.plugins.helpIndex': 'index.js — 插件代码',
  'settings.plugins.helpLetClaude': '让 Claude Code 帮你做：',
  'settings.plugins.helpPrompt': '创建一个 Novelist 插件，用于统计句子数。',
  'settings.plugins.copy': '复制',
  'settings.plugins.copied': '已复制',
```

- [ ] **Step 3: Put HelpTooltip into the Plugins info card**

In `app/lib/components/Settings.svelte`, replace the info-card block at lines 692-698:

```svelte
<div class="rounded p-3 mt-3" style="background: var(--novelist-bg-secondary); border: 1px solid var(--novelist-border);">
  <div class="flex items-center">
    <p class="text-xs font-medium">{t('settings.plugins.createPlugin')}</p>
    <HelpTooltip label={t('settings.plugins.helpTitle')}>
      {#snippet children()}
        <div class="help-body">
          <p class="help-title">{t('settings.plugins.helpTitle')}</p>

          <p class="help-small">{t('settings.plugins.helpIntro')}</p>
          <pre class="help-code">~/.novelist/plugins/&lt;id&gt;/</pre>

          <p class="help-small">{t('settings.plugins.helpNeeds')}</p>
          <ul class="help-list">
            <li>{t('settings.plugins.helpManifest')}</li>
            <li>{t('settings.plugins.helpIndex')}</li>
          </ul>

          <p class="help-small">{t('settings.plugins.helpLetClaude')}</p>
          <div class="help-prompt">
            <code>{t('settings.plugins.helpPrompt')}</code>
            <button
              class="help-copy-btn"
              data-testid="help-copy-btn"
              onclick={(e) => copyPromptToClipboard(e)}
            >{copyBtnLabel}</button>
          </div>
        </div>
      {/snippet}
    </HelpTooltip>
  </div>
  <p class="text-xs" style="color: var(--novelist-text-secondary);">
    {t('settings.plugins.pluginPath')} <code style="background: var(--novelist-code-bg); padding: 1px 4px; border-radius: 3px;">~/.novelist/plugins/&lt;id&gt;/</code>
  </p>
  <p class="text-xs mt-1" style="color: var(--novelist-text-secondary);">{t('settings.plugins.aiSuggestion')}</p>
</div>
```

In `<script>` near the other state, add:

```ts
import HelpTooltip from '$lib/components/HelpTooltip.svelte';

let copyBtnLabel = $state(t('settings.plugins.copy'));
async function copyPromptToClipboard(e: MouseEvent) {
  e.stopPropagation();
  await navigator.clipboard.writeText(t('settings.plugins.helpPrompt'));
  copyBtnLabel = t('settings.plugins.copied');
  setTimeout(() => { copyBtnLabel = t('settings.plugins.copy'); }, 1500);
}
```

Append CSS for the help-card content:

```css
.help-body { max-width: 340px; }
.help-title { font-weight: 600; margin-bottom: 6px; }
.help-small {
  font-size: 0.72rem;
  color: var(--novelist-text-secondary);
  margin-top: 8px;
  margin-bottom: 2px;
}
.help-code {
  margin: 0;
  padding: 4px 6px;
  background: var(--novelist-code-bg, var(--novelist-bg-secondary));
  border-radius: 4px;
  font-size: 0.72rem;
  overflow-x: auto;
}
.help-list {
  margin: 4px 0 0 16px;
  padding: 0;
  list-style: disc;
}
.help-list li { font-size: 0.72rem; margin: 2px 0; }
.help-prompt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--novelist-code-bg, var(--novelist-bg-secondary));
  border-radius: 4px;
  font-size: 0.72rem;
}
.help-prompt code { flex: 1; font-family: inherit; }
.help-copy-btn {
  padding: 2px 8px;
  border: 1px solid var(--novelist-border);
  border-radius: 4px;
  background: transparent;
  color: var(--novelist-text);
  font-size: 0.7rem;
  cursor: pointer;
}
.help-copy-btn:hover { border-color: var(--novelist-accent); color: var(--novelist-accent); }
```

- [ ] **Step 4: Full type-check**

```bash
pnpm check
```

Expected: clean.

- [ ] **Step 5: Run unit tests**

```bash
pnpm test
```

Expected: green.

- [ ] **Step 6: Commit Phase 2 + Phase 3 together**

```bash
git add \
  app/lib/components/PluginScaffoldDialog.svelte \
  app/lib/components/HelpTooltip.svelte \
  app/lib/components/Settings.svelte \
  app/lib/i18n/locales/en.ts \
  app/lib/i18n/locales/zh-CN.ts \
  core/src/commands/plugin.rs \
  core/src/lib.rs \
  app/lib/ipc/commands.ts
git commit -m "feat(plugins): add + button, scaffold dialog, help tooltip in Settings"
```

(This commit includes the `get_plugins_dir` command added in Task 11 Step 2. If it was already committed separately, adjust the `git add`.)

---

## Task 15: Playwright E2E for plugin + button + help tooltip

**Files:**
- Modify: `tests/e2e/fixtures/tauri-mock.ts`
- Modify or create: `tests/e2e/specs/settings.spec.ts`

- [ ] **Step 1: Extend the mock**

In `tests/e2e/fixtures/tauri-mock.ts`:

(a) Just before the `function handleInvoke` line (inside the IIFE, alongside `writtenFiles`/`createdFiles`), add:

```js
      const scaffoldedPlugins = [];
```

(b) Replace the existing `case 'list_plugins': return [];` line with:

```js
          case 'list_plugins': return scaffoldedPlugins.slice();
```

(c) Add these new cases to the switch (next to the other plugin cases):

```js
          case 'scaffold_plugin': {
            const id = args.id;
            const name = args.displayName || id;
            const p = '/mock/home/.novelist/plugins/' + id;
            scaffoldedPlugins.push({
              id, name, version: '0.1.0', description: '', author: '',
              enabled: false, builtin: false, path: p, permissions: [],
            });
            return p;
          }
          case 'get_plugins_dir': return '/mock/home/.novelist/plugins';
```

- [ ] **Step 2: Write the test**

Add to `tests/e2e/specs/settings.spec.ts`:

```ts
test('plugins: "+" button scaffolds a new plugin', async ({ app }) => {
  // Open settings and navigate to Plugins tab.
  await app.getByTestId('sidebar-settings-btn').click();
  await app.getByRole('button', { name: /Plugins|插件/ }).click();

  // Open the add menu and click "Create from template".
  await app.getByTestId('plugin-add-btn').click();
  await app.getByTestId('plugin-add-menu').getByRole('button', { name: /Create from template/i }).click();

  // Fill the dialog.
  await app.getByTestId('plugin-scaffold-id').fill('hello-world');
  await app.getByTestId('plugin-scaffold-create').click();

  // The new plugin appears under Community.
  await expect(app.getByText('hello-world')).toBeVisible();
});

test('plugins: help tooltip copies prompt to clipboard', async ({ app, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await app.getByTestId('sidebar-settings-btn').click();
  await app.getByRole('button', { name: /Plugins|插件/ }).click();

  // Click the help "?" trigger (toggle path — more reliable than hover in Playwright).
  await app.getByTestId('help-trigger').click();
  await expect(app.getByTestId('help-card')).toBeVisible();

  // Click Copy.
  await app.getByTestId('help-copy-btn').click();

  // Verify clipboard contents.
  const clip = await app.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('counts sentences');
});
```

NOTE: `sidebar-settings-btn` is the testid assumed on the existing Settings button. If it's named differently in `App.svelte` (search for the settings button), use the actual testid.

- [ ] **Step 3: Run the E2E tests**

```bash
pnpm test:e2e:browser -- settings.spec.ts
```

Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/fixtures/tauri-mock.ts tests/e2e/specs/settings.spec.ts
git commit -m "test(e2e): plugin add button and help tooltip"
```

---

# Phase 4 — Scope the Language Picker to Settings > Editor

## Task 16: Move language `<select>` inside the Editor section

**Files:**
- Modify: `app/lib/components/Settings.svelte`

- [ ] **Step 1: Remove the language block from the outer div**

In `app/lib/components/Settings.svelte`, delete lines 363-376 (the `<div class="flex items-center justify-between mb-3">` containing the language label and select outside any activeSection branch).

- [ ] **Step 2: Add it inside the `activeSection === 'editor'` branch**

Immediately after `<h3>{t('settings.editor')}</h3>` (around line 379), insert a row using the existing translation key `t('settings.language')`:

```svelte
<div class="flex items-center justify-between mb-3">
  <label for="settings-language" class="text-sm">{t('settings.language')}</label>
  <select
    id="settings-language"
    class="text-sm px-2 py-1 rounded cursor-pointer"
    style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
    value={i18n.locale}
    onchange={(e) => i18n.setLocale((e.target as HTMLSelectElement).value as Locale)}
  >
    {#each i18n.availableLocales as loc}
      <option value={loc.code}>{loc.nativeName}</option>
    {/each}
  </select>
</div>
```

- [ ] **Step 3: Type-check**

```bash
pnpm check
```

Expected: clean.

- [ ] **Step 4: Add a Playwright test**

In `tests/e2e/specs/settings.spec.ts`:

```ts
test('language picker is only visible in the Editor tab', async ({ app }) => {
  await app.getByTestId('sidebar-settings-btn').click();

  // Editor is the default tab.
  await expect(app.locator('#settings-language')).toBeVisible();

  // Click Theme.
  await app.getByRole('button', { name: /Theme|主题/ }).click();
  await expect(app.locator('#settings-language')).toHaveCount(0);

  // Back to Editor.
  await app.getByRole('button', { name: /Editor|编辑器/ }).click();
  await expect(app.locator('#settings-language')).toBeVisible();
});
```

- [ ] **Step 5: Run the E2E test**

```bash
pnpm test:e2e:browser -- settings.spec.ts
```

Expected: the new test passes along with the others.

- [ ] **Step 6: Commit**

```bash
git add app/lib/components/Settings.svelte tests/e2e/specs/settings.spec.ts
git commit -m "feat(settings): scope language picker to Editor section"
```

---

# Final verification

## Task 17: Full test suite

- [ ] **Step 1: Run every test tier**

```bash
pnpm test && pnpm test:rust && pnpm test:e2e:browser
```

Expected: all three green.

- [ ] **Step 2: Smoke the app manually**

```bash
pnpm tauri dev
```

- Open a project with nested folders → expand / collapse subfolders.
- Drag a root file into a subfolder and watch it move.
- Drag the same file from inside the subfolder back onto the sidebar's empty tail → it returns to the root.
- Settings > Plugins → click "+" → "Create from template" → type `smoke-test` → Create → verify it appears in Community and Finder opens to the new folder.
- Hover the `?` on the Create-a-plugin card → click Copy → paste somewhere and verify the prompt string.
- Settings > Editor → Language picker visible. Switch to Theme → hidden. Back to Editor → visible.

- [ ] **Step 3: If all checks pass, push**

```bash
git push
```

---

# Spec-to-task traceability

| Spec section | Task(s) |
|---|---|
| §1 Data model (`FileNode`, `expandFolder`, `collapseFolder`, `refreshFolder`) | Task 3 |
| §1 File watcher integration | Task 6 |
| §1 Rendering (`FileTreeNode.svelte`) | Tasks 4, 5 |
| §1 Drag-and-drop (HTML5, root drop zone, descendant rejection, tab path update) | Task 5 |
| §1 Rust `move_item` | Tasks 1, 2 |
| §1 Tests (Rust + Vitest + Playwright) | Tasks 1 (Rust), 3 (Vitest), 7 (Playwright) |
| §2 `+` button placement + dropdown | Task 11 |
| §2 Open plugins folder action | Task 11 (+ `get_plugins_dir` Rust cmd) |
| §2 Create-from-template dialog + validation | Tasks 10, 11 |
| §2 Rust `scaffold_plugin` | Tasks 8, 9 |
| §2 Tests | Tasks 8 (Rust), 15 (Playwright) |
| §3 HelpTooltip component | Task 13 |
| §3 Card contents, Copy prompt | Task 14 |
| §3 i18n keys | Task 14 |
| §3 Playwright test | Task 15 |
| §4 Language picker scoped to Editor | Task 16 |

All spec requirements have an owning task.
