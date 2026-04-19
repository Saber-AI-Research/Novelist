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
pnpm check            # Svelte type checking

# Testing
pnpm test             # Frontend unit tests (vitest, ~1s)
pnpm test:e2e:browser # Browser E2E tests (Playwright + mocked IPC, ~5s)
pnpm test:e2e:ui      # Playwright interactive UI mode (for debugging)
pnpm test:e2e:debug   # Playwright with step-through debugger
pnpm test:rust        # Backend tests (cargo test in core/)
pnpm test:all         # Unit + Rust tests
```

## Architecture Rules

### IPC (Frontend <-> Backend)
- All IPC commands are defined in `core/src/commands/` as Rust functions tagged with `#[tauri::command]` + `#[specta::specta]`
- Commands are registered in `core/src/lib.rs` via `tauri_specta::Builder`
- TypeScript bindings are auto-generated at `app/lib/ipc/commands.ts` -- **do NOT manually edit this file**
- After adding/changing a Rust command, run `pnpm tauri dev` to regenerate bindings

### Frontend Patterns
- **Stores**: Svelte 5 rune stores in `app/lib/stores/` -- use `$state()` and `$derived()`, not legacy `writable()`/`readable()`
- **Components**: `app/lib/components/` -- standard Svelte 5 components
- **Editor extensions**: `app/lib/editor/` -- CodeMirror 6 extensions (WYSIWYG, zen mode, outline, viewport, IME guard)
- **Themes**: Defined as CSS variable objects in `app/lib/themes.ts`
- **Split view**: Each pane has its own tab state; use pane ID (`"left"` / `"right"`) to scope operations

### Backend Patterns
- **Commands**: `core/src/commands/` -- one file per domain (file, project, recent, draft, export, plugin)
- **Services**: `core/src/services/` -- long-running services (file_watcher, rope_document, plugin_host)
- **Models**: `core/src/models/` -- data structures with serde + specta derives
- **Errors**: Use `AppError` from `core/src/error.rs` with `thiserror` -- all commands return `Result<T, AppError>`

### Large File Handling
Four tiers based on file size and line count:
- **Normal** (< 1MB, ≤ 5000 lines): Full WYSIWYG + stats
- **Tall doc** (< 1MB, > 5000 lines): No WYSIWYG decorations, flat heading sizes — prevents CM6 height-map drift that causes click-after-scroll jump bugs
- **Large** (1-10MB): Stripped extensions, reduced stat frequency
- **Huge** (> 10MB): Read-only via rope backend

**Why tall doc mode exists**: CM6 estimates heights for off-screen lines. WYSIWYG decorations (heading font-size changes, blockquote styling, etc.) only apply within the viewport. The difference between estimated and actual heights accumulates as the user scrolls, causing `posAtCoords` (click → document position) to land on the wrong line. For documents > 5000 lines, this drift becomes user-visible. The fix: disable all height-changing decorations and use uniform heading font sizes via `flatNovelistHighlightStyle` in `app/lib/editor/setup.ts`.

### CM6 Block Widget Decorations (Images)

Image rendering uses `Decoration.replace({block: true, widget})` via a `StateField` in `app/lib/editor/wysiwyg.ts`. Key lessons learned:

- **Use single block replace, not widget+hide**: A single `Decoration.replace({block: true, widget}).range(line.from, line.to)` produces one height-map entry. The old approach (3 decorations: widget + line class + inline replace) created misaligned height-map entries causing `posAtCoords` click offsets proportional to image height.
- **Block decorations must NOT toggle on cursor position**: Toggling changes the height map between mousedown/mouseup, causing infinite cursor oscillation.
- **Block decorations must be provided via StateField**: Only `StateField.provide(f => EditorView.decorations.from(f))` makes CM6 account for block widget heights in its height map. `ViewPlugin` decorations don't.
- **No CSS vertical margin on block widgets**: CM6 cannot see CSS margin. Use `padding` inside the widget instead.
- **CSS `zoom` breaks CM6**: The app's zoom feature must use `transform: scale()` (which CM6 detects via `scaleX`/`scaleY`), NOT `document.documentElement.style.zoom` (which CM6 doesn't understand). CSS zoom causes `posAtCoords` to return wrong positions because `getBoundingClientRect` and internal height-map coordinates become inconsistent. See `app/lib/stores/ui.svelte.ts` `setZoom()`.
- **`requestMeasure()` after async image load**: When image loads asynchronously, call `view.requestMeasure()` followed by `view.dispatch({ effects: [] })` to force CM6 to re-measure block heights. `requestMeasure()` alone may skip height measurement if `contentDOMHeight` hasn't visibly changed.
- **No duplicate gutter markers**: With `Decoration.replace({block: true})`, CM6's line number gutter automatically generates a line number for the replaced range. Do NOT add a `lineNumberWidgetMarker` — it creates duplicate line numbers.

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

Three-tier automated testing — run all three before pushing:

### Tier 1: Unit Tests (Vitest) — `pnpm test`
- **258 tests** in `tests/unit/**/*.test.ts`
- Tests pure functions: word counting, markdown parsing, editor logic, store behavior
- Naming convention: describe the behavior being tested, not the function name

