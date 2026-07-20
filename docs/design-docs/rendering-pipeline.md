# Novelist - Rendering Pipeline

> **Date**: 2025-07-14
> **Status**: Reference

This document describes the full rendering pipeline of Novelist, from application boot to pixel output.

## 1. Application Boot

```
index.html → main.ts → i18n.init() → mount(App.svelte, #app)
```

`main.ts` initializes the i18n system, then mounts the root Svelte 5 component into the DOM.

## 2. Root Layout Routing (App.svelte)

App.svelte acts as the top-level router based on application state:

```
projectStore.isOpen?
├── false ──→ <Welcome />  (open directory / recent projects / new file)
├── true + zenMode ──→ <ZenMode> + <Editor pane-1 />
└── true ──→ Main Layout ↓
```

## 3. Main Layout Structure

```
┌──────────┐  ┌─────────────────────────────┐  ┌────────────────────────┐
│ Sidebar  │  │      Editor Region          │  │   Right Panels         │
│          │  │  ┌─────────┐  ┌───────────┐ │  │  ┌──────────────────┐  │
│ File tree│  │  │ TabBar  │  │ TabBar    │ │  │  │ Outline          │  │
│ Resize-  │  │  │ pane-1  │  │ pane-2    │ │  │  │ DraftNote        │  │
│ able     │  │  ├─────────┤  ├───────────┤ │  │  │ SnapshotPanel    │  │
│          │  │  │ Editor  │  │ Editor    │ │  │  │ StatsPanel       │  │
│          │  │  │ pane-1  │◄─┤ pane-2    │ │  │  │ PluginPanel      │  │
│          │  │  │         │ ↕│ (split)   │ │  │  └──────────────────┘  │
│          │  │  └─────────┘  └───────────┘ │  │  Vertical Toggle Tabs  │
│          │  │  ┌─────────────────────────┐ │  └────────────────────────┘
│          │  │  │ StatusBar (words/ln/col)│ │
└──────────┘  │  └─────────────────────────┘ │
              └─────────────────────────────┘
+ Overlays: CommandPalette / ExportDialog / Settings / ProjectSearch / etc.
```

Key layout behaviors:
- **Sidebar** and **Right Panel** widths are user-draggable (persisted to localStorage)
- **Split panes** share a draggable divider; each pane has independent tab state
- **StatusBar** reflects the active pane's word count, cursor line, and column

## 4. Editor.svelte — Tab Lifecycle & CM6 Initialization

When the active tab or zen mode changes, `$effect` triggers `loadTab()`:

```
loadTab()
 ├─ 1. setWysiwygProjectDir(projectDir)     // image path resolution
 ├─ 2. cleanupCurrentView()                 // destroy old EditorView
 │     ├─ saveEditorState(tabId, state)     // preserve undo history
 │     ├─ syncFromView(tabId)               // sync content to store
 │     └─ unregisterEditorView(tabId)       // remove from registry
 ├─ 3. Compute file size & line count → determine file tier
 ├─ 4. buildExtensions(fileSize, lineCount) // build CM6 extension set
 ├─ 5. new EditorView({ state, parent })    // create new editor
 ├─ 6. registerEditorView(tabId, view)      // register in global map
 ├─ 7. countWords() + extractHeadings()     // initial stats
 └─ 8. checkRecoveryDraft()                 // crash recovery check
```

## 5. File Size Tiers

Four tiers determine which CM6 extensions are active:

| Tier | Criteria | WYSIWYG | Syntax Highlight | Line Wrap | Line Numbers | Editable |
|------|----------|---------|------------------|-----------|--------------|----------|
| **Normal** | <1MB, ≤5000 lines | Full | Sized headings (`novelistHighlightStyle`) | Yes | Yes | Yes |
| **Tall Doc** | <1MB, >5000 lines | Off | Flat headings (`flatNovelistHighlightStyle`) | Off | Yes | Yes |
| **Large** | 1–3.5MB | Off | Off | Off | Yes | Yes |
| **Huge** | ≥3.5MB | Off | Off | Yes | Off | Read-only |

**Why Tall Doc mode exists**: CM6 estimates heights for off-screen lines. WYSIWYG decorations (heading font-size, blockquote styling) only apply within the viewport. The difference between estimated and actual heights accumulates over >5000 lines, causing `posAtCoords` (click → document position) to land on the wrong line.

## 6. CM6 Extension Stack (Normal Mode)

`createEditorExtensions()` in `setup.ts` assembles the full extension set:

