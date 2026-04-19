# Development Guide

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [pnpm](https://pnpm.io/) >= 9
- [Rust](https://rustup.rs/) >= 1.77
- System dependencies for Tauri v2:
  - **macOS**: Xcode Command Line Tools
  - **Linux**: `libcairo2-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev`
  - **Windows**: [WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

## Commands

```bash
pnpm install          # Install frontend deps
pnpm tauri dev        # Start dev server + Tauri window
pnpm tauri build      # Production build
pnpm test             # Frontend unit tests (vitest)
pnpm test:e2e:browser # Browser E2E tests (Playwright, mocked Tauri IPC)
pnpm test:e2e:ui      # Playwright interactive UI mode
pnpm test:e2e:debug   # Playwright step-through debugger
pnpm test:rust        # Rust backend tests (cargo test)
pnpm test:all         # Unit + Rust tests
pnpm check            # Svelte type checking
```

## Testing

Three tiers — see `CLAUDE.md` for details:

1. **Unit (Vitest)** — pure functions, stores, editor logic (`tests/unit/`)
2. **Browser E2E (Playwright)** — full Svelte app against a real browser with mocked Tauri IPC (`tests/e2e/specs/`)
3. **Full E2E (tauri-plugin-playwright)** — same specs against the real Rust backend, gated behind the `e2e-testing` cargo feature; run before releases

## Project Structure

```
app/                          # Frontend (Svelte 5 + TypeScript)
├── lib/
│   ├── components/           # UI components
│   ├── editor/               # CodeMirror 6 setup + WYSIWYG
│   ├── stores/               # Svelte 5 rune stores
│   ├── ipc/                  # Tauri IPC bindings (auto-generated)
│   ├── themes.ts             # Theme definitions
│   └── utils/                # Utilities
├── App.svelte                # Root layout
core/                         # Backend (Rust + Tauri v2)
├── src/
│   ├── commands/             # Tauri IPC commands
│   ├── services/             # File watcher, rope, plugins
│   └── models/               # Data models
docs/                         # Documentation
assets/                       # DMG backgrounds, logos, icons
plugins/                      # Plugin templates
tests/                        # Unit, e2e, benchmark tests
scripts/                      # Build scripts
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| App Framework | [Tauri v2](https://v2.tauri.app/) |
| Frontend | [Svelte 5](https://svelte.dev/) (Runes) |
| Editor | [CodeMirror 6](https://codemirror.net/) |
| CSS | [Tailwind CSS 4](https://tailwindcss.com/) |
| Build | [Vite 6](https://vite.dev/) |
| Backend | Rust |
| IPC | [tauri-specta](https://github.com/oscartbeaumont/tauri-specta) |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.
