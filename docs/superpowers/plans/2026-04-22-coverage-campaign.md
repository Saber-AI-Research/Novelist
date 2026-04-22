# Coverage Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between Phase-1 coverage baseline (~20 %) and the honest achievable ceiling by writing precision/contract tests for every testable file in `app/lib/**`, waiving the genuinely untestable ones, and locking the new baseline as a CI hard threshold.

**Architecture:** One subagent-driven campaign on branch `test/coverage-campaign`. Task 1 audits and classifies every source file. Tasks 2+ write tests in batches (one batch per coherent module group). Final task locks thresholds and opens the PR.

**Tech Stack:** Vitest 4 + `@vitest/coverage-v8`; happy-dom env; Svelte 5 runes (`$state`, `$derived`); CM6 `EditorState` for pure editor tests; plain TS for utils.

**Spec:** `docs/superpowers/specs/2026-04-21-coverage-campaign-design.md`

---

## Global Rules (apply to every task)

1. **Work on branch `test/coverage-campaign`.** Do NOT switch branches.
2. **Never touch user's dirty files.** Before staging, run `git status --short` and confirm you're only staging paths you created or modified. Explicit paths only — never `git add -A` or `git add .`.
3. **Follow describe-tag conventions** from `docs/architecture/testing-precision.md`:
   - Pure function → `[precision]`
   - Public API boundary → `[contract]`
   - Past-bug reproducer → `[regression]`
4. **Every new test must assert at least one concrete behavior.** Never write `expect(module).toBeDefined()` as a whole test. If a file is genuinely too thin for a behavioral test, waive it instead.
5. **Small refactors OK** — extracting a pure helper for testability is allowed (pattern: `buildSelectionDecorations`). Larger refactors are out of scope; report as `BLOCKED`.
6. **Each batch = one commit.** Commit message format: `test(<area>): cover <module-group> (<N> tests)`.
7. **Use `EditorState.create()` for CM6 logic tests.** Never construct `new EditorView()` inside unit tests — those belong in `tests/integration/`.
8. **For store tests, import the store module directly** and drive its methods. Do not boot Svelte components.
9. **Mock IPC at the module boundary.** Use `vi.mock('$lib/ipc/commands', …)` when testing code that calls generated Tauri commands.
10. **If a test reveals a production bug:** fix the bug inside the batch, add a regression test, mention the fix in the commit message with the `[regression]` tag.

---

## Task 1: Audit source files

**Files:**
- Create: `tests/COVERAGE-AUDIT.md`

- [ ] **Step 1: Run fresh coverage and dump per-file table**

```bash
cd /Users/chivier/Documents/Projects/Novelist/Novelist-app
pnpm test:coverage 2>&1 | tee /tmp/cov-run.txt
```

- [ ] **Step 2: List every `app/lib/**/*.{ts,svelte.ts,svelte}` file**

```bash
find app/lib -type f \( -name '*.ts' -o -name '*.svelte' \) | sort > /tmp/source-files.txt
```

- [ ] **Step 3: Write `tests/COVERAGE-AUDIT.md`**

Classify every source file into one of six buckets: **covered**, **partial**, **precision-testable**, **contract-testable**, **integration-only**, **waive**. Use this template:

