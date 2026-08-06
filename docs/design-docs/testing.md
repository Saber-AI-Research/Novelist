# Testing Strategy

Novelist uses distinct layers because a browser with mocked Tauri IPC cannot
prove the same contracts as the Rust backend or a real WKWebView. Choose the
narrowest layer that can observe the behavior, then add a higher-layer guard
when the integration boundary itself is the risk. Avoid hardcoded repository-
wide test totals; suite size changes frequently.

## Layers and commands

| Layer | Purpose | Canonical commands |
|---|---|---|
| Static frontend check | Svelte and TypeScript diagnostics | `pnpm check` |
| Frontend unit | Pure helpers, reducers, stores, command registration, and narrow contracts in `tests/unit/` | `pnpm test:unit` |
| Frontend integration | DOM-required and multi-module behavior, including real CodeMirror `EditorView` wiring, in `tests/integration/` | `pnpm test:integration` |
| Vitest aggregate and coverage | All Vitest projects, or the enforced v8 coverage floors | `pnpm test`; `pnpm test:coverage`; `pnpm verify:coverage` |
| Browser Playwright | Svelte UI workflows against injected Tauri mocks | `pnpm test:e2e:browser` (WebKit); `pnpm test:e2e:all-browsers` (WebKit and Chromium); `pnpm verify:e2e` |
| Native macOS smoke | Real Tauri app, Rust commands, and WKWebView through a run-scoped socket | `pnpm test:e2e:tauri`; `pnpm verify:native-smoke` |
| Rust backend | Rust unit/service/command tests; harness also applies format and strict Clippy gates | `pnpm test:rust`; `pnpm verify:rust` |
| Local core quality gate | Frontend check, coverage, browser WebKit, Rust format/Clippy/tests | `pnpm verify:ci` |

`pnpm verify:quick` runs `pnpm check` followed by unit and integration suites.
`pnpm verify:unit` runs unit and integration without the Svelte check.
The CI workflow runs `pnpm check`, `pnpm test:coverage`,
`pnpm test:e2e:browser`, Rust format/Clippy/tests, and the ignored real-Pandoc
matrices (`pnpm test:rust:pandoc`) against pinned Pandoc 3.10. Those matrices
cover styled-copy extensions plus CJK HTML/DOCX/EPUB export. `pnpm test:all` is
Vitest plus `cargo test`; it does not include browser or native Playwright.

## Suite-size discipline

Test count is not a target. Audit suite value using distinct production
branches, regression ownership, runtime, and failure diagnostics. For pure
validators, keep the complete input partition at the validator boundary and
use representative cases at each caller boundary; do not repeat the same
invalid-value matrix through every wrapper. Remove runtime tests that only
prove a TypeScript assignment compiles, because `pnpm check` already owns that
contract. Never trade away CJK/IME coverage, persistence migrations, native
cleanup guarantees, or a minimal past-bug reproducer merely to reduce totals.

Every pruning change must pass `pnpm test:coverage` without lowering the
enforced floors. Slow limit, timeout, and race tests should be optimized only
when their boundary can still be exercised at production values.

## Unit and integration placement

Use `tests/unit/` when the subject can be exercised without rendering the app.
Use `tests/integration/` when a test constructs an `EditorView`, dispatches DOM
or composition events, renders a component, or wires multiple modules. Intent
labels such as `[precision]`, `[contract]`, `[regression]`, and `[smoke]` are
defined in [testing-precision.md](testing-precision.md).

For editor changes, pair pure transaction-shape coverage with a real
`EditorView` contract when selection mapping, IME state, focus, keymap
precedence, transaction count, or undo history matters. The block-transform
examples are `tests/unit/editor/block-transform.test.ts` and
`tests/integration/editor/block-transform-runtime.test.ts`.

## Browser Playwright boundary

`playwright.config.ts` runs specs from `tests/e2e/specs/` in WebKit and
Chromium. `tests/e2e/fixtures/app-fixture.ts` injects
`tests/e2e/fixtures/tauri-mock.ts` before page load. The fixture provides a
deterministic project/file model and mocks Tauri IPC, provider responses,
clipboard access, file-watcher events, updater plugin behavior, and related
async failure/release controls. Browser tests therefore prove frontend state
machines, rendering, dispatch counts, persistence requests, and mock isolation.

They **cannot** prove native clipboard bytes, notify/poll delivery, Rust file or
sidecar behavior, provider networking, updater plugin lifecycle, Tauri process
startup, or WKWebView compositing. Chromium/WebKit parity does not change that
boundary. Never cite a browser-mock pass as native clipboard, watcher, provider,
or updater evidence.

Tests should exercise production helpers or real extensions rather than copy
their logic into a test-only implementation. The former
`tests/unit/editor/checklist.test.ts` and
`tests/unit/editor/slash-commands.test.ts` suites duplicated checkbox and slash
template algorithms. Their production behavior is now covered directly by
`tests/integration/editor/wysiwyg-runtime.test.ts`,
`tests/integration/editor/slash-runtime.test.ts`, the block-transform suites,
and browser editor workflows.

Stable browser practices:

- Select user-facing controls with `data-testid` or accessible roles, not
  layout coordinates or private CSS where a stable contract exists.
- Synchronize with Playwright assertions, `expect.poll`, or explicit fixture
  release points. Do not add arbitrary sleeps.
- Add every new IPC command used by a browser workflow to `tauri-mock.ts`;
  unknown commands are surfaced as browser errors.
