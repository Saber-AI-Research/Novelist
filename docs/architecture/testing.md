# Testing Strategy

Three-tier automated testing — run all three before pushing.

## Tier 1: Unit Tests (Vitest) — `pnpm test`

- ~494 tests in `tests/unit/**/*.test.ts`.
- Tests pure functions: word counting, markdown parsing, editor logic,
  store behavior.
- Naming convention: describe the behavior being tested, not the function
  name.

## Tier 2: Browser E2E (Playwright) — `pnpm test:e2e:browser`

- ~85 tests in `tests/e2e/specs/*.spec.ts`.
- Runs the full Svelte app in a real browser (WebKit) against the Vite
  dev server.
- Tauri IPC is mocked via `tests/e2e/fixtures/tauri-mock.ts`
  (`window.__TAURI_INTERNALS__`).
- Uses `data-testid` attributes for stable element selection (not CSS
  classes or coordinates).
- Uses `waitFor` / `toBeVisible` for synchronization (not `sleep`).
- Browser-intercepted shortcuts (Meta+B, Meta+S, F11) use
  `window.__test_api__` bridge.

### When adding new features

1. Add `data-testid="..."` to new interactive elements in Svelte components.
2. Add IPC command handlers to `tests/e2e/fixtures/tauri-mock.ts` if new
   Rust commands are needed — otherwise the test crashes on unknown IPC.
3. Create a new `.spec.ts` file in `tests/e2e/specs/` or extend an
   existing one.
4. If the feature uses a keyboard shortcut that browsers intercept, add a
   method to `__test_api__` in `App.svelte`'s `onMount`.

### Test fixture API

- `app` — Playwright Page with mock IPC pre-injected.
- `mockState.getWrittenFiles()` — check what files were saved.
- `mockState.getCreatedFiles()` — check what files were created.
- `mockState.emitEvent(name, payload)` — simulate Tauri events.

## Tier 3: Full E2E (tauri-plugin-playwright) — `pnpm test:e2e:tauri`

- Same test specs as Tier 2 but running against the real Tauri app with
  actual Rust backend.
- Requires `e2e-testing` cargo feature flag:
  `cargo build --features e2e-testing`.
- Uses socket bridge to drive WKWebView on macOS.
- Run before releases for full integration validation.

## Backend Tests (Rust) — `pnpm test:rust`

- ~171 tests in `core/src/` via `#[cfg(test)]` modules.
- Tests file I/O, encoding, rope data structure, plugin sandbox, project
  config.

## Legacy

- Old bash+cliclick GUI tests archived in `tests/e2e/old/` (deprecated,
  do not use).
