# Coverage Baseline

Captured **2026-04-21** on branch `test/phase-1-hierarchy` after the
P1 hierarchy split (commits `c7c0393` and earlier). These numbers are
the floor — Task 14 will enable thresholds at or slightly below these
values to prevent regressions.

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

## Phase-1 target (Task 14)

| Metric      | Target |
|-------------|--------|
| Lines       | 80 %   |
| Functions   | 85 %   |
| Branches    | 70 %   |
| Statements  | 80 %   |

If any baseline above is below its target, Task 14 lowers the
threshold to `(baseline − 2)` and records the gap here in a new
"Deferred Gaps" section so a later phase can close it.

## Deferred Gaps

_(populated by Task 14 if any baseline falls short of the target)_