### Tier 2: Browser E2E (Playwright) — `pnpm test:e2e:browser`
- **38 tests** in `tests/e2e/specs/*.spec.ts`
- Runs the full Svelte app in a real browser (Chromium) against the Vite dev server
- Tauri IPC is mocked via `tests/e2e/fixtures/tauri-mock.ts` (`window.__TAURI_INTERNALS__`)
- Uses `data-testid` attributes for stable element selection (not CSS classes or coordinates)
- Uses `waitFor` / `toBeVisible` for synchronization (not `sleep`)
- Browser-intercepted shortcuts (Meta+B, Meta+S, F11) use `window.__test_api__` bridge

**When adding new features:**
1. Add `data-testid="..."` to new interactive elements in Svelte components
2. Add IPC command handlers to `tests/e2e/fixtures/tauri-mock.ts` if new Rust commands are needed
3. Create a new `.spec.ts` file in `tests/e2e/specs/` or extend an existing one
4. If the feature uses a keyboard shortcut that browsers intercept, add a method to `__test_api__` in `App.svelte`'s onMount

**Test fixture API:**
- `app` — Playwright Page with mock IPC pre-injected
- `mockState.getWrittenFiles()` — check what files were saved
- `mockState.getCreatedFiles()` — check what files were created
- `mockState.emitEvent(name, payload)` — simulate Tauri events

### Tier 3: Full E2E (tauri-plugin-playwright) — `pnpm test:e2e:tauri`
- Same test specs as Tier 2 but running against the real Tauri app with actual Rust backend
- Requires `e2e-testing` cargo feature flag: `cargo build --features e2e-testing`
- Uses socket bridge to drive WKWebView on macOS
- Run before releases for full integration validation

### Backend Tests (Rust) — `pnpm test:rust`
- **160 tests** in `core/src/` via `#[cfg(test)]` modules
- Tests file I/O, encoding, rope data structure, plugin sandbox, project config

### Legacy
- Old bash+cliclick GUI tests archived in `tests/e2e/old/` (deprecated, do not use)

## File Layout

```
app/                          # Frontend (Svelte 5 + TypeScript)
  lib/components/             # Svelte components (Editor, Sidebar, Settings, ProjectSearch, etc.)
  lib/editor/                 # CodeMirror extensions
  lib/stores/                 # Svelte 5 rune stores (ui, tabs, project, commands, shortcuts)
  lib/ipc/commands.ts         # Auto-generated IPC bindings (DO NOT EDIT)
  lib/themes.ts               # Theme definitions
  lib/utils/                  # Utilities (wordcount, etc.)
  App.svelte                  # Root layout
core/                         # Backend (Rust + Tauri v2)
  src/commands/               # Tauri IPC commands (file, project, recent, draft, export, plugin)
  src/services/               # File watcher, rope, plugins
  src/models/                 # Data structures
  src/lib.rs                  # App entry + command registration
  src/error.rs                # Error types
docs/                         # Documentation
  design/                     # Architecture & design docs
  research/                   # Competitive analysis
  plans/                      # Implementation phase plans
assets/                       # Build & branding assets
  dmg/                        # DMG background images
  branding/                   # Logo & icon source files
plugins/                      # Plugin templates (canvas, mindmap)
scripts/                      # Build scripts (create-dmg.sh)
tests/                        # Tests
  unit/                       # Vitest unit tests (editor, stores, utils)
  e2e/
    fixtures/                 # Playwright test fixtures + Tauri IPC mock
    specs/                    # Playwright E2E test specs (*.spec.ts)
    old/                      # Archived bash scripts (deprecated)
  bench/                      # Performance benchmarks
playwright.config.ts          # Playwright config (browser-mode E2E)
.github/workflows/            # CI: svelte-check + vitest + playwright + cargo test
```

## Recent Additions (v0.1.0+)

- **Smart new file naming**: project-mode "New file" infers the next chapter number from sibling filenames (recognizes `第{N}章`, `Chapter {N}`, `{N}-{title}`, etc. including bracket/quote wraps); falls back to a user-configurable template in Settings > Editor > New file in project. Saving a placeholder file with an H1 renames it to match (one-shot, only while filename is still placeholder). Pipeline: `app/lib/utils/{numbering,h1,filename,placeholder}.ts`.
- **Numeric-aware sidebar sort**: file tree orders `第二章 < 第十章` numerically by default (leftmost digit or CJK numeral run). Sort dropdown in sidebar header offers name/number/mtime asc/desc; choice persists per project via `novelist.sortMode.<path>` in localStorage. Comparator: `app/lib/utils/file-sort.ts`.
- **Save flow auto-rename**: `tabsStore.tryRenameAfterSave(filePath, content)` runs after every successful writeFile; uses `rename_item(..., allow_collision_bump: true)` with ` 2`/` 3` suffix on collision. Cross-window consistency via `broadcast_file_renamed` IPC → `file-renamed` Tauri event → `tabsStore.updatePath` in every window. File watcher has `register_rename_ignore(old, new)` to suppress the rename's own FS events.
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
- **CI/CD**: GitHub Actions workflow for type-check + vitest + Playwright E2E + cargo test
- **Playwright E2E**: 38 browser-mode tests replacing old bash+cliclick GUI tests
- **Test API bridge**: `window.__test_api__` for testing browser-intercepted shortcuts
- **Image block decoration fix**: Single `Decoration.replace({block: true})` for images, CSS zoom→transform migration, async height refresh, gutter dedup
- **Image block tests**: 21 tests in `tests/unit/editor/image-block-deco.test.ts` covering decoration strategy, height map, coordinate mapping, zoom impact
