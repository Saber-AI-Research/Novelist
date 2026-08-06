# Novelist Test Suite

Last updated: 2026-08-06

Novelist uses a three-tier test strategy: fast Vitest suites, browser E2E
with mocked Tauri IPC, and Rust backend tests. Use the root harness when you
want a repeatable local gate.

## Suite Shape

| Layer | Scope | Command |
|---|---|---|
| Frontend unit | Pure helpers, stores, and narrow module contracts | `pnpm test:unit` |
| Frontend integration | DOM and real CodeMirror runtime contracts | `pnpm test:integration` |
| Browser E2E | User workflows with mocked Tauri IPC | `pnpm test:e2e:browser` |
| Rust backend | Commands, services, persistence, and platform logic | `pnpm test:rust` |

Counts are intentionally not pinned here. They drift with product behavior and
are not a quality target; the commands above are the source of truth.

## Harness Commands

```bash
pnpm verify:quick     # Svelte check + Vitest unit/integration
pnpm verify:coverage  # Coverage gate
pnpm verify:e2e       # Playwright browser E2E
pnpm verify:rust      # Rust fmt + clippy + tests
pnpm verify:ci        # Local CI mirror
```

## When Adding Tests

- Pure helpers, stores, and command registry behavior go in `tests/unit/`.
- CodeMirror runtime behavior that needs a DOM goes in `tests/integration/`.
- User workflows go in `tests/e2e/specs/` and should use `data-testid`.
- New IPC calls used by browser E2E need handlers in
  `tests/e2e/fixtures/tauri-mock.ts`.
- Browser-intercepted shortcuts should use the app's `window.__test_api__`
  bridge.

## Keeping the Suite Lean

- Keep one authoritative input-partition matrix for a pure validator. Callers
  need a representative public-boundary test, not a copy of every validator
  case.
- Remove narrative variants that execute the same production branch and assert
  the same result. Preserve unique regression reproducers, CJK/IME cases,
  persistence migrations, and failure/cleanup boundaries.
- Do not add runtime tests whose only claim is that a TypeScript assignment
  compiles; `pnpm check` owns that contract.
- Treat runtime and diagnostic quality as the optimization signal. A compact
  table of meaningful edge cases is preferable to either one assertion per
  spelling variant or one opaque mega-test.
- After pruning, run `pnpm test:coverage`. Coverage floors never move downward
  to accommodate a smaller suite.

See [../docs/design-docs/testing.md](../docs/design-docs/testing.md),
[../docs/design-docs/testing-precision.md](../docs/design-docs/testing-precision.md),
and [COVERAGE.md](COVERAGE.md).
