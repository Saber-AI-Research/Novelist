# Novelist — Claude Code Instructions

## Project Overview

Novelist is a lightweight, WYSIWYG Markdown desktop writing app built
with **Tauri v2 + Svelte 5 + Rust + CodeMirror 6**. Target: novelists
who need a fast, CJK-aware editor with plugin support.

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
pnpm test:e2e:browser # Browser E2E (Playwright + mocked IPC, ~5s)
pnpm test:e2e:ui      # Playwright interactive UI mode
pnpm test:e2e:debug   # Playwright with step-through debugger
pnpm test:rust        # Backend tests (cargo test in core/)
pnpm test:all         # Unit + Rust tests
```

## Critical Rules

- **`app/lib/ipc/commands.ts` is auto-generated** from Rust via
  tauri-specta — never edit by hand. Re-run `pnpm tauri dev` after
  changing any `#[tauri::command]`.
- **`app/lib/app-commands.ts` is the sole `commandRegistry.register`
  site.** Command palette and global keyboard router both dispatch
  through `commandRegistry.execute()`. Don't reintroduce a parallel
  `shortcutHandlers` map.
- **Atomic file writes** (temp file + rename) for all user data.
- **CJK text support is non-negotiable** — always consider CJK in word
  counting, IME handling, and layout.
- **File watcher uses BLAKE3 hashing** with self-write suppression — see
  [docs/architecture/file-lifecycle.md](docs/architecture/file-lifecycle.md).
- Plugins (canvas, mindmap, kanban) and the template panel are **core
  product features** — no hiding or demoting.

## Design Philosophy

**"Prompt as UI"**: Novelist is designed to be customized by AI coding
assistants editing the source directly, rather than through complex
configuration UIs. Keep the desktop app kernel lean — no HTTP API calls
or AI model integrations in the binary.

## Module Layout (post 2026-04-20 refactor)

- `app/lib/stores/*.svelte.ts` — rune stores (one per domain)
- `app/lib/composables/*.svelte.ts` — component-init hooks (own
  `$state`/`$effect`, exposed as `createX` / `useX` / `wireX`)
- `app/lib/services/*.ts` — IPC orchestration, no reactive state
- `app/lib/utils/*.ts` — pure TS helpers
- `app/lib/editor/*.ts` — CodeMirror 6 extensions + pure view helpers
- `app/lib/components/*.svelte` — Svelte 5 components
- `core/src/commands/` — one file per domain; all return
  `Result<T, AppError>` (see `core/src/error.rs`)
- `core/src/services/` — file watcher, rope, plugin host
- `core/src/models/` — data structures with serde + specta derives

## Architecture Deep Dives

Detailed design docs live under `docs/architecture/` — load these when
touching the relevant code:

| Topic | File |
|-------|------|
| CM6 editor (WYSIWYG, slash menu, context menu, image blocks, selection, zoom, tall-doc mode) | [editor.md](docs/architecture/editor.md) |
| Plugin system (WKWebView quirks, bundled plugins, mindmap overlay, `.kanban`/`.canvas` routing) | [plugin-system.md](docs/architecture/plugin-system.md) |
| Settings (two-tier global+project overlay, plugin deltas, new-file location, sidebar menus) | [settings.md](docs/architecture/settings.md) |
| File lifecycle (watcher, self-write suppression, rename broadcast, recent projects) | [file-lifecycle.md](docs/architecture/file-lifecycle.md) |
| Testing (three-tier strategy, `data-testid`, `__test_api__`, mock IPC) | [testing.md](docs/architecture/testing.md) |
| Startup instrumentation | [startup-instrumentation.md](docs/architecture/startup-instrumentation.md) |
| Feature boundaries (core editor / core product / infrastructure / diagnostics) | [feature-boundaries.md](docs/architecture/feature-boundaries.md) |
| Refactor plan (2026-04-20 App.svelte split + this consolidation) | [refactor-plan-2026-04-20.md](docs/architecture/refactor-plan-2026-04-20.md) |

Huge-file scroll stabilizer details: `docs/design/scroll-stabilizer-bug.md`.
Pre-implementation feature specs: `docs/superpowers/specs/`.

## File Layout

```
app/                    # Frontend (Svelte 5 + TypeScript)
  lib/{components,composables,services,editor,stores,utils}/
  lib/ipc/commands.ts   # Auto-generated — DO NOT EDIT
  lib/app-commands.ts   # Sole commandRegistry.register site
  App.svelte            # Root layout (thin composition)
core/                   # Backend (Rust + Tauri v2)
  src/{commands,services,models}/
  src/lib.rs            # App entry + command registration
docs/
  architecture/         # Deep dives (see table above)
  superpowers/specs/    # Feature specs (written before implementation)
plugins/                # Bundled plugin templates
tests/{unit,e2e,bench}/
```

## Recent Notable Additions

See `git log` for full history. Recent highlights (2026-04):

- App.svelte refactor (1475 → ~741 lines); composables + services split.
- Template files panel with bundled defaults + `$|$` caret anchor.
- Settings two-tier overlay (global + per-project) on Rust side.
- Startup instrumentation (`log_startup_phase` + `startup-timing.ts`),
  lazy QuickJS runtime, async recent-projects cleanup.
- Canvas / kanban file-type editors (native, not plugin-shimmed).
- `Cmd+Shift+M` move-file palette; sidebar + editor context menus.
- Smart project-mode new-file naming with H1 auto-rename.
- Numeric-aware sidebar sort (第二章 < 第十章).