```markdown
# Coverage Audit — 2026-04-22

Generated from `pnpm test:coverage` + manual source-file classification.
Informs the batches in `docs/superpowers/plans/2026-04-22-coverage-campaign.md`.

## Baseline before campaign

| Metric | Pre-campaign |
|---|---|
| Lines | 24.21 % |
| Functions | 16.14 % |
| Branches | 23.34 % |
| Statements | 19.64 % |

## Classification

### Covered (≥ 70 % lines)

| File | Current % Lines | Test file |
|---|---|---|
| app/lib/editor/selection-line.ts | 100 % | tests/unit/editor/selection-line.test.ts |
| app/lib/editor/large-file.ts | 100 % | tests/unit/editor/large-file.test.ts |
| _(…rest…)_ | | |

### Partial (< 70 % lines, has test)

| File | Current % Lines | Test file | Likely gap |
|---|---|---|---|
| app/lib/editor/formatting.ts | 78 % | tests/unit/editor/formatting.test.ts | _(fill in)_ |
| _(…rest…)_ | | | |

### Precision-testable (no test, pure logic)

| File | Rationale |
|---|---|
| app/lib/editor/viewport.ts | Pure coord math, no DOM construction |
| _(…rest…)_ | |

### Contract-testable (no test, narrow boundary)

| File | Rationale | Mock boundary |
|---|---|---|
| app/lib/services/new-file.ts | IPC wrapper | `vi.mock('$lib/ipc/commands')` |
| _(…rest…)_ | | |

### Integration-only (needs `EditorView` / Svelte render / Tauri runtime)

| File | Rationale | Action |
|---|---|---|
| app/lib/editor/setup.ts | Composes full CM6 extension pack | Move gaps to tests/integration or waive portions |
| _(…rest…)_ | | |

### Waive (not worth testing here)

| Path | Category | Reason |
|---|---|---|
| app/lib/components/**/*.svelte | UI | e2e (Playwright) covers these; no Svelte-component unit tests in scope. |
| app/lib/ipc/commands.ts | Auto-generated | already waived |
| app/lib/services/updater.ts | Platform | Tauri updater, requires real runtime |
| _(…rest…)_ | | |

## Batch assignments

| Batch | Files |
|---|---|
| A — stores | extensions.svelte.ts, commands.svelte.ts, any partial store bumps |
| B — utils | benchmark, go-to-line, resize-drag, startup-timing, window-drag, chinese, scroll-edit-test |
| C — editor pure | viewport, section-move, outline, annotations, languages; improve themes |
| D — composables | app-events, app-lifecycle, close-tab, editor-context-menu, window-title |
| E — services | services/new-file.ts |
| F — app/lib root | app-commands.ts, event-handlers.ts, keyboard-router.ts (if any) |
| G — partial improvements | setup, wysiwyg, markdown-extensions, mermaid, math, zen, formatting |
```

- [ ] **Step 4: Commit the audit**

```bash
git add tests/COVERAGE-AUDIT.md
git commit -m "test(coverage): audit + batch assignment for campaign"
```

---

## Task 2: Apply waivers

**Files:**
- Modify: `vitest.config.ts`
- Modify: `tests/COVERAGE.md`

- [ ] **Step 1: Translate audit "waive" rows into `coverage.exclude`**

In `vitest.config.ts`, extend the existing `coverage.exclude` array with globs from the audit. Typical additions:

```ts
exclude: [
  "app/lib/ipc/commands.ts",
  "app/lib/**/*.d.ts",
  "tests/**",
  "node_modules/**",
  // added by coverage campaign:
  "app/lib/components/**/*.svelte",
  "app/lib/services/updater.ts",
  // (…whatever else the audit produced)
],
```

Also **narrow `coverage.include`** to TypeScript only so Svelte components don't sit in the denominator:

```ts
include: ["app/lib/**/*.ts"],
```

- [ ] **Step 2: Append to `tests/COVERAGE.md` "Active Waivers" table**

One row per new waiver. Each row must cite category and reason (from audit).

- [ ] **Step 3: Re-run coverage to confirm denominator shrank**

```bash
pnpm test:coverage 2>&1 | grep "All files"
```

Record the new `All files` row — baseline will now be higher because the waived UI isn't dragging the denominator.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tests/COVERAGE.md
git commit -m "test(coverage): apply campaign waivers (Svelte components + platform code)"
```

---

## Task 3 (Batch A): Stores

**Files (provisional — audit may adjust):**
- Test: `tests/unit/stores/extensions.test.ts`
- Test: `tests/unit/stores/commands.test.ts`
- Possibly: bump existing partial-coverage stores to ≥ 80 % lines

- [ ] **Step 1: For each file in Batch A, write a `[contract]` test suite**

For `extensions.svelte.ts`: drive its public methods, assert the rune state changes. Mock IPC if needed. Cover: register/unregister/list/toggle/persist.

For `commands.svelte.ts` (the `commandRegistry`): register commands, execute them, verify lookup by id, verify duplicate-id guard.

Example test skeleton for `commands.svelte.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { commandRegistry } from '$lib/stores/commands.svelte';

