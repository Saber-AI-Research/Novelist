# Novelist - Technical Design Overview

> **Version**: 0.1.0 (MVP)
> **Date**: 2026-04-07
> **Status**: Draft

## 1. Product Positioning

Novelist is a lightweight, extensible, WYSIWYG Markdown writing tool for desktop.

**Core differentiation**: No existing product simultaneously satisfies "lightweight (<30MB) + plugin system + multi-project + plain Markdown + WYSIWYG". Novelist fills this gap.

**UI style**: Clean, minimal, distraction-free — aligned with MiaoYan / Typora aesthetics.

**Target platforms**: macOS (primary), Linux, Windows. No mobile.

## 2. Technology Stack

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **App Framework** | Tauri | v2 | System webview -> ~8-15MB binary. Rust backend. |
| **Frontend Framework** | Svelte | 5 (Runes) | Compiled, zero runtime. Modern reactivity model. |
| **Editor Engine** | CodeMirror | 6 | Virtual scrolling, decoration system for WYSIWYG, proven by Obsidian. |
| **CSS** | Tailwind CSS | 4 | Atomic CSS, small output, fast iteration. |
| **Build Tool** | Vite | 6+ | Svelte ecosystem standard, fast HMR. |
| **Export** | External (pandoc) | — | Not bundled. Users install pandoc separately; Novelist invokes CLI for export. |
| **Plugin Runtime** | rquickjs | latest | QuickJS Rust bindings. Sandboxed JS execution. |
| **Async Runtime** | tokio | 1.x | Async file I/O, background tasks. |
| **IPC Type Safety** | tauri-specta | latest | Auto-generate TS types from Rust commands. |
| **Language** | Rust + TypeScript | | Backend: Rust. Frontend: TypeScript. |

### 2.1 Why Tauri = Frontend-Backend Separation (and Why That's Good)

Tauri inherently adopts a frontend-backend separation architecture, but it is fundamentally different from web-style client-server separation:

```
Web separation:          Tauri separation:
Browser <--HTTP--> Server    WebView <--IPC--> Rust (same process)
(remote, ms latency)         (local, μs latency)
```

The IPC overhead in Tauri is **microsecond-level** — effectively the same as a function call. This means the Rust backend can be treated as a "local native library" rather than a remote service.

**Why this separation is correct for Novelist:**

| Concern | Frontend (WebView) | Backend (Rust) | Why split here? |
|---------|-------------------|---------------|-----------------|
| **Editing** | CodeMirror 6 owns all editor state | — | CM6 is the best web-based editor engine; no Rust equivalent exists |
| **File I/O** | — | All file reads/writes via tokio | Security (WebView has no fs access), performance (async Rust), atomic saves |
| **Markdown parse (edit)** | Lezer (CM6 built-in) for live syntax | — | Must be in-process with editor for real-time highlighting |
| **Export** | — | Invoke external pandoc CLI | CPU-intensive, must not block UI thread; not bundled to keep binary small |
| **Plugin execution** | — | QuickJS sandbox in Rust | Isolation from both UI and filesystem |
| **UI rendering** | Svelte 5 + CSS | — | Web technologies are superior for rich, themeable UI |

**Key insight**: The split is not "front-end vs back-end" in the web sense. It's "**UI thread vs compute/IO thread**". Everything that could block the UI or needs system access goes to Rust. Everything visual stays in the WebView.

## 3. Architecture Overview

```
+--------------------------------------------------------------+
|                        Tauri v2 Shell                        |
|                                                              |
|  +---------------------- WebView -------------------------+  |
|  |                                                        |  |
|  |  +----------+  +----------------+  +---------------+   |  |
|  |  | Sidebar  |  |  CodeMirror 6  |  |   Outline     |   |  |
|  |  | File Tree|  |  Editor Area   |  |   Panel       |   |  |
|  |  |          |  |  (WYSIWYG MD)  |  |               |   |  |
|  |  +----------+  +----------------+  +---------------+   |  |
|  |                                                        |  |
|  |  +--------------------------------------------------+  |  |
|  |  | Status Bar: word count | goal | cursor position  |  |  |
|  |  +--------------------------------------------------+  |  |
|  |                                                        |  |
|  |  Svelte 5 (UI Shell) + Tailwind CSS 4                  |  |
|  +------------------------+-------------------------------+  |
|                           | Tauri IPC Commands               |
|  +------------------------+-------------------------------+  |
|  |                    Rust Backend                        |  |
|  |                                                        |  |
|  |  +-----------+ +----------+ +------------------------+ |  |
|  |  | File I/O  | | Export   | | Plugin Host            | |  |
|  |  | (tokio)   | | (pandoc  | | (rquickjs sandbox)     | |  |
|  |  |           | |  CLI)    | |                        | |  |
|  |  +-----------+ +----------+ +------------------------+ |  |
|  |                                                        |  |
|  |  +-----------+                                         |  |
|  |  | Project   |                                         |  |
|  |  | Config    |                                         |  |
|  |  |(.novelist)|                                         |  |
|  |  +-----------+                                         |  |
|  +--------------------------------------------------------+  |
+--------------------------------------------------------------+
```

### 3.1 Layer Responsibilities

