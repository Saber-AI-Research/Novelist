# Frontend

Last updated: 2026-11-03

The frontend is a Svelte 5 app that hosts CodeMirror 6 and talks to Rust
through generated Tauri IPC bindings.

## Layout

| Path | Responsibility |
|---|---|
| `app/App.svelte` | Thin root composition. |
| `app/lib/components/` | UI components and panels. |
| `app/lib/composables/` | Component-init hooks and event wiring. |
| `app/lib/stores/` | Svelte 5 rune stores, one domain per file. |
| `app/lib/services/` | IPC orchestration and non-reactive service helpers. |
| `app/lib/editor/` | CodeMirror extensions and editor-specific helpers. |
| `app/lib/utils/` | Pure helpers and small platform utilities. |
| `app/lib/app-commands.ts` | Sole command registry site. |
| `app/lib/ipc/commands.ts` | Generated IPC bindings; do not edit manually. |

## Icons

Shared decorative SVG components live in `app/lib/components/icons/` and are
re-exported from its `index.ts`. They accept `size` (14px by default) and `class`,
use a 16×16 viewBox, `currentColor` strokes and `aria-hidden="true"`; the adjacent
label or control supplies the accessible name. Built-in AI prompt presets use
components, while user-authored preset icons may remain strings. Keep that
distinction when persisting or rendering presets.

## Development Gate

Use the harness for repeatable checks:

```bash
pnpm verify:quick  # Svelte check + Vitest unit/integration
pnpm verify:e2e    # Browser E2E with mocked Tauri IPC
pnpm verify:ci     # Local CI mirror
```

## Testing Expectations

- Pure helpers and stores: Vitest unit tests.
- CM6 runtime behavior: integration tests or Playwright.
- User flows and keyboard behavior: Playwright with `data-testid`.
- Browser-intercepted shortcuts: expose a narrow `window.__test_api__`
  helper rather than relying on OS shortcuts.

See [design-docs/testing.md](design-docs/testing.md).