- Use `appKeys`/`window.__test_api__` only for shortcuts the browser or OS
  intercepts and identity-sensitive editor lifecycle/setup that visible DOM
  cannot prove; ordinary interactions should use the visible UI.
- Editor tests must wait on App's canonical `__test_api__.getActiveEditor()`
  handle matching the expected file path and document. A visible `.cm-editor`
  is only a shell, and the legacy unowned `__novelist_view` global may be stale
  or absent during pane/tab/zen cleanup.
- Synthetic editor document setup must use
  `__test_api__.setActiveEditorDocument()`, which dispatches outside history.
  Do not sleep to separate fixture setup from the first user undo step.

AI Agent pre-send context failures require a target-session turn before the
asynchronous context read begins. Browser regressions must assert that a typed
or thrown context-read failure produces one sanitized retryable turn, zero
provider spawn/send and zero tool/apply writes, and no global or destination-
session error. Retrying that pending-context turn must perform a new context
read and dispatch exactly once with the current bytes. Cover active-session
switches with delayed output in another session, project A to B switching,
session rename/delete, and component destruction through explicit fixture
release/rejection points rather than timing sleeps.

## Task 23 tagged regression workflows

Task 23 uses Playwright `@` tags in test titles, not the bracketed describe
intent convention:

```bash
pnpm exec playwright test --grep @task23
pnpm exec playwright test --grep @task23-negative
```

The accepted Task 23 matrix is 25 tests per engine, 50 total, for `@task23`;
the independently filterable negative/recovery subset is 14 per engine, 28
total, for `@task23-negative`. Negative tests also carry `@task23`, so the
aggregate includes them. Those exact accepted results are task evidence
snapshots, not a repository-wide count promise or a durable dependency on the
ignored `.sisyphus` work archive.

After every `@task23` test, the automatic fixture releases blocked operations,
resets updater/portable state, clears local/session storage and browser caches,
performs a full mock reset, checks browser errors, and compares files, invokes,
listeners, pending waiters, AI/Publish/updater/template/plugin state against one
exact zero-residue object. A negative UI assertion should also assert the exact
forbidden IPC/request count whenever possible.

## Native macOS boundary

`playwright.tauri.config.ts` runs the single-worker native specs under
`tests/e2e/native/`. The wrapper `tests/e2e/native/run-native-smoke.mjs`
launches the `e2e-testing` Tauri build and drives the real Rust backend and
macOS WKWebView through `@srsholmes/tauri-playwright`; it does not install the
browser IPC mock. Each run owns a unique socket, temporary CJK project,
Vite port, bundle identity, HOME/cache/config/data namespace, and temporary
root. It snapshots the macOS pasteboard before mutation and restores the exact
fingerprint during teardown.

The native fixture disconnects the plugin, terminates the complete run-owned
process tree (bounded TERM then KILL), removes the socket, run root, project,
helper binaries, and run-identified macOS cache/state residue, and fails on any
survivor or cleanup error. Evidence must report clipboard restoration plus
process, socket, filesystem, and cache residue.

The native workflow `real WKWebView native clipboard, watcher, conflict, and
rename lifecycle` behaviorally covers:

- native clipboard image bytes, cover pixels, durable asset/hash/sidecar, and
  close/reopen restoration;
- real watcher notify with IME deferral, composition-end convergence, poll
  fallback, and dirty-buffer conflict preservation;
- CJK rename conflict copies, metadata-error retention, idempotent retry, and
  migration of draft, recovery, managed-name, Publish identity/form/cover
  sidecars with no journal residue.

These assertions exercise the contracts documented in
[file-lifecycle.md](file-lifecycle.md) and the
[Publish specification](../product-specs/2026-05-06-publish.md).

### Current Task 24 status

Task 24 was accepted on July 20, 2026 by an unattended
`pnpm test:e2e:tauri` run. The real AppKit application was active with a
visible key/main window, and the WKWebView received one native Command+V event.
The run proved nonblank red cover pixels, one durable hashed asset, close/reopen
restoration, notify and poll reload behavior through IME and dirty conflicts,
and the complete CJK rename migration chain.

The native PDF snapshot was rasterized at the window's backing scale and
validated as a fresh 2400x1600 PNG. Its cover crop was fully opaque and exceeded
the strict red-pixel threshold. Teardown restored the original pasteboard and
reported no process, socket, temporary project, bundle, helper, screenshot, or
application-cache residue.

Raw native run history remains a local task artifact because it can contain
machine paths, process IDs, socket names, and pasteboard fingerprints. Do not
publish or link that log from durable documentation; retain only the redacted
behavior and cleanup summary above.

## Evidence policy

Behavior assertions come first. Screenshots are supplemental unless the
acceptance criterion is specifically visual; a saved screenshot must be
nonblank and must show the required state, and native screenshot evidence must
also satisfy its pixel/compositing checks. Record:

- the exact command, platform/project selection, exit status, and passed/failed
  test counts;
- assertions that prove state, persistence, pixels, IPC/request counts, or
  forbidden actions rather than relying on a screenshot alone;
- teardown results, including mock residue for tagged browser tests and
  pasteboard/process/socket/project/cache cleanup for native runs;
- blockers and partial results without relabeling them as acceptance.

Evidence must not contain credentials, authorization headers, tokens, raw
provider responses, or user clipboard/document contents beyond controlled test
fixtures. Report redacted hashes, IDs, dimensions, counts, and bounded fixture
values instead.

Coverage thresholds and waiver rules remain authoritative in
[tests/COVERAGE.md](../../tests/COVERAGE.md). Native evidence supplements
coverage; it does not lower a floor or create an implicit platform waiver.