| Layer | Responsibility | Key Principle |
|-------|---------------|---------------|
| **UI Shell (Svelte 5)** | File tree, toolbar, sidebar, status bar, Zen Mode, settings | Thin shell — delegates to CodeMirror for editing, to Rust for I/O |
| **Editor (CodeMirror 6)** | Markdown WYSIWYG editing, syntax highlighting, virtual scrolling | Self-managed state. Svelte does NOT own editor state. |
| **IPC Layer** | Type-safe frontend-backend communication | All Rust commands defined with tauri-specta, auto-generating TS bindings |
| **Rust Backend** | File read/write, project config, export (invoke pandoc), plugin hosting | All file system access goes through Rust. Frontend never touches fs directly. |

### 3.2 Key Design Principles

1. **Editor independence**: CodeMirror 6 manages its own state (document, selections, history). Svelte only wraps it in a container and listens to state changes for UI updates (word count, outline, etc.).
2. **Rust-first I/O**: All file operations go through Tauri commands. This ensures consistent behavior across platforms, better performance for large files, and proper error handling.
3. **Type-safe IPC**: tauri-specta generates TypeScript types from Rust function signatures, eliminating serialization bugs at the boundary.
4. **Plugin isolation**: Plugins run in a QuickJS sandbox in the Rust backend, with explicit permission grants. They cannot access the file system or network unless authorized.

## 4. Project Data Model

```
~/my-novel/                       # User project directory
+-- .novelist/                    # Project metadata
|   +-- project.toml              # Name, type, sort order
|   +-- export.toml               # Export config: pandoc options, format preferences
|   +-- plugins.toml              # Plugin config & permissions
|   +-- workspace.json            # UI state: open tabs, sidebar width (not committed)
+-- chapters/
|   +-- 01-beginning.md
|   +-- 02-development.md
|   +-- 03-climax.md
+-- notes/
|   +-- characters.md
+-- references/
    +-- research.md
```

### 4.1 Design Decisions

- **"Open directory" model**: Like VSCode — open any directory, auto-detect `.novelist/` as a project. No `.novelist/` means it still works as a plain editor.
- **Plain .md files**: No proprietary syntax, no wikilinks, no custom frontmatter requirements. External tools (vim, AI, git) can freely edit files.
- **Config is separate from content**: `.novelist/` only contains metadata and settings. Content lives in user-organized directories.
- **workspace.json is ephemeral**: UI state (open tabs, scroll positions) is not version-controlled. Project config (project.toml, export.toml) can be committed to git.

### 4.2 Project Config Schema

```toml
# .novelist/project.toml
[project]
name = "My Novel"
type = "novel"                    # novel | paper | script | notes
version = "0.1.0"

[outline]
order = [                         # Manual sort order for file tree
  "chapters/01-beginning.md",
  "chapters/02-development.md",
  "chapters/03-climax.md",
]

[writing]
daily_goal = 2000                 # Word count goal per session
auto_save_minutes = 5             # Auto-save interval (0 = disabled)
```

```toml
# .novelist/export.toml
[general]
order = "outline"              # "outline" (from project.toml) or "alphabetical"

[html]
css = "default"                # "default" | path to custom CSS

[pdf]
engine = "auto"                # "auto" (detect) | "typst" | "xelatex" | "weasyprint"
font_body = "Noto Serif SC"
font_size = 12
margin = "2.5cm"
page_size = "A4"

[pandoc]
extra_args = []                # Advanced: extra CLI args passed to pandoc
```

## 5. Editor Design

### 5.1 WYSIWYG Strategy

Use CodeMirror 6's decoration system to achieve near-Typora WYSIWYG:

| Markdown Element | Rendering Approach |
|-----------------|-------------------|
| `# Heading` | Widget decoration: hide `#`, apply heading font size. Show `#` on cursor focus. |
| `**bold**` | Mark decoration: hide `**`, apply bold style. Show markers on cursor focus. |
| `*italic*` | Mark decoration: hide `*`, apply italic style. Show markers on cursor focus. |
| `` `code` `` | Mark decoration: inline code background. Show backticks on cursor focus. |
| `![alt](url)` | Widget decoration: render inline image preview. Show syntax on cursor focus. |
| `[link](url)` | Widget decoration: render clickable link text. Show full syntax on cursor focus. |
| `> blockquote` | Line decoration: left border + indent. Hide `>` until cursor focus. |
| Code blocks | Widget decoration: syntax-highlighted block with language label. |
| `- [ ] todo` | Widget decoration: render checkbox. Toggle on click. |
| Tables | Widget decoration: render as formatted table grid. |

**Core behavior**: Syntax markers are hidden when the cursor is NOT on that line/element, and revealed when the cursor enters. This gives a clean reading experience while maintaining full Markdown control.

### 5.1.1 WYSIWYG Edge Cases

> **Status**: Needs design. These are known hard problems for CM6 WYSIWYG.

#### Nested Syntax

Markdown allows arbitrary nesting: `***bold italic***`, code blocks inside lists, links inside headings, etc. The decoration system must handle:

