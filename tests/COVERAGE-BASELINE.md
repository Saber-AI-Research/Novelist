# Coverage Baseline

Captured **2026-04-21** on branch `test/phase-1-hierarchy` after the
P1 hierarchy split (commits `c7c0393` and earlier). These numbers represent
the current baseline coverage — P1 ships reports-only; threshold enforcement
is deferred to later phases.

| Metric      | Baseline |
|-------------|----------|
| Lines       | 24.21 %  |
| Functions   | 16.14 %  |
| Branches    | 23.34 %  |
| Statements  | 19.64 %  |

## How to reproduce

```
pnpm test:coverage
```

Text reporter prints the summary; HTML output lands in `coverage/index.html`
(git-ignored).

## Phase-1 target — deferred to later phases

Phase-1 ships **reports-only**: `pnpm test:coverage` runs in CI and
uploads coverage as a build artifact, but does NOT fail the build on
threshold breach. Aspirational targets remain:

| Metric      | Aspirational target |
|-------------|---------------------|
| Lines       | 80 %                |
| Functions   | 85 %                |
| Branches    | 70 %                |
| Statements  | 80 %                |

The baseline above (≈20 %) is far below those targets. Closing the
gap requires writing tests against the 0-coverage modules first
(services/new-file.ts, canvas/kanban components, viewport.ts, zen.ts,
outline.ts, multiple utils). That work is scoped into P2–P7 (see
`docs/superpowers/specs/2026-04-21-test-hierarchy-and-coverage-design.md`).

Once a later phase brings baseline to within ~5 pt of an aspirational
target, enable the vitest threshold for that metric in
`vitest.config.ts` and delete its row from the "Deferred Gaps"
section below.

## Deferred Gaps

All four metrics currently gap their aspirational targets:

| Metric      | Baseline | Target | Gap       | Closing work |
|-------------|----------|--------|-----------|--------------|
| Lines       | 24.21 %  | 80 %   | –56 pt    | P2–P7 per-module tests |
| Functions   | 16.14 %  | 85 %   | –69 pt    | P2–P7 per-module tests |
| Branches    | 23.34 %  | 70 %   | –47 pt    | P2–P7 per-module tests |
| Statements  | 19.64 %  | 80 %   | –60 pt    | P2–P7 per-module tests |