describe('[contract] commandRegistry', () => {
  beforeEach(() => commandRegistry.clear());

  it('registers a command and executes it by id', async () => {
    let fired = false;
    commandRegistry.register({ id: 'test.foo', run: () => { fired = true; } });
    await commandRegistry.execute('test.foo');
    expect(fired).toBe(true);
  });

  it('rejects duplicate ids', () => {
    commandRegistry.register({ id: 'test.dup', run: () => {} });
    expect(() =>
      commandRegistry.register({ id: 'test.dup', run: () => {} })
    ).toThrow();
  });

  // …etc
});
```

(Adapt to actual public shape — read the source first.)

- [ ] **Step 2: Run and verify**

```bash
pnpm test:unit tests/unit/stores/
```

All new tests pass, no regression in existing store tests.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/stores/
git commit -m "test(stores): contract tests for extensions + commands stores (N tests)"
```

---

## Task 4 (Batch B): Utils

**Files (provisional):**
- `app/lib/utils/benchmark.ts`
- `app/lib/utils/go-to-line.ts`
- `app/lib/utils/resize-drag.ts`
- `app/lib/utils/startup-timing.ts`
- `app/lib/utils/window-drag.ts`
- `app/lib/utils/chinese.ts`
- `app/lib/utils/scroll-edit-test.ts`