- **Priority ordering**: When multiple decorations overlap (e.g., bold inside a heading), define explicit precedence. CM6's `Decoration.set()` supports ordering via `sort` parameter.
- **Composition rules**: Bold+italic = `font-weight: bold; font-style: italic`. These must compose, not override.
- **Block-in-block**: A code block inside a blockquote inside a list. Widget decorations must nest correctly — this is the hardest case. Strategy: treat the outermost block as the container decoration, inner blocks as nested widgets.

#### Cursor Transition Animations

When the cursor enters/exits a decorated region, Typora smoothly expands/collapses syntax markers. CM6 default behavior causes layout jumps because showing/hiding characters changes line width.

Mitigation strategies:
1. **CSS transitions on opacity + max-width**: Fade markers in/out rather than insert/remove them. Keep markers in the DOM always, toggle visibility.
2. **Reserve space**: Use `letter-spacing` or invisible placeholders to hold marker width even when hidden, eliminating layout shift.
3. **Debounced reveal**: Don't reveal markers on every cursor move. Only reveal after cursor rests in a region for ~150ms. Prevents flickering during navigation.

#### IME (Chinese Input Method) Compatibility

CM6 has known issues with IME composition events, particularly with WYSIWYG decorations:

- **Problem**: During IME composition (e.g., typing pinyin), CM6 may prematurely apply decorations to uncommitted text, causing visual glitches or composition interruption.
- **Solution**: Detect `compositionstart` / `compositionend` events. During composition, freeze decoration updates for the active line. Resume after `compositionend`.
- **Testing**: Must test with macOS native input, fcitx5 (Linux), and Microsoft IME (Windows). This is a Day 1 requirement for CJK users.
- **Reference**: Obsidian has dealt with this extensively — their CM6 fork patches are worth studying.

### 5.2 Editor State Bridge

```
CodeMirror 6 State                    Svelte UI
+------------------+                  +------------------+
| Document         |---onChange------->| Word Count       |
| Selection        |---onChange------->| Cursor Position  |
| Syntax Tree      |---onParse------->| Outline Panel    |
+------------------+                  +------------------+
        |
        | onSave (5-min auto / Cmd+S)
        v
  Tauri IPC -> Rust fs::write
```

- CodeMirror dispatches state updates
- Svelte subscribes to relevant changes via CM6 ViewPlugin or StateField
- File auto-saves every 5 minutes (configurable) and go through Rust backend. Manual save via `Cmd+S` at any time.
- Outline panel is derived from the CM6 syntax tree (heading nodes)

### 5.3 File Watching & External Edit Conflict Resolution

> **Critical for Feature #4**: External tool compatibility (vim, Claude Code, etc.)

#### Data Flow

```
User types in Novelist
  -> CM6 state update -> auto-save (5 min interval) or Cmd+S
     -> IPC write_file -> Rust: register ignore token -> tokio::fs::write
                                                                |
External edit (vim/AI)                                          |
  -> notify::Event::Modify -> check ignore list                 |
     |                                                          |
     +-- Path in ignore list --> skip (self-triggered save)     |
     |                                                          |
     +-- Not ignored --> Rust reads new content                 |
        -> compare with last-known hash                         |
           |                                                    |
           +-- No conflict (file clean in editor) --> auto-reload CM6 doc
           |
           +-- Conflict (file dirty in editor) --> prompt user
                 |
                 +-- "Keep mine" --> overwrite file with editor content
                 +-- "Load theirs" --> replace editor content with file
                 +-- "Diff view" --> show side-by-side (post-MVP)
```

#### Implementation Details

1. **File fingerprint**: Rust backend keeps a `(path, mtime, blake3_hash)` tuple for each open file. On `notify` event, compare hash to detect real content changes (not just mtime touch).
2. **Dirty flag**: Frontend tracks whether the editor has unsaved changes. If clean, external changes auto-reload silently. If dirty, prompt.
3. **Debounce notify events**: File watchers can fire multiple events per save (write + chmod + rename for atomic saves). Debounce 100ms before reacting.
4. **Atomic saves**: Novelist's own saves use write-to-temp-then-rename pattern to prevent data loss on crash.
5. **Self-trigger suppression**: Before each save, Rust registers an ignore token `(path, timestamp)` in a short-lived set. When the watcher fires, check if the path has an active ignore token (within a 2s window). If so, skip the event and remove the token. This prevents Novelist from reacting to its own writes. Simple and sufficient given the 5-minute auto-save interval.
6. **Auto-save interval**: Default 5 minutes, configurable in `project.toml` (`auto_save_minutes = 5`). Manual save via `Cmd+S` always available. The long interval reduces self-trigger noise and avoids excessive disk writes.
7. **Git-friendly**: When user runs `git checkout` or `git stash pop`, many files change at once. Batch-reload all affected open tabs, don't show N individual prompts.

### 5.4 Large File Strategy

> **Design goal**: Keep frontend memory proportional to the viewport, not the file size. Use Rust as the single source of truth for large files.

#### Tiered approach

