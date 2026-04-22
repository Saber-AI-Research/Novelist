# Coverage Baseline

Captured **2026-04-22** on branch `test/coverage-campaign` after the
2026-04-22 one-shot coverage campaign (C3–C9). These numbers represent
the enforced baseline; `vitest.config.ts` fails the build whenever any
metric dips below the floor.

| Metric      | Achieved | Enforced floor |
|-------------|----------|----------------|
| Lines       | 77.25 %  | 75 %           |
| Functions   | 77.84 %  | 75 %           |
| Branches    | 69.67 %  | 67 %           |
| Statements  | 76.02 %  | 73 %           |

Floors sit 2 pp below the achieved numbers so a typical refactor doesn't
trip the gate, but meaningful regressions will. Raise the floor when we
have headroom. Never lower it — if these fail, fix the tests.

## How to reproduce

```
pnpm test:coverage
```

Text summary prints to the terminal. HTML output lands in
`coverage/index.html` (git-ignored).

## Campaign history

| Date       | Lines    | Branches | Functions | Statements | Notes |
|------------|----------|----------|-----------|------------|-------|
| 2026-04-21 | 24.21 %  | 23.34 %  | 16.14 %   | 19.64 %    | P1 hierarchy split baseline (reports-only) |
| 2026-04-22 | 77.25 %  | 69.67 %  | 77.84 %   | 76.02 %    | Post-campaign baseline (thresholds live) |

## Per-module headroom (post-campaign)

The 2026-04-22 campaign hit every source file except a small set that
remains hard to reach from Vitest. These show up in the `% Lines` column
below their siblings — the uplift is real; the residual lives where
Vitest cannot follow without a full CM6 environment.

| Area               | Lines  | Next uplift idea |
|--------------------|--------|------------------|
| `lib/services`     | 100 %  | — |
| `lib/i18n`         | 100 %  | — |
| `lib/utils`        | 96.7 % | Scroll-edit / benchmark are waived. |
| `lib/composables`  | 93.0 % | `window-title` `$effect` needs Svelte runtime. |
| `lib/stores`       | 90.7 % | Hot paths covered; residual is edge-case branches. |
| `lib/editor`       | 61.9 % | `wysiwyg.ts` / `setup.ts` / `mermaid.ts` / `viewport.ts` — large CM6-coupled modules best tested via E2E. |
| `ai-agent` panel   | 45.9 % | `sessions.svelte.ts` — Svelte runtime / Tauri event round-trip. |
| `ai-talk` panel    | 88.8 % | — |

See `tests/COVERAGE.md` for the per-category waiver table.

## Running the enforcement gate locally

```
pnpm test:coverage
```

A non-zero exit means one of the four thresholds breached. Re-run with
`--reporter=html` and open `coverage/index.html` to inspect which file
regressed.