Skip any that the audit re-classified as **waive** (e.g., `scroll-edit-test.ts` if it's a dev/manual harness).

- [ ] **Step 1: Per file, write a `[precision]` test**

Pure TS utilities — drive inputs/outputs directly. Focus on branch coverage (empty input, large input, CJK input for any text helper, off-by-one cases).

- [ ] **Step 2: Run**

```bash
pnpm test:unit tests/unit/utils/
```

- [ ] **Step 3: Commit**

```bash
git add tests/unit/utils/
git commit -m "test(utils): precision tests for uncovered utils (N tests)"
```

---

## Task 5 (Batch C): Editor pure helpers

**Files (provisional):**
- `app/lib/editor/viewport.ts` — pure coord math, ranges
- `app/lib/editor/section-move.ts` — heading-block selection
- `app/lib/editor/outline.ts` — heading tree extraction
- `app/lib/editor/annotations.ts` — tiny, only ~7 uncovered lines
- `app/lib/editor/languages.ts` — factory functions
- Bump `app/lib/editor/themes.ts` toward ≥ 80 %

- [ ] **Step 1: For each file, extract a pure function if mixed**

If the module exposes `somePlugin = ViewPlugin.fromClass(...)` but the interesting logic is a helper, extract the helper with an exported name and write the test against it. Same pattern as `buildSelectionDecorations`.

- [ ] **Step 2: Write `[precision]` tests**

Drive the pure helpers with `EditorState.create(...)` when CM6 types are needed. Assert structural equality on decoration sets / outline trees / range lists.

- [ ] **Step 3: Run**

```bash
pnpm test:unit tests/unit/editor/
```

- [ ] **Step 4: Commit**

```bash
git add app/lib/editor/ tests/unit/editor/
git commit -m "test(editor): precision tests for viewport/section-move/outline/annotations/languages (N tests)"
```

---

## Task 6 (Batch D): Composables

**Files (provisional):**
- `app/lib/composables/app-events.svelte.ts`
- `app/lib/composables/app-lifecycle.svelte.ts`
- `app/lib/composables/close-tab.svelte.ts`
- `app/lib/composables/editor-context-menu.svelte.ts`
- `app/lib/composables/window-title.svelte.ts`

- [ ] **Step 1: Write `[contract]` tests**

Composables own `$state`/`$effect` and are initialized from component `onMount`. Test by importing the factory (`createX` / `useX` / `wireX`), invoking it with mock dependencies, and asserting the rune state + side effects.

Mock at module boundaries: IPC commands, event listeners (`document.addEventListener`), store imports.

- [ ] **Step 2: Run**

```bash
pnpm test:unit tests/unit/composables/
```

- [ ] **Step 3: Commit**

```bash
git add tests/unit/composables/
git commit -m "test(composables): contract tests for app-events/app-lifecycle/close-tab/editor-context-menu/window-title (N tests)"
```

---

## Task 7 (Batch E): Services

**Files (provisional):**
- `app/lib/services/new-file.ts`

- [ ] **Step 1: Write `[contract]` test**

Mock IPC (`vi.mock('$lib/ipc/commands')`), drive the public `createNewFile` / whatever the public shape is, assert: file-path derivation, H1 auto-rename coupling, error propagation.

- [ ] **Step 2: Run**

```bash
pnpm test:unit tests/unit/services/
```

- [ ] **Step 3: Commit**

```bash
git add tests/unit/services/
git commit -m "test(services): contract tests for new-file service (N tests)"
```

---

## Task 8 (Batch F): `app/lib` root

**Files (provisional):**
- `app/lib/app-commands.ts` — the sole `commandRegistry.register` site (per CLAUDE.md)
- `app/lib/event-handlers.ts`
- any other root-level wiring identified by the audit (except auto-generated `ipc/commands.ts`)

- [ ] **Step 1: Write `[contract]` tests**

For `app-commands.ts`: assert every registered command id is present in the registry after module import. Drive a handful of commands through their `run` fn with mock stores.

For `event-handlers.ts`: if it wires window/document listeners, test by mocking event targets.

- [ ] **Step 2: Run**

```bash
pnpm test:unit tests/unit/
```

- [ ] **Step 3: Commit**

```bash
git add tests/unit/
git commit -m "test(app): contract tests for app-commands + event-handlers (N tests)"
```

---

## Task 9 (Batch G): Raise partial-coverage modules toward 80 %

For each file the audit put in **partial** with < 70 % line coverage, add targeted tests covering the uncovered line ranges reported by v8. Typical candidates:

- `app/lib/editor/setup.ts` (currently ~37 % — much of it is CM6 extension composition, may only lift modestly)
- `app/lib/editor/wysiwyg.ts` (~42 %)
- `app/lib/editor/markdown-extensions.ts` (~49 %)
- `app/lib/editor/mermaid.ts` (~28 %)
- `app/lib/editor/math.ts` (~65 %)
- `app/lib/editor/zen.ts` (~5 %)
- `app/lib/editor/formatting.ts` (~78 %)

- [ ] **Step 1: For each file, look at v8's `Uncovered Line #s` column**

```bash
pnpm test:coverage 2>&1 | grep -A0 '<filename>'
```

Pick 2–5 uncovered behaviors you can test as pure functions. **Skip** any that require `EditorView` mounting — log those as "needs integration test, deferred" in `COVERAGE-AUDIT.md`.

- [ ] **Step 2: Add tests to the existing `.test.ts` file** (or create one if partial means "no test at all, but listed as partial by accident")

- [ ] **Step 3: Run and commit**

```bash
pnpm test:unit
git add tests/unit/editor/
git commit -m "test(editor): raise partial-coverage modules (N tests)"
```

---

## Task 10: Lock thresholds

- [ ] **Step 1: Run fresh coverage**

```bash
pnpm test:coverage 2>&1 | grep "All files"
```

Capture the four post-campaign numbers.

- [ ] **Step 2: Compute thresholds = achieved − 2 pt** (round down to integer)

- [ ] **Step 3: Edit `vitest.config.ts`**

Replace the "Thresholds deferred" comment with:

```ts
coverage: {
  // …existing fields…
  thresholds: {
    lines: <achieved_lines - 2>,
    functions: <achieved_funcs - 2>,
    branches: <achieved_branches - 2>,
    statements: <achieved_stmts - 2>,
  },
},
```

- [ ] **Step 4: Update `tests/COVERAGE-BASELINE.md`**

Add a new "Post-campaign baseline (2026-04-22)" section. Record achieved numbers and the `-2` thresholds. Note per-metric gap to aspirational 80/85/70/80. If a metric exceeds aspirational, delete its row from "Deferred Gaps".

- [ ] **Step 5: Verify the threshold fires**

Temporarily comment out 2–3 tests, run `pnpm test:coverage`, confirm it fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts tests/COVERAGE-BASELINE.md
git commit -m "test(coverage): lock thresholds at post-campaign baseline minus 2pt"
```

---

## Task 11: Update docs + final CI verification

- [ ] **Step 1: Update `CLAUDE.md`**

Add a line to the "Architecture Deep Dives" table pointing at `tests/COVERAGE-AUDIT.md`. Ensure the Phase-1 entries are still valid.

- [ ] **Step 2: Update `tests/COVERAGE-BASELINE.md`**

Delete the now-obsolete "Phase-1 target — deferred" paragraph (or rewrite to reflect campaign outcome).

- [ ] **Step 3: Run the whole suite end-to-end**

```bash
pnpm test && pnpm test:coverage && pnpm test:e2e:browser
```

Everything green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md tests/COVERAGE-BASELINE.md
git commit -m "docs(coverage): link audit + refresh baseline narrative"
```

---

## Task 12: PR + merge

- [ ] **Step 1: Push**

```bash
git push -u origin test/coverage-campaign
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --head test/coverage-campaign \
  --title "test: coverage campaign — per-module tests + locked thresholds" \
  --body "<body with summary, achieved numbers, waiver list, test plan checklist>"
```

Body template:

```markdown
## Summary

- Classified every `app/lib/**/*.ts` file into covered/partial/testable/waived buckets (see `tests/COVERAGE-AUDIT.md`)
- Added <N> new test files / <M> new tests across stores, utils, editor helpers, composables, services, and `app-commands.ts`
- Waived UI `.svelte` components + platform code (Tauri updater); denominator now reflects testable TS only
- Locked CI thresholds at achieved baseline − 2 pt per metric:

| Metric | Pre | Post | Threshold |
|---|---|---|---|
| Lines | 24.21 % | <X> % | <X−2> % |
| Functions | 16.14 % | <X> % | <X−2> % |
| Branches | 23.34 % | <X> % | <X−2> % |
| Statements | 19.64 % | <X> % | <X−2> % |

Spec: `docs/superpowers/specs/2026-04-21-coverage-campaign-design.md`
Plan: `docs/superpowers/plans/2026-04-22-coverage-campaign.md`

## Test plan

- [ ] CI `Vitest (with coverage)` step green
- [ ] Threshold-enforcement verified locally by temporarily disabling a covered test (restored before merge)
- [ ] `vitest-coverage` artifact downloadable
- [ ] No production code changed except targeted pure-helper extractions (cite commits if any)
```

- [ ] **Step 3: Merge after CI green**

```bash
gh pr merge --merge --auto
```

- [ ] **Step 4: Clean up branch**

```bash
git checkout main && git pull --ff-only origin main
git branch -D test/coverage-campaign
git push origin --delete test/coverage-campaign
```

---

## Self-Review

Spec coverage: ✅ audit (Task 1) → waivers (Task 2) → batches A–G (Tasks 3–9) → lock (Task 10) → ship (Tasks 11–12). Matches spec §Approach steps 1–5.

Placeholders: _"(fill in)"_ rows in the audit template are intentional — they get filled by Task 1's subagent from real data. `<N>` / `<X>` placeholders in commit messages and PR body are filled from actual tallies.

Type consistency: all tests named after modules they cover; all describe labels carry a tag (`[precision]` or `[contract]`); no invented tag names.