| Tier | File size | Strategy | Frontend memory |
|------|-----------|----------|----------------|
| **Normal** | < 1 MB | Rust reads entire file → send to CM6 via IPC. CM6 owns full document. Standard WYSIWYG. | ~2-4× file size |
| **Tall doc** | < 1 MB, > 5000 lines | Same as Normal but **disable WYSIWYG decorations** and use flat heading sizes. Prevents CM6 height-map drift that causes click-after-scroll jump bugs. | ~2-4× file size |
| **Large** | 1-10 MB | Rust reads entire file → send to CM6, but **disable WYSIWYG decorations** (plain Markdown highlighting only). CM6 virtual scrolling handles rendering. | ~2-4× file size, but much lower CPU/GC pressure |
| **Huge** | > 10 MB | **Rust-backed viewport mode** (see below). CM6 only holds a window of content. | ~5-10 MB constant |

**Why tall doc mode exists**: CM6 estimates heights for off-screen lines. WYSIWYG decorations (heading font-size changes, blockquote styling, etc.) only apply within the viewport. The difference between estimated and actual heights accumulates as the user scrolls, causing `posAtCoords` (click → document position) to land on the wrong line. For documents > 5000 lines, this drift becomes user-visible. The fix: disable all height-changing decorations and use uniform heading font sizes via `flatNovelistHighlightStyle` in `src/lib/editor/setup.ts`.

#### Huge file: Rust-backed viewport mode

This is the key differentiator from editors like VSCode that load entire files into the JS heap.

```
Rust Backend (source of truth)              Frontend (viewport only)
+----------------------------------+        +-------------------------+
| ropey::Rope (entire document)    |        | CM6 EditorView          |
| - O(log n) random access by line |  IPC   | - holds ~2000 lines     |
| - O(log n) edits                 |<------>| - virtual scrolling     |
| - line count, byte offsets       |        | - plain MD highlighting |
+----------------------------------+        +-------------------------+
```

**How it works:**

1. **Open**: Rust reads file into a `ropey::Rope`. Sends metadata to frontend: `{ totalLines, totalBytes, fileId }`. Frontend creates a **virtual document** — CM6 is initialized with placeholder content for the viewport area only.

2. **Viewport loading**: Frontend requests content by line range: `get_lines(fileId, startLine, endLine)`. Rust slices the rope (O(log n)) and returns the text. CM6 replaces its document content with the received window. A **buffer zone** of ±500 lines around the viewport is pre-fetched to make scrolling smooth.

3. **Scrolling**: As the user scrolls, frontend detects when the viewport approaches the buffer boundary and requests the next window from Rust. Old out-of-view content is replaced with lightweight placeholders (preserving line count for correct scroll position).

4. **Editing**: Edits are applied to the CM6 local document AND dispatched to the Rust rope via IPC. The rope is the canonical state. Saves write from the rope, not from CM6.

5. **Search**: In-file search for huge files is delegated to Rust (`ropey` supports efficient text search). Results are returned as line numbers; frontend navigates by loading the target viewport.

6. **WYSIWYG disabled**: Huge files always use plain Markdown highlighting. WYSIWYG decorations are too expensive for windowed mode where content shifts frequently.

#### Memory budget

| Scenario | Rust process | WebView (JS heap) | Total |
|----------|-------------|-------------------|-------|
| Idle, no file open | ~20 MB | ~30 MB | ~50 MB |
| 3 normal files (50KB each) | ~21 MB | ~32 MB | ~53 MB |
| 1 large file (5 MB) | ~26 MB | ~50 MB | ~76 MB |
| 1 huge file (50 MB) | ~70 MB | ~35 MB | ~105 MB |

Key: for huge files, the JS heap stays constant (~35 MB) regardless of file size, because only the viewport window is loaded.

#### Rust dependency for large files

```toml
ropey = "1"  # Rope data structure for large text, O(log n) access/edit
```

> **Why ropey**: Unlike `String`, a rope doesn't require contiguous memory. A 50 MB file in a `String` needs a single 50 MB allocation; in a rope, it's distributed across small chunks. This prevents OOM and reduces GC pressure on the allocator. Edits are also O(log n) vs O(n) for `String`.

## 6. Plugin System

### 6.1 Architecture

```
+----------------------------------------------------------+
|                      Rust Backend                        |
|                                                          |
|  +------------------+    +---------------------------+   |
|  | Plugin Manager   |    | QuickJS Sandbox           |   |
|  | - load/unload    |    | (one instance per plugin) |   |
|  | - permissions    |--->| - novelist API injected    |   |
|  | - lifecycle      |    | - no direct fs/net access  |   |
|  +------------------+    +---------------------------+   |
|           |                          |                    |
|           v                          v                    |
|  +------------------+    +---------------------------+   |
|  | Plugin Registry  |    | Host Functions             |   |
|  | (plugins.toml)   |    | - read/write file (gated)  |   |
|  |                  |    | - register command          |   |
|  +------------------+    | - register export preset    |   |
|                          +---------------------------+   |
+----------------------------------------------------------+
```

### 6.2 Plugin Permission Tiers

| Tier | Capabilities | Examples |
|------|-------------|----------|
| **Tier 1: Read-only** | Read document content, register themes (CSS variable overrides only) | Themes, word frequency analyzer, reading stats |
| **Tier 2: Read-write** | Modify document content, register commands in command palette | Auto-formatter, template inserter, text transform |
| **Tier 3: System** | File system access (scoped), network access, register export presets | Cloud sync, AI integration, custom pandoc presets |

