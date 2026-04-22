# Coverage Campaign Design

**Date:** 2026-04-21
**Branch:** `test/coverage-campaign`
**Supersedes:** Phases P2–P7 in `2026-04-21-test-hierarchy-and-coverage-design.md` §6

## Problem

Phase-1 shipped the test-hierarchy scaffolding and captured a baseline:
- Lines **24.21 %** / Functions **16.14 %** / Branches **23.34 %** / Statements **19.64 %**
- Aspirational targets (80 / 85 / 70 / 80) are ~50–70 pt away
- The original spec split the closure work across six per-module phases (P2–P7)

User pushback: six phases is bureaucracy. The work is one continuous
test-writing campaign; splitting by module category buys no checkpoint
value (we don't learn anything between "finish stores" and "start
utils" that changes plans). Collapse P2–P7 into one campaign, one
branch, one PR.

## Goals

1. **Write precision/contract tests for every `app/lib/**/*.{ts,svelte.ts}` file that can reasonably be tested as pure logic.**
2. **Waive files that genuinely require a runtime we can't easily simulate** — UI `.svelte` components, Tauri platform bridges, auto-generated shims. Waivers land in `tests/COVERAGE.md` with reasons.
3. **Lock in the actual achieved baseline as the CI threshold** (minus a 2 pt cushion per metric). The threshold becomes a real gate — regressions fail CI.
4. **Do it in one subagent-driven session without pause points.** User approved continuous execution.

## Non-Goals

- **Do not force 80 %.** Write tests for what's testable; accept the resulting number. Inflating coverage with shallow tests (`it('imports', () => expect(mod).toBeDefined())`) is worse than a low number.
- **Do not retrofit DOM/component tests.** `.svelte` files stay waived unless an existing test already covers them. Real UI testing is e2e (Playwright), scheduled separately.
- **Do not refactor production code for testability** unless a pure-helper extraction is small and clearly an improvement (same pattern used for `buildSelectionDecorations`). Larger refactors are out of scope.
- **Do not invent new describe tags.** Reuse `[precision]` / `[contract]` / `[regression]` / `[smoke]` from `docs/architecture/testing-precision.md`.

## Approach

### Step 1 — Audit

One subagent runs a full audit and writes `tests/COVERAGE-AUDIT.md`
classifying every source file into:

| Bucket | Definition |
|---|---|
| **covered** | Already has a test, coverage ≥ 70 % lines. |
| **partial** | Has a test but coverage < 70 %. Candidate for test additions. |
| **precision-testable** | No test, pure logic, can be tested with `EditorState` / plain TS / store rune state transitions. |
| **contract-testable** | No test, has side-effects or depends on a narrow boundary (IPC, DOM event), testable by mocking at the boundary. |
| **integration-only** | Needs `EditorView` wiring, component rendering, Tauri runtime, or multi-store orchestration. Moves to `tests/integration/**` or waived. |
| **waive** | Not worth the effort: UI Svelte components (e2e territory), platform bridges, auto-generated code. Reason recorded. |

### Step 2 — Waivers

Add every **waive** bucket path to `vitest.config.ts` `coverage.exclude` and append a row to `tests/COVERAGE.md` with category + reason. This lifts the coverage denominator off pointless targets and lets the lock-in threshold reflect real testable code.

### Step 3 — Test-writing batches

Dispatch subagents per batch. Each batch picks a coherent group of files from the audit (a directory, or a set of related modules) and writes tests one file at a time following TDD discipline:

1. Read the module.
2. Extract a pure helper if the file mixes pure logic with side effects.
3. Write a `[precision]` or `[contract]` test file under `tests/unit/**` (or `tests/integration/**` if DOM required).
4. Run the test, confirm pass.
5. Commit with a focused message.

Batch boundaries (provisional — audit may shift files between batches):

| Batch | Files (approximate) |
|---|---|
| A — stores | `extensions`, `commands`, any partial store tests bumped to ≥ 80 % |
| B — utils | remaining uncovered utils (`benchmark`, `go-to-line`, `resize-drag`, `startup-timing`, `window-drag`, `chinese`, `scroll-edit-test`) |
| C — editor pure | `viewport`, `section-move`, `outline`, `annotations`, `languages`, improvements to `themes` |
| D — composables | `app-events`, `app-lifecycle`, `close-tab`, `editor-context-menu`, `window-title` |
| E — services | `services/new-file.ts` |
| F — root of app/lib | `app-commands.ts`, `event-handlers.ts`, `keyboard-router.ts` (if it exists), shortcut routing glue |
| G — partial improvements | `setup`, `wysiwyg`, `markdown-extensions`, `mermaid`, `math`, `zen`, `formatting` where line coverage < 70 % |

### Step 4 — Lock thresholds

Re-run `pnpm test:coverage`. Record the new baseline in `tests/COVERAGE-BASELINE.md`. Set `vitest.config.ts` `coverage.thresholds` to `(achieved − 2)` per metric, round down. Delete the "Deferred Gaps" table (or rename to "Post-Campaign Gaps" and note which metrics fell short of 80).

### Step 5 — Ship

Open PR against `main`, review, merge.

## Success Criteria

- Every `app/lib/**/*.{ts,svelte.ts}` file either has a test **or** is in the waiver list with a cited category and reason.
- `vitest.config.ts` has a real `coverage.thresholds` block that is 2 pt below the achieved baseline.
- CI fails on coverage regression (verified by temporarily reducing a covered function's test).
- Total test count grows by tens or hundreds of new tests, but not so many that the test suite runs slower than ~5 s for unit / ~10 s for integration.
- No production code was refactored beyond extracting pure helpers when clearly beneficial.

## Risks

| Risk | Mitigation |
|---|---|
| Target 80 % unreachable → thresholds lock in a mediocre number | Honest. Spec explicitly permits this. Record gap, future work closes it. |
| Subagent writes shallow "import ok" tests to pad numbers | Dispatcher prompt requires each new test to assert at least one concrete behavior. Review rejects padding. |
| Test-writing reveals a production bug | Fix the bug in the same batch; extend the test to cover the regression. Add `[regression]` tag. |
| Subagent tries to test a Svelte component, gets stuck | Dispatcher tells them upfront to only write `.ts` tests; components are waived. |
| Coverage tool misclassifies Svelte files under `include: ['app/lib/**/*.svelte']` | If components are all waived, they shouldn't be in the denominator. Adjust `coverage.include` to `app/lib/**/*.ts` only. |
| Commit/PR ceremony becomes the bottleneck | Each batch is one commit. PR only opens at the end. |

## Open Questions

None — user approved:
- One-shot spec + plan
- Continuous execution (no mid-campaign status stops)
- Hit-what-we-can-honestly, waive-the-rest, lock real baseline
