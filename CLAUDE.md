# Novelist - Claude Code Instructions

## Project Overview

Novelist is a lightweight, WYSIWYG Markdown desktop writing app built with **Tauri v2 + Svelte 5 + Rust + CodeMirror 6**. Target: novelists who need a fast, CJK-aware editor with plugin support.

## Tech Stack

- **Frontend**: Svelte 5 (Runes: `$state`, `$derived`), Tailwind CSS 4, Vite 6
- **Editor**: CodeMirror 6 with custom WYSIWYG decorations
- **Backend**: Rust (Tauri v2), Tokio async runtime
- **IPC**: tauri-specta (auto-generates TypeScript bindings from Rust)
- **Plugin sandbox**: QuickJS via rquickjs
- **Large files**: Ropey rope data structure
- **File watching**: Notify (FSEvent on macOS)
- **Export**: Pandoc (external binary)

## Development Commands

```bash
pnpm install          # Install frontend deps
pnpm tauri dev        # Start dev server + Tauri window
pnpm tauri build      # Production build
pnpm test             # Frontend tests (vitest)
pnpm test:rust        # Backend tests (cargo test in src-tauri/)
pnpm test:all         # Both frontend + backend
pnpm check            # Svelte type checking
```

## Architecture Rules

### IPC (Frontend <-> Backend)
- All IPC commands are defined in `src-tauri/src/commands/` as Rust functions tagged with `#[tauri::command]` + `#[specta::specta]`
- Commands are registered in `src-tauri/src/lib.rs` via `tauri_specta::Builder`
- TypeScript bindings are auto-generated at `src/lib/ipc/commands.ts` -- **do NOT manually edit this file**
- After adding/changing a Rust command, run `pnpm tauri dev` to regenerate bindings

### Frontend Patterns
- **Stores**: Svelte 5 rune stores in `src/lib/stores/` -- use `$state()` and `$derived()`, not legacy `writable()`/`readable()`
- **Components**: `src/lib/components/` -- standard Svelte 5 components
- **Editor extensions**: `src/lib/editor/` -- CodeMirror 6 extensions (WYSIWYG, zen mode, outline, viewport, IME guard)
- **Themes**: Defined as CSS variable objects in `src/lib/themes.ts`
- **Split view**: Each pane has its own tab state; use pane ID (`"left"` / `"right"`) to scope operations

### Backend Patterns
- **Commands**: `src-tauri/src/commands/` -- one file per domain (file, project, recent, draft, export, plugin)
- **Services**: `src-tauri/src/services/` -- long-running services (file_watcher, rope_document, plugin_host)
- **Models**: `src-tauri/src/models/` -- data structures with serde + specta derives
- **Errors**: Use `AppError` from `src-tauri/src/error.rs` with `thiserror` -- all commands return `Result<T, AppError>`

### Large File Handling
Four tiers based on file size and line count:
- **Normal** (< 1MB, ≤ 5000 lines): Full WYSIWYG + stats
- **Tall doc** (< 1MB, > 5000 lines): No WYSIWYG decorations, flat heading sizes — prevents CM6 height-map drift that causes click-after-scroll jump bugs
- **Large** (1-10MB): Stripped extensions, reduced stat frequency
- **Huge** (> 10MB): Read-only via rope backend

**Why tall doc mode exists**: CM6 estimates heights for off-screen lines. WYSIWYG decorations (heading font-size changes, blockquote styling, etc.) only apply within the viewport. The difference between estimated and actual heights accumulates as the user scrolls, causing `posAtCoords` (click → document position) to land on the wrong line. For documents > 5000 lines, this drift becomes user-visible. The fix: disable all height-changing decorations and use uniform heading font sizes via `flatNovelistHighlightStyle` in `src/lib/editor/setup.ts`.

### Plugin System
- Plugins live in `~/.novelist/plugins/<id>/` with `manifest.toml` + `index.js`
- Sandboxed via QuickJS with permission tiers: read, write, execute
- Plugin commands appear in the command palette

## Design Philosophy

**"Prompt as UI"**: Novelist is designed to be customized by AI coding assistants editing the source directly, rather than through complex configuration UIs. Keep the desktop app kernel lean -- no HTTP API calls or AI model integrations in the binary.

## Key Conventions

- CJK text support is critical -- always consider CJK characters in word counting, IME handling, and layout
- Atomic file writes (write to temp, then rename) for data safety
- File watcher uses BLAKE3 hashing for change detection with self-write suppression
- Auto-save interval: configurable (default 5 minutes, 0 = off) via Settings > Editor
- Window title format: `{filename} - Novelist` or `Novelist` when no file open

## Testing

- Frontend unit tests: `src/lib/**/*.test.ts` (vitest)
- Backend tests: inline `#[cfg(test)]` modules in each Rust file
- GUI automation: `scripts/test-*.sh` (bash + cliclick + osascript, macOS only)
- Naming convention: describe the behavior being tested, not the function name

## File Layout

```
src/                          # Frontend
  lib/components/             # Svelte components (Editor, Sidebar, Settings, ProjectSearch, etc.)
  lib/editor/                 # CodeMirror extensions
  lib/stores/                 # Svelte 5 rune stores (ui, tabs, project, commands, shortcuts)
  lib/ipc/commands.ts         # Auto-generated IPC bindings (DO NOT EDIT)
  lib/themes.ts               # Theme definitions
  lib/utils/                  # Utilities (wordcount, etc.)
  App.svelte                  # Root layout
src-tauri/                    # Backend
  src/commands/               # Tauri IPC commands (file, project, recent, draft, export, plugin)
  src/services/               # File watcher, rope, plugins
  src/models/                 # Data structures
  src/lib.rs                  # App entry + command registration
  src/error.rs                # Error types
.github/workflows/ci.yml     # CI: svelte-check + vitest + cargo test on macOS
design/P3-technical-plans.md  # Long-term roadmap technical plans
```

## Recent Additions (v0.0.2+)

- **Error boundary**: `ErrorBoundary.svelte` wraps Editor components to prevent white-screen crashes
- **Multi-window**: `Cmd+Shift+N` opens new independent window via `WebviewWindow`
- **Project search**: `Cmd+Shift+F` opens project-wide search (Rust `walkdir` backend, `ProjectSearch.svelte`)
- **File drag-drop**: Drop `.md/.markdown/.txt` files onto window to open
- **Undo history persistence**: EditorState saved/restored across tab switches
- **Keyboard shortcuts**: Customizable via Settings > Shortcuts, stored in localStorage
- **Auto-save config**: Adjustable interval in Settings > Editor (0 = off)
- **Theme transitions**: Smooth CSS transitions on theme switch
- **Status bar**: Shows file name, file size, daily goal progress
- **Recent projects cleanup**: Filters non-existent paths on load
- **Export progress**: Animated progress bar during Pandoc export
- **CSP security**: Content Security Policy configured in `tauri.conf.json`
- **CI/CD**: GitHub Actions workflow for type-check + tests