Plugins must declare required permissions in a manifest. User approves on install.

> **MVP limitation — no editor decorations**: Plugin-driven decorations (custom highlighting, inline widgets) require a complex cross-boundary pipeline (QuickJS → Rust → IPC → CM6 Decoration API) with serialization, latency, and lifecycle challenges. This is deferred to post-MVP. MVP plugins can read/write document text and register commands, but cannot inject visual decorations into the editor.

### 6.3 Plugin API (MVP Scope)

```typescript
// novelist-plugin.d.ts — injected into QuickJS sandbox
interface NovelistPlugin {
  id: string;
  name: string;
  version: string;
  permissions: ("read" | "write" | "fs" | "net")[];

  activate(ctx: PluginContext): void;
  deactivate(): void;
}

interface PluginContext {
  // Document access (Tier 1+)
  getDocument(): string;
  getSelection(): { from: number; to: number };
  getWordCount(): number;

  // Document modification (Tier 2+)
  replaceSelection(text: string): void;
  replaceRange(from: number, to: number, text: string): void;

  // Commands (Tier 1+)
  registerCommand(id: string, label: string, handler: () => void): void;

  // Events (Tier 1+)
  on(event: "document-change" | "save" | "open", handler: EventHandler): Disposable;

  // File system (Tier 3 only)
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}
```

### 6.4 Plugin Distribution

MVP uses local plugins only:

```
~/.novelist/plugins/
+-- my-theme/
|   +-- manifest.toml
|   +-- index.js
+-- word-counter/
    +-- manifest.toml
    +-- index.js
```

Future: plugin marketplace (post-MVP).

## 7. Export System

Export is **not bundled** into the Novelist binary to keep the app lightweight (<15 MB). Instead, Novelist delegates to the user's locally installed [pandoc](https://pandoc.org/) CLI.

### 7.1 Architecture

```
User clicks "Export"
  -> Rust backend checks pandoc availability (which pandoc)
     |
     +-- Not found --> prompt user to install pandoc
     |
     +-- Found --> assemble file list (outline order)
                   -> concatenate .md files to temp file
                   -> invoke: pandoc temp.md -o output.pdf/html [options]
                   -> report success / stream stderr on failure
```

### 7.2 Supported Formats

Pandoc supports a wide range of output formats. Novelist exposes a curated subset in the UI:

| Format | pandoc command | Notes |
|--------|---------------|-------|
| **HTML** | `pandoc -t html5 --standalone --css=theme.css` | Novelist provides a default CSS; users can customize |
| **PDF** | `pandoc -t pdf` (via LaTeX or `--pdf-engine=typst`) | Requires LaTeX or typst installed; Novelist detects available engines |
| **DOCX** | `pandoc -t docx` | Built-in to pandoc, no extra deps |
| **EPUB** | `pandoc -t epub` | Built-in to pandoc, no extra deps |

### 7.3 Export Config

Export is project-level (defined in `.novelist/export.toml`):

```toml
# .novelist/export.toml
[general]
order = "outline"              # "outline" (from project.toml) or "alphabetical"

[html]
css = "default"                # "default" | path to custom CSS

[pdf]
engine = "auto"                # "auto" (detect) | "typst" | "xelatex" | "weasyprint"
font_body = "Noto Serif SC"
font_size = 12
margin = "2.5cm"
page_size = "A4"

[pandoc]
extra_args = []                # Advanced: extra CLI args passed to pandoc
```

### 7.4 Implementation Details

1. **Pandoc detection**: On app start, run `which pandoc` and cache the result. Show a non-intrusive banner if not found.
2. **Async execution**: Invoke pandoc via `tokio::process::Command`. Stream stdout/stderr back to frontend via Tauri events for progress feedback.
3. **Temp file cleanup**: Concatenated temp files are cleaned up after export completes or fails.
4. **Extensibility**: Plugins (Tier 3) can register custom export presets (pre-configured pandoc argument sets), but cannot replace the pandoc-based pipeline itself.

## 8. Theme System

### 8.1 CSS Variable Architecture

Novelist exposes a structured set of CSS custom properties that themes can override:

```css
:root {
  /* Base colors */
  --novelist-bg: #ffffff;
  --novelist-bg-secondary: #f5f5f5;
  --novelist-text: #333333;
  --novelist-text-secondary: #666666;
  --novelist-accent: #4a90d9;
  --novelist-border: #e0e0e0;

  /* Editor-specific */
  --novelist-editor-bg: var(--novelist-bg);
  --novelist-editor-font: "Noto Serif SC", Georgia, serif;
  --novelist-editor-font-size: 16px;
  --novelist-editor-line-height: 1.8;
  --novelist-editor-max-width: 720px;

  /* Syntax elements */
  --novelist-heading-color: var(--novelist-text);
  --novelist-link-color: var(--novelist-accent);
  --novelist-code-bg: #f0f0f0;
  --novelist-blockquote-border: var(--novelist-accent);

  /* Sidebar */
  --novelist-sidebar-bg: var(--novelist-bg-secondary);
  --novelist-sidebar-text: var(--novelist-text);

  /* Zen Mode overrides */
  --novelist-zen-bg: #1a1a2e;
  --novelist-zen-text: #e0e0e0;
  --novelist-zen-dim-opacity: 0.3;
}
```