```
Base Layer:
  lineNumbers + highlightActiveLine + history
  drawSelection + dropCursor + rectangularSelection
  bracketMatching + closeBrackets + scrollPastEnd
  placeholder("Start writing...")

Syntax Layer:
  markdown({ GFM, Highlight, Footnote, FrontMatter,
            InlineMath, DisplayMath, codeLanguages })
  syntaxHighlighting(novelistHighlightStyle)

WYSIWYG Layer (Normal mode only):
  wysiwygPlugin ──→ ViewPlugin + StateField
  mermaidPlugin ──→ Mermaid diagram rendering
  mathPlugin    ──→ KaTeX formula rendering
  tablePlugin   ──→ GFM table rendering

Interaction Layer:
  linkClickPlugin (Cmd+Click to open links)
  imagePastePlugin (paste/drop images)
  slashCommandExtension (/ command menu)
  imeGuardPlugin (CJK IME protection)
  scrollStabilizer (3-layer scroll jump defense)

Theme Layer:
  novelistTheme (CSS variable-driven: --novelist-*)
  EditorView.lineWrapping

Zen Mode (optional):
  typewriterPlugin + paragraphFocusPlugin
```

## 7. WYSIWYG Decoration Pipeline (wysiwyg.ts)

The WYSIWYG plugin rebuilds decorations on `docChanged`, `selectionSet` (line change), or `viewportChanged`. It skips rebuilds during IME composition.

### 7.1 Viewport-scoped decorations (ViewPlugin)

`buildDecorations()` iterates over `view.visibleRanges` in the syntax tree:

| Syntax Node | Decoration Behavior |
|-------------|-------------------|
| ATXHeading1–6 | Hide `#` markers (cursor outside) / show with reduced opacity (cursor on line) |
| StrongEmphasis | Hide `**` + apply bold class |
| Emphasis | Hide `*` + apply italic class |
| Strikethrough | Hide `~~` + apply strikethrough class |
| InlineCode | Hide `` ` `` + apply code background |
| Link | Hide `[]()` syntax + apply link style |
| Blockquote | Hide `>` + left border line decoration |
| FencedCode | Hide ` ``` ` + code block background |
| HorizontalRule | `---` → styled line decoration |
| TaskMarker | `[ ]`/`[x]` → interactive CheckboxWidget (click to toggle) |
| Image | Block widget rendering (see below) |
| Table | Delegated to `table.ts` plugin |
| Highlight | `==text==` highlight |
| Footnote | Superscript reference + definition block style |
| FrontMatter | YAML block style |

### 7.2 Document-scoped image decorations (StateField)

Images use a `StateField` instead of a `ViewPlugin` so CM6 accounts for block widget heights in its height map:

```
imageBlockDecoField (StateField)
  ├─ Full document scan for Image nodes (only <5000 line docs)
  ├─ Decoration.replace({ block: true, widget: ImageWidget })
├─ Local images: window-scoped read_image_bytes capability → base64 data URI
  └─ LRU cache (64 entries) avoids repeated IPC calls
```

**Critical design decision**: Heading font-sizes are applied via `syntaxHighlighting` (consistent across the full document), NOT via mark decorations (viewport-only). This prevents CM6's height estimation from drifting for off-screen heading lines.

## 8. Update Loop

```
EditorView.updateListener:
  docChanged →
  ├─ tabsStore.markDirty(tabId)           // mark unsaved
  ├─ Cross-pane sync (remoteChangeAnnotation) // same file in split view
  ├─ scheduleStatsUpdate()                 // debounced stats
  │   ├─ <2K lines: 500ms → countWords + extractHeadings
  │   ├─ 2K–5K lines: 1s → full stats
  │   └─ >5K lines: 2s → estimate (doc.length / 4)
  └─ Writing session tracking (sessionStartWordCount)

  selectionSet → updateCursorInfo → cursorLine / cursorCol → StatusBar
```

## 9. Rust Backend (Tauri v2)

The frontend communicates with the Rust backend via Tauri IPC. TypeScript bindings are auto-generated by `tauri-specta`.

### 9.1 Commands (`core/src/commands/`)

| Module | Key Commands |
|--------|-------------|
| `file.rs` | `read_file` (encoding detection: UTF-8/GBK/Big5), `write_file` (atomic: temp → rename), `list_directory`, `search_in_project` (walkdir) |
| `image_host.rs` | Window-owned, capability-relative `read_image_bytes` for local image preview/upload |
| `project.rs` | `detect_project` (reads `.novelist/config.toml`) |
| `recent.rs` | Recent project persistence |
| `draft.rs` | Draft note CRUD |
| `snapshot.rs` | Snapshot management |
| `export.rs` | Pandoc export (HTML/PDF/DOCX/EPUB) |
| `plugin.rs` | QuickJS plugin sandbox |
| `stats.rs` | Writing statistics recording |
| `template.rs` | Project template management |

### 9.2 Services (`core/src/services/`)

| Service | Role |
|---------|------|
| `file_watcher.rs` | FSEvent file monitoring → BLAKE3 hash change detection + self-write suppression → emits `file-changed` event → frontend reload or conflict dialog |
| `rope_document.rs` | Ropey rope data structure for huge file editing (`rope_open` / `rope_get_lines` / `rope_apply_edit`) |
| `plugin_host/sandbox.rs` | QuickJS plugin host with permission tiers: read / write / execute |