### 8.2 Theme Plugin Interface

Tier 1 plugins can register themes by providing a CSS file and metadata:

```toml
# manifest.toml for a theme plugin
[plugin]
id = "theme-solarized-dark"
name = "Solarized Dark"
version = "1.0.0"
type = "theme"
permissions = ["read"]

[theme]
css = "theme.css"
preview_colors = { bg = "#002b36", text = "#839496", accent = "#268bd2" }
```

The theme CSS simply overrides the `--novelist-*` variables. No arbitrary CSS injection — only variable overrides are allowed via theme plugins.

### 8.3 Dark Mode

- Follows OS dark mode preference by default (`prefers-color-scheme` media query)
- User can override to force light/dark in settings
- Themes provide both light and dark variants, or declare themselves as single-mode
- Zen Mode has its own independent color scheme (can be different from the main editor theme)

## 9. Tab & Multi-File Editing

### 9.1 Tab Bar

```
+--[chapter-01.md]--[characters.md]--[x]--+-----+
|                                          |  +  |
```

- **Behavior**: Click to switch, middle-click or `x` to close, drag to reorder
- **Persistence**: Open tabs saved in `.novelist/workspace.json`, restored on project open
- **Dirty indicator**: Unsaved files show a dot (`●`) on the tab
- **Tab overflow**: When too many tabs, show left/right scroll arrows + dropdown list
- **Keyboard**: `Cmd+W` close, `Cmd+Shift+T` reopen closed, `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle

### 9.2 Split View

- **Horizontal split**: `Cmd+\` to split editor into two panes side by side
- **Independent editing**: Each pane has its own tab bar and can open different files
- **Same-file split**: Can open the same file in both panes (e.g., reference chapter beginning while editing the end), following the VSCode model:
  - **Shared**: Document content (`Text`). An edit in one view is immediately reflected in the other.
  - **Independent per view**: Selection, cursor position, scroll position, undo/redo history, WYSIWYG decoration state (cursor-reveal logic per view).
  - **Implementation**: Each view creates its own `EditorState` and `EditorView`. Document sync is achieved by listening to transactions in one view and dispatching the content-change portion (excluding selection/cursor) to the other view. This avoids the pitfalls of sharing a single `EditorState` across two views.
- **MVP scope**: Support exactly 2 panes (left/right split). More complex layouts post-MVP.

### 9.3 State Management

```typescript
// stores/tabs.ts
interface TabState {
  id: string;
  filePath: string;
  isDirty: boolean;
  scrollPosition: number;    // Restore scroll on tab switch
  cursorPosition: number;    // Restore cursor on tab switch
}

interface PaneState {
  tabs: TabState[];
  activeTabId: string;
}

// workspace supports 1 or 2 panes
interface WorkspaceState {
  panes: PaneState[];       // length 1 or 2
  activePaneIndex: number;
  splitDirection: "horizontal" | null;
}
```

## 10. Search

### 10.1 In-File Search (MVP)

- **Built-in CM6 extension**: `@codemirror/search` provides Find/Replace with zero custom code needed
- **Keybinding**: `Cmd+F` find, `Cmd+H` replace, `Cmd+G` next match, `Cmd+Shift+G` previous
- **Features**: Case-sensitive toggle, regex toggle, whole-word toggle, replace all
- **CJK-aware**: Search works correctly with CJK characters (CM6 handles this natively)

### 10.2 Project-Wide Search (Post-MVP)

- **Rust backend**: Use `grep`/`ripgrep` bindings or manual `walkdir` + string search in Rust for speed
- **UI**: Dedicated search panel (like VSCode's `Cmd+Shift+F`)
- **Results**: Grouped by file, clickable to navigate to match location
- **Performance target**: < 500ms for full-text search across a 1000-file project

## 11. Multi-Project Management

### 11.1 MVP: Recent Projects & Quick Switch

Even in MVP, multi-project workflows are critical for the target user. Minimum viable multi-project:

#### Recent Projects List

```
+------------------------------------------+
|  Novelist                                |
|                                          |
|  Recent Projects:                        |
|                                          |
|  📁 My Novel          ~/writing/novel    |
|  📁 Research Paper     ~/papers/2026     |
|  📁 Course Slides     ~/teaching/cs101   |
|                                          |
|  [Open Directory...]  [New Project]      |
+------------------------------------------+
```

- Shown on app start when no project is open (Welcome screen)
- Stored in `~/.novelist/recent-projects.json`
- Maximum 20 entries, sorted by last-opened time

#### Quick Switch

- **Keybinding**: `Cmd+Shift+P` then type project name (reuses command palette)
- **Behavior**: Saves current workspace state, opens selected project in the same window
- **Fast**: Project switch should feel instant — load file tree first, lazy-load file contents

### 11.2 Post-MVP: Multi-Window

- Each project opens in its own native window
- Window management handled by Tauri's multi-window API
- Cross-project search and cross-project file linking

## 12. Writing Features (MVP)

### 12.1 Zen Mode

| Feature | Behavior |
|---------|----------|
| **Full-screen immersion** | Hide all UI (sidebar, toolbar, status bar). Only text + cursor remain. |
| **Typewriter mode** | Active line stays vertically centered. Text scrolls up as you type. |
| **Paragraph focus** | Current paragraph at full opacity, surrounding paragraphs dimmed (configurable opacity 0.1-0.5). |
| **Entry/exit** | Toggle via `F11` or `Cmd+Shift+Z`. Smooth CSS transition. |
| **Minimal HUD** | Optional floating word count in bottom-right corner (fade after 3s inactivity). |

### 12.2 Word Count & Goals

- **Real-time word count**: Derived from CodeMirror document state. Displayed in status bar.
- **Session goal**: Configurable in `project.toml` (`daily_goal = 2000`). Progress bar in status bar.
- **Per-file stats**: Word count per file visible in file tree tooltip.
- **CJK-aware counting**: Proper Chinese/Japanese character counting (1 character = 1 word for CJK).

### 12.3 Outline View

- **Source**: Parsed from CodeMirror 6 syntax tree (heading nodes H1-H6).
- **Display**: Collapsible tree in right sidebar panel.
- **Navigation**: Click heading to scroll editor to that position.
- **Live update**: Re-derives on every document change (debounced 300ms).
- **Drag-to-reorder**: Future feature (post-MVP). MVP is read-only navigation.

## 13. Application Layout

```
+-------+----------------------------------------+--------+
| Side  |              Editor Area               | Right  |
| bar   |                                        | Panel  |
|       |                                        |        |
| [File]|  # Chapter One                         |[Outline|
| [Tree]|                                        | - H1   |
|       |  The story begins on a quiet morning.  | - H2   |
|  ...  |  The wind carried whispers through...   | - H3   |
|       |                                        |  ...   |
|       |                                        |        |
|       |                                        |        |
+-------+----------------------------------------+--------+
| Status: 1,234 words | Goal: 60% | Ln 42, Col 8         |
+--------------------------------------------------------------+
```

- **Sidebar (left)**: File tree with project files. Collapsible (`Cmd+B`).
- **Editor (center)**: CodeMirror 6 with WYSIWYG Markdown. Main workspace.
- **Right panel**: Outline view. Collapsible (`Cmd+Shift+O`).
- **Status bar (bottom)**: Word count, writing goal progress, cursor position.
- **All panels resizable** via drag handles.

## 14. Frontend Module Structure

```
src/
+-- lib/
|   +-- components/
|   |   +-- Sidebar.svelte            # File tree component
|   |   +-- Editor.svelte             # CodeMirror 6 wrapper
|   |   +-- TabBar.svelte             # Tab bar for open files
|   |   +-- SplitPane.svelte          # Split view container
|   |   +-- Outline.svelte            # Outline panel
|   |   +-- StatusBar.svelte          # Bottom status bar
|   |   +-- ZenMode.svelte            # Zen mode overlay
|   |   +-- CommandPalette.svelte     # Cmd+Shift+P command palette
|   |   +-- Welcome.svelte            # Welcome screen with recent projects
|   +-- editor/
|   |   +-- setup.ts                  # CM6 extensions & config
|   |   +-- wysiwyg.ts               # WYSIWYG decoration plugins
|   |   +-- wysiwyg-transitions.ts   # Cursor enter/exit animation handling
|   |   +-- ime-guard.ts             # IME composition event handling
|   |   +-- markdown.ts              # Markdown language support
|   |   +-- zen.ts                   # Typewriter & focus extensions
|   |   +-- outline.ts              # Heading extraction from syntax tree
|   +-- stores/
|   |   +-- project.ts               # Project state (files, config)
|   |   +-- tabs.ts                  # Tab & pane state management
|   |   +-- ui.ts                    # UI state (panels, zen mode, theme)
|   |   +-- writing.ts              # Writing stats (word count, goal)
|   |   +-- recent-projects.ts      # Recent projects list
|   +-- ipc/
|   |   +-- commands.ts              # Auto-generated by tauri-specta
|   |   +-- events.ts               # Tauri event listeners
|   +-- themes/
|   |   +-- variables.css            # CSS variable definitions
|   |   +-- light.css                # Default light theme
|   |   +-- dark.css                 # Default dark theme
|   +-- utils/
|       +-- wordcount.ts             # CJK-aware word counting
|       +-- keybindings.ts           # Keyboard shortcut definitions
+-- App.svelte                        # Root layout
+-- main.ts                           # Entry point
+-- app.css                           # Tailwind CSS entry + theme imports
```

## 15. Rust Backend Module Structure

```
src-tauri/
+-- src/
|   +-- main.rs                       # Tauri app entry
|   +-- lib.rs                        # Module declarations
|   +-- commands/
|   |   +-- mod.rs
|   |   +-- file.rs                   # File read/write/watch commands
|   |   +-- project.rs               # Project config CRUD
|   |   +-- export.rs                # Export commands (invoke external pandoc)
|   |   +-- plugin.rs               # Plugin load/unload/invoke
|   |   +-- recent.rs               # Recent projects list management
|   +-- services/
|   |   +-- mod.rs
|   |   +-- file_watcher.rs          # File system watcher (notify crate)
|   |   +-- conflict.rs              # External edit conflict detection & resolution
|   |   +-- rope_document.rs        # ropey::Rope wrapper for large file viewport mode
|   |   +-- pandoc.rs               # Pandoc CLI detection, invocation, output streaming
|   |   +-- plugin_host/
|   |       +-- mod.rs
|   |       +-- sandbox.rs           # QuickJS sandbox setup
|   |       +-- api.rs               # Host functions exposed to plugins
|   |       +-- permissions.rs       # Permission checking
|   +-- models/
|   |   +-- mod.rs
|   |   +-- project.rs               # Project config structs (serde)
|   |   +-- plugin.rs               # Plugin manifest structs
|   |   +-- file_state.rs           # File fingerprint (mtime, hash) for conflict detection
|   +-- error.rs                     # Error types
+-- Cargo.toml
+-- tauri.conf.json                   # Tauri configuration
+-- capabilities/                     # Tauri v2 capability files
```

## 16. Key Rust Dependencies

```toml
[dependencies]
tauri = { version = "2", features = ["protocol-asset"] }
tauri-specta = "2"                    # TS type generation from Rust
serde = { version = "1", features = ["derive"] }
serde_json = "1"
toml = "0.8"                         # Project config parsing
tokio = { version = "1", features = ["full"] }
rquickjs = { version = "0.8", features = ["bindgen"] }  # Plugin sandbox
notify = "7"                         # File system watcher
blake3 = "1"                         # Fast file content hashing (conflict detection)
ropey = "1"                          # Rope data structure for large file viewport mode
thiserror = "2"                      # Error handling
tracing = "0.1"                      # Structured logging
```

> **Note on export**: Export is handled by invoking the user's locally installed `pandoc` CLI via `tokio::process::Command`. No Markdown parsing or typesetting crates are bundled in the Rust backend, keeping the binary small (~8-12 MB).

## 17. Cross-Platform Considerations

| Aspect | macOS (Primary) | Linux | Windows |
|--------|----------------|-------|---------|
| **WebView** | WKWebView | WebKitGTK | WebView2 (Chromium) |
| **Window chrome** | Native title bar with traffic lights | GTK header bar | Standard title bar |
| **Font rendering** | Core Text | FreeType/Fontconfig | DirectWrite |
| **Keyboard shortcuts** | Cmd-based | Ctrl-based | Ctrl-based |
| **File paths** | POSIX | POSIX | UNC/backslash (handled by Rust std) |
| **CI** | macOS runner | Ubuntu runner | Windows runner |

**Strategy**: Develop primarily on macOS. Use GitHub Actions matrix for three-platform CI builds. WebView CSS differences tested via CI screenshots (post-MVP).

## 18. MVP Feature Scope

### In Scope

- [x] Tauri v2 app shell with Svelte 5 frontend
- [x] CodeMirror 6 editor with WYSIWYG Markdown decorations
- [x] File tree sidebar (open directory, browse files)
- [x] Outline panel (heading navigation)
- [x] Status bar with word count, cursor position, writing goal
- [x] Zen Mode (full-screen, typewriter, paragraph focus)
- [x] Project config (`.novelist/project.toml`)
- [x] Export via external pandoc (HTML, PDF, DOCX, EPUB)
- [x] Basic plugin system (QuickJS sandbox, Tier 1-2 plugins)
- [x] Keyboard shortcuts & command palette
- [x] Auto-save (5-min interval + manual Cmd+S)
- [x] File watching (detect external changes, conflict resolution)
- [x] In-file Find/Replace (CM6 built-in `@codemirror/search`)
- [x] Tab bar & multi-file editing (open/close/switch tabs)
- [x] Split view (2-pane horizontal split)
- [x] Theme system (CSS variable architecture, dark mode)
- [x] Recent projects list & quick project switch (`Cmd+Shift+P`)
- [x] Welcome screen with recent projects

### Out of Scope (Post-MVP)

- [ ] Multi-window multi-project management
- [ ] Plugin marketplace / remote install
- [ ] Plugin editor decorations (cross-IPC decoration pipeline)
- [ ] Cloud sync
- [ ] Version history / snapshots
- [ ] Built-in export engine (without external pandoc dependency)
- [ ] Collaborative editing
- [ ] Mobile platforms
- [ ] Drag-to-reorder in outline
- [ ] Project-wide search & replace
- [ ] Git integration
- [ ] Complex split layouts (3+ panes, grid)

## 19. Performance Targets

| Metric | Target |
|--------|--------|
| **App binary size** | < 15MB (macOS .dmg) |
| **Cold start** | < 1s to editor ready |
| **File open (< 1MB .md)** | < 200ms (full load to CM6) |
| **File open (1-10MB .md)** | < 500ms (full load, WYSIWYG disabled) |
| **File open (> 10MB .md)** | < 300ms (viewport mode, only load visible window) |
| **Typing latency** | < 16ms (60fps) |
| **Memory (idle)** | < 50MB |
| **Memory (normal files)** | < 80MB (3-5 files under 1MB each) |
| **Memory (huge file 50MB)** | < 120MB (Rust rope ~70MB + JS viewport ~35MB) |
| **Auto-save** | < 50ms per file write; 5-min default interval |