### 9.3 Pandoc export process contract

Novelist does not bundle Pandoc. Discovery checks the saved override, `pandoc`
on `PATH`, then a deterministic platform-specific list. Every `--version`
probe has a three-second deadline; timeout kills and reaps the child. A
successful probe reports the executable path actually passed to the OS, rather
than the placeholder `pandoc`. Failed discovery reports only a fixed-count list
of attempted locations whose entries are individually redacted and capped at
512 bytes; it never includes environment variables.

Before export, dirty editor tabs are saved. Project input is enumerated
recursively in folder-first numeric order and read during that same retained,
descriptor-relative no-follow capability pass; symlink entries and paths outside
the project are rejected. Enumeration is bounded before buffering by total entry
count and path bytes, then by Markdown file count, depth, and aggregate source
bytes.
Standalone export retains its explicitly selected path behavior. Encoding-aware
decoding preserves GBK, Big5, Shift_JIS, and CJK content, while assembled export
input is capped at 100 MiB and publish HTML input at 10 MiB. Conversion uses a
unique owner-only temporary directory and a 120-second default deadline.

The IPC boundary accepts no arbitrary Pandoc options. HTML theme CSS is capped
at 1 MiB, accepts only a `:root` block of safe custom properties, and is created
by Rust as an owner-only, create-new, request-correlated `<style>` header.
Markdown image destinations are parsed and limited to project-relative or inline
data images. Local raster images are opened no-follow through a retained
capability, signature-checked, bounded, and rewritten to data URIs before Pandoc;
raw HTML, raw TeX, YAML metadata, absolute, network, encoded traversal, and
ambiguous resources are rejected. Safe percent-encoded CJK filenames are decoded
before capability-confined reads. EPUB has no theme control. Timeout
and cancellation terminate and reap the isolated Pandoc process tree before
temporary-resource cleanup. Export, publish HTML, and styled-copy conversion use
the same bounded stdin/stdout/stderr and descendant-cleanup lifecycle.

Pandoc writes inside an owner-only temporary directory on the destination
filesystem, preserving the selected format extension. Output growth is monitored
and capped at 1 GiB. Novelist syncs and atomically renames that file onto the
selected destination only after Pandoc exits successfully, so failed or
cancelled exports cannot truncate an existing destination. Allocation or rename
failure is reported as `output_commit`.

If conversion succeeds but cleanup fails, the output remains available and the
command returns a structured cleanup warning; the Export dialog renders that
warning separately from a failed conversion. Discovery, timeout, input/encoding,
non-zero exit, output decode, output commit, and cleanup details are bounded and
redacted before the UI displays them.

## 10. Theme & Style System

```
themes.ts → CSS variable objects (--novelist-bg, --novelist-text, ...)
    │
    ▼
uiStore.setTheme() → applyTheme() → document.body.style.setProperty()
    │
    ▼
CM6 novelistTheme → consumes CSS variables
app.css + wysiwyg.css → Tailwind CSS 4 + custom decoration styles
```

Available themes: Light, Dark, Sepia, Nord, GitHub, Dracula. Theme switches use smooth CSS transitions.

## 11. Data Flow Summary

```
User action (keyboard / mouse)
    │
    ▼
Svelte 5 Rune Stores ($state / $derived / $effect)
    ├──→ tabsStore: tab state (content / dirty / version)
    ├──→ uiStore: UI state (theme / sidebar / zen / zoom / editor settings)
    └──→ projectStore: project state (file tree / config / path)
    │
    ▼
CodeMirror 6 EditorView
    ├── Syntax parsing: Lezer incremental parser (Markdown + GFM + extensions)
    ├── Decoration: WYSIWYG ViewPlugin (visible ranges) + StateField (images)
    ├── Protection: IME Guard + Scroll Stabilizer (3-layer defense)
    └── Rendering: DOM mutation → browser paint
    │
    ▼ (when backend needed)
Tauri IPC (tauri-specta auto-typed bindings)
    │
    ▼
Rust Backend
    ├── File I/O (atomic writes + encoding detection)
    ├── File watching (BLAKE3 hashing)
    ├── Ropey (large file chunking)
    └── QuickJS (plugin sandbox)
```

## 12. Key Design Decisions

1. **WYSIWYG dual-track rendering**: Heading font-sizes use `syntaxHighlighting` (full-document consistency) rather than `mark decoration` (viewport-only), preventing CM6 height estimation drift.
2. **Four-tier file strategy**: Normal → Tall Doc → Large → Huge, progressively disabling extensions to maintain performance.
3. **Three-layer scroll defense**: mousedown guard → scroll listener → scrollHandler facet, preventing click-after-scroll position jumps.
4. **IME composition guard**: Pauses decoration rebuilds during CJK input composition; forces rebuild when composition ends.
5. **Image StateField**: Block widgets provided via StateField so CM6's height map includes actual image heights, ensuring correct `posAtCoords` mapping.
