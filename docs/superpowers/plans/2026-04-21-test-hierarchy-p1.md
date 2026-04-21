# Test Hierarchy & Coverage — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the test-hierarchy + coverage governance infrastructure defined in `docs/superpowers/specs/2026-04-21-test-hierarchy-and-coverage-design.md` — directory split, vitest multi-env config, policy docs, baseline coverage, CI gate. No new test content beyond re-tagging existing tests.

**Architecture:** Split `tests/unit/` (node env, pure) from `tests/integration/` (happy-dom env, boots CM6). Move four existing runtime tests into integration. Add `@vitest/coverage-v8` with explicit thresholds and a waiver list. Ship as one commit set under a single PR.

**Tech Stack:** vitest 4.x (already installed), happy-dom 20.x (already installed), `@vitest/coverage-v8` (to be added), GitHub Actions (macOS + Linux runners).

**Spec reference:** `docs/superpowers/specs/2026-04-21-test-hierarchy-and-coverage-design.md`

**Scope boundary:** This plan covers only Phase 1 (§6 of spec). Phases 2–7 (per-module precision audits + test-writing) get their own plans, triggered once P1 ships.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `vitest.config.ts` | **Create** | Single source of vitest config, exports two "projects" (unit / integration). Replaces inline `test:` block in `vite.config.ts`. |
| `vite.config.ts` | **Modify** | Remove the `test:` block (moved to vitest.config.ts). |
| `package.json` | **Modify** | Add `test:integration`, `test:coverage`; keep existing `test` + `test:unit` semantics. |
| `tests/integration/` | **Create** (dir) | Happy-dom + CM6-view tests. |
| `tests/integration/editor/wysiwyg-runtime.test.ts` | **Move** from `tests/unit/editor/` | No content change. |
| `tests/integration/editor/slash-runtime.test.ts` | **Move** from `tests/unit/editor/` | No content change. |
| `tests/integration/editor/image-rendering.test.ts` | **Move** from `tests/unit/editor/` | No content change. |
| `tests/integration/editor/image-block-deco.test.ts` | **Move** from `tests/unit/editor/` | No content change. It is a state-machine model but uses happy-dom context per comments. |
| `tests/fixtures/` | **Create** (dir, empty) | Reserved for shared helpers in P2+. Must exist so later PRs can add files without ambiguity. |
| `tests/fixtures/.gitkeep` | **Create** | Makes empty dir tracked. |
| `tests/COVERAGE.md` | **Create** | Waiver registry per spec §3. |
| `docs/architecture/testing-precision.md` | **Create** | Precision-testing discipline per spec §5. |
| `CLAUDE.md` | **Modify** | Link the two new docs. |
| `.github/workflows/ci.yml` | **Modify** | Add `pnpm test:coverage` step. |
| `tests/unit/editor/selection-line.test.ts` | **Modify** | Re-tag describe block as `[precision][regression]`. |
| `tests/unit/editor/image-block-deco.test.ts` | **Modify** | Re-tag top describes. (See above — file is being moved; re-tag happens after the move.) |

---

## Task 1: Verify integration-test candidate uses happy-dom

**Files:**
- Read: `tests/unit/editor/image-block-deco.test.ts` (decide if it belongs in unit or integration)

- [ ] **Step 1: Read the file header to confirm runtime env dependency**

Run: `head -40 tests/unit/editor/image-block-deco.test.ts`

Expected: the docstring either says it's a "state-machine model" (→ unit) or that it instantiates `EditorView` / uses DOM (→ integration). The header will make the decision.

Decision rule:
- If file calls `new EditorView(...)` or `document.createElement(...)` → **integration** (move in Task 5).
- If it only models CM6's logic as pure state transitions → **unit** (don't move).

- [ ] **Step 2: Record the decision**

Write the decision to this plan as a comment under the Task 5 heading (via the same file; no separate commit).

Decision matters because Task 5's move list depends on it.

---

## Task 2: Install coverage provider

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dev dependency**

Run: `pnpm add -D @vitest/coverage-v8`

Expected: `package.json` gains `"@vitest/coverage-v8": "^<version>"` in `devDependencies`; `pnpm-lock.yaml` updates.

- [ ] **Step 2: Sanity-check vitest can load the provider**

Run: `pnpm exec vitest --help | grep -i coverage`

Expected: help text mentions `--coverage` flag.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(test): add @vitest/coverage-v8 dev dep"
```

---

## Task 3: Create dedicated `vitest.config.ts`

**Files:**
- Create: `vitest.config.ts`

- [ ] **Step 1: Write the new config**

Contents:

```ts
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

/**
 * Vitest is configured as a separate file (not under `vite.config.ts`'s
 * `test:` key) so that:
 * - We can run two projects (unit / integration) with different envs.
 * - `pnpm test:coverage` can live alongside these without polluting the
 *   Vite build config.
 *
 * Plugins: only `svelte()`. The full Tailwind + manualChunks plumbing in
 * `vite.config.ts` is for the app bundle and is irrelevant for vitest.
 */
export default defineConfig({
  plugins: [svelte({ hot: !process.env.VITEST })],
  resolve: {
    alias: { $lib: resolve('./app/lib') },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'happy-dom',
          include: ['tests/integration/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['app/lib/**/*.{ts,svelte}'],
      exclude: [
        'app/lib/ipc/commands.ts',
        'app/lib/utils/benchmark.ts',
        'app/lib/utils/scroll-edit-test.ts',
        'app/lib/utils/startup-timing.ts',
        'app/lib/utils/window-drag.ts',
        'app/lib/utils/resize-drag.ts',
        'app/lib/composables/app-events.svelte.ts',
        'app/lib/composables/app-lifecycle.svelte.ts',
        '**/*.d.ts',
      ],
      // Thresholds DISABLED at first run; enabled after baseline in Task 14.
      // thresholds: { lines: 80, functions: 85, branches: 70, statements: 80 },
    },
  },
});
```

- [ ] **Step 2: Remove the `test:` block from `vite.config.ts`**

Edit `vite.config.ts`: delete these lines:

```ts
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "happy-dom",
  },
```

- [ ] **Step 3: Run the existing test suite to confirm nothing broke yet**

Run: `pnpm test`

Expected: Same 635 tests pass (no files moved yet, but now under the 'unit' project name). The unit project is `environment: 'node'` now — several tests may fail because they implicitly used happy-dom. That's OK for now — the failures will reveal which tests must move to integration (see Task 5). Record failing file paths.

If more than the 4 files identified in Task 5 fail, STOP and surface the extra files to the user before moving them — the spec's migration scope assumed 4.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts vite.config.ts
git commit -m "chore(test): extract vitest config, add unit/integration projects"
```

---

## Task 4: Create `tests/integration/` skeleton

**Files:**
- Create: `tests/integration/editor/` (dir)
- Create: `tests/fixtures/` (dir)
- Create: `tests/fixtures/.gitkeep`

- [ ] **Step 1: Make the directories**

Run: `mkdir -p tests/integration/editor tests/fixtures && touch tests/fixtures/.gitkeep`

- [ ] **Step 2: Verify empty dir is trackable**

Run: `ls -la tests/integration/editor tests/fixtures`

Expected: both dirs exist; `tests/fixtures/` contains `.gitkeep`. `tests/integration/editor/` may be empty — git will track it after Task 5 moves a file in.

---

## Task 5: Move runtime tests into integration

**Files:**
- Move: `tests/unit/editor/wysiwyg-runtime.test.ts` → `tests/integration/editor/wysiwyg-runtime.test.ts`
- Move: `tests/unit/editor/slash-runtime.test.ts` → `tests/integration/editor/slash-runtime.test.ts`
- Move: `tests/unit/editor/image-rendering.test.ts` → `tests/integration/editor/image-rendering.test.ts`
- Conditionally move: `tests/unit/editor/image-block-deco.test.ts` (decision from Task 1)

- [ ] **Step 1: Move using git to preserve history**

Run:
```bash
git mv tests/unit/editor/wysiwyg-runtime.test.ts tests/integration/editor/wysiwyg-runtime.test.ts
git mv tests/unit/editor/slash-runtime.test.ts tests/integration/editor/slash-runtime.test.ts
git mv tests/unit/editor/image-rendering.test.ts tests/integration/editor/image-rendering.test.ts
```

If Task 1 decided `image-block-deco.test.ts` also belongs to integration:
```bash
git mv tests/unit/editor/image-block-deco.test.ts tests/integration/editor/image-block-deco.test.ts
```

- [ ] **Step 2: Run both projects**

Run: `pnpm test`

Expected: 635 tests pass. Failures indicate either:
- A tests needed happy-dom but we missed it → move it to integration.
- Or a test genuinely broke → not expected; stop and investigate.

- [ ] **Step 3: Confirm project split works**

Run: `pnpm exec vitest run --project unit`
Expected: only `tests/unit/**` files run.

Run: `pnpm exec vitest run --project integration`
Expected: only `tests/integration/**` files run.

- [ ] **Step 4: Commit**

```bash
git add tests/integration tests/unit
git commit -m "test: move CM6-view runtime tests to tests/integration/"
```

---

## Task 6: Update package.json scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Edit the `scripts` block**

Replace the current test-related scripts with:

```json
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:coverage": "vitest run --coverage",
    "test:watch": "vitest",
```

Keep all other scripts (`test:e2e*`, `test:rust`, `test:bench`, `test:all`, etc.) unchanged. `test:all` still works because `pnpm test` now runs both projects.

- [ ] **Step 2: Run each script once**

Run: `pnpm test:unit`
Expected: only unit project runs, passes.

Run: `pnpm test:integration`
Expected: only integration project runs, passes.

Run: `pnpm test:coverage`
Expected: all tests run, coverage report printed to stdout and `coverage/` dir created.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(test): split test scripts into unit/integration + coverage"
```

---

## Task 7: Capture baseline coverage numbers

**Files:**
- Create: `tests/COVERAGE-BASELINE.md` (temporary, deleted in Task 14)

- [ ] **Step 1: Run coverage and extract the summary table**

Run: `pnpm test:coverage 2>&1 | tee /tmp/coverage-baseline.txt`

Expected: final table like:
```
 % Coverage report from v8
-----------------------------|---------|----------|---------|---------|
File                         | % Stmts | % Branch | % Funcs | % Lines |
-----------------------------|---------|----------|---------|---------|
All files                    |   XX.XX |    XX.XX |   XX.XX |   XX.XX |
```

- [ ] **Step 2: Write the baseline file**

Create `tests/COVERAGE-BASELINE.md` with contents:

```markdown
# Coverage Baseline (2026-04-21)

First run of `pnpm test:coverage` before enabling thresholds.

<paste the "All files" row + any file rows below 50% from /tmp/coverage-baseline.txt>

## Gap vs target

Target: lines 80 / functions 85 / branches 70 / statements 80.

| Metric | Baseline | Target | Gap |
|---|---|---|---|
| Lines | XX.XX | 80 | XX.XX |
| Functions | XX.XX | 85 | XX.XX |
| Branches | XX.XX | 70 | XX.XX |
| Statements | XX.XX | 80 | XX.XX |

## Phase gate

Per spec §4 stop-the-line rule: if any metric is >8 points below its target, stop and ask user before enabling thresholds in Task 14.
```

Fill in the actual numbers.

- [ ] **Step 3: Commit**

```bash
git add tests/COVERAGE-BASELINE.md
git commit -m "test: capture coverage baseline before gate enablement"
```

---

## Task 8: Write the waiver registry

**Files:**
- Create: `tests/COVERAGE.md`

- [ ] **Step 1: Write the full file**

Contents:

```markdown
# Test Coverage Waivers

Source files that are intentionally excluded from the vitest coverage
gate. Every waiver must justify WHY untested and name its ALTERNATIVE
coverage (or explicitly note "none — not production code").

This file is the source of truth. `vitest.config.ts`'s `coverage.exclude`
list must mirror it.

## Adding a waiver

1. Add a row below with file, reason, replacement coverage, and PR link.
2. Add the file to `vitest.config.ts` `coverage.exclude`.
3. Reference this file in the PR description.

## Removing a waiver

The opposite — add real tests first, then delete the row AND the config
entry in the same PR.

## Current waivers

| File | Reason | Covered by |
|---|---|---|
| `app/lib/ipc/commands.ts` | Auto-generated by tauri-specta; regenerated on every `pnpm tauri dev` | Rust tests in `core/` |
| `app/lib/utils/benchmark.ts` | Dev-only timing tool; not bundled in prod | none — not production code |
| `app/lib/utils/scroll-edit-test.ts` | Test helper used by e2e specs; filename is the contract | `tests/e2e/specs/editor.spec.ts` |
| `app/lib/utils/startup-timing.ts` | Zero-branch instrumentation — wraps `console.time` | none — no logic to cover |
| `app/lib/utils/window-drag.ts` | Pure DOM mousedown/move/up handler; unit-testing would mean mocking the entire event system | `tests/e2e/specs/editor.spec.ts` (window drag paths) |
| `app/lib/utils/resize-drag.ts` | Pure DOM mousedown/move/up handler | `tests/e2e/specs/split-view.spec.ts` |
| `app/lib/composables/app-events.svelte.ts` | `$effect` chains that register window listeners; logic lives in the listeners, which are exported testable units where it matters | `tests/e2e/specs/editor.spec.ts` |
| `app/lib/composables/app-lifecycle.svelte.ts` | `$effect` orchestration of startup sequence | `tests/e2e/specs/welcome.spec.ts` + `tests/e2e/specs/editor.spec.ts` |
```

- [ ] **Step 2: Cross-check with `vitest.config.ts`**

Run: `grep -E "app/lib/(ipc|utils|composables)" vitest.config.ts`

Expected: each file in the waiver table above appears in the `exclude` array. Any mismatch → fix immediately.

- [ ] **Step 3: Commit**

```bash
git add tests/COVERAGE.md
git commit -m "docs(test): waiver registry for untested source files"
```

---

## Task 9: Write the precision-testing discipline doc

**Files:**
- Create: `docs/architecture/testing-precision.md`

- [ ] **Step 1: Write the full doc**

Contents:

```markdown
# Precision Testing Discipline

This doc defines how we test **modules that produce a derived view of
source state** — CM6 decorations, store→DOM projections, coordinate
mappings. Such modules fail in a characteristic way: the underlying
state is correct, the user-visible output is wrong, and structural
invariants (shape, count, alignment) can still pass. See the 2026-04-21
selection-background bug as the canonical case.

## When this applies

Any module that maps source state into a derived form a user perceives:

- CM6 decoration plugins under `app/lib/editor/` — `wysiwyg.ts`,
  `selection-line.ts`, `math.ts`, `mermaid.ts`, `table.ts`,
  `annotations.ts`, `section-move.ts`, plus any future decoration
  extension.
- Coordinate mappings — anything calling `posAtCoords`, `coordsAtPos`,
  or translating between document position and screen pixel.
- Store→DOM projections — a Svelte store whose state renders into a
  visible subtree (tabs bar, sidebar tree, outline panel).

When unsure: if the user can look at the screen and say "this doesn't
match my intent," and the module determines what's on screen, it's in
scope.

## The rule

> A module in scope MUST have at least one `[precision]`-tagged test
> that asserts the derived view matches the source at the precision a
> user can perceive — character position, pixel range, DOM subtree
> shape. Asserting only structural invariants (shape, count,
> alignment) is insufficient: those would have passed through the
> 2026-04-21 selection bug.

## Precision assertions — concrete forms

Three forms of precision assertion, in order of preference:

### 1. Exact specification of derived output

Build the derived view from the source state, then assert the
derived set equals the expected one — not just "some element exists."

```ts
// GOOD: the assertion names exact from/to/class for every expected deco
const decos = summarize(doc, sel);
expect(decos).toEqual([
  { from: 3, to: 6, klass: 'cm-novelist-selected-range' },
  { from: 7, to: 7, klass: 'cm-novelist-selected-line' },
]);

// BAD: passes through a bug that paints whole lines instead of a range
expect(decos.length).toBeGreaterThan(0);
expect(decos.every(d => d.klass.includes('selected'))).toBe(true);
```

### 2. Round-trip identity

For coordinate mappings, assert the roundtrip is identity.

```ts
// For every pos in a non-trivial doc
const coords = view.coordsAtPos(pos);
const roundTripPos = view.posAtCoords(coords);
expect(roundTripPos).toBe(pos);
```

### 3. DOM subtree shape

For store→DOM projections, render via happy-dom and assert the DOM
matches, not just that the store updated.

```ts
// GOOD
store.openTab({ path: '/a.md', title: 'A' });
await tick();
const titles = [...document.querySelectorAll('[data-testid^="tab-"]')]
  .map(el => el.textContent?.trim());
expect(titles).toEqual(['A']);

// BAD (doesn't catch render bugs)
expect(store.tabs.length).toBe(1);
```

## Checklist for a decoration / projection module

Use this as a PR-review gate. A module in scope should answer "yes" to
each:

- [ ] For every input shape the module handles (partial / full /
      empty / multi-range / doc-end), tests assert the exact derived
      output, not just its shape.
- [ ] Partial vs fully-covered cases are distinguished by name and
      explicitly tested.
- [ ] Edge cases: empty selection, selection at doc end, selection
      spanning empty lines, multi-range selection, selection inside a
      block decoration.
- [ ] For coord-at-pos modules: at least one roundtrip test on a doc
      with ≥3 different line heights (e.g. body / heading / image
      block).

## Anti-patterns — caught in PR review

- Asserting only `decorations.length > 0` or `count > 3`.
- Asserting only structural invariants ("all backgrounds share a left
  edge") and calling that a precision test — it's a layout test, not a
  precision test. Both are useful, but they're different tests.
- `toMatchSnapshot` on a decoration set — hides the contract inside an
  opaque blob that's updated reflexively when it fails.
- Testing the store in isolation when the projection is the bug
  surface.

## Tagging

In test files, prefix the top-level `describe` with `[precision]`:

```ts
describe('[precision] buildSelectionDecorations', () => { ... });
```

When the test also reproduces a specific past bug, add `[regression]`:

```ts
describe('[precision][regression] selection deco — partial ≠ full-line (2026-04-21)', () => { ... });
```

Running only precision tests: `pnpm test -t "\[precision\]"`.

## Relationship to other test types

- **Layout / alignment tests** (`selection-geometry.spec.ts`) —
  structural invariants. Complement precision tests; do not replace
  them.
- **Smoke tests** — "module loads, basic path runs." One per module
  is usually redundant once precision tests exist.
- **Regression tests** — reproduce one past bug each. Always cite the
  commit or issue in the describe block.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/testing-precision.md
git commit -m "docs(test): precision-testing discipline + PR checklist"
```

---

## Task 10: Link new docs from CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Locate the existing testing-doc reference**

Run: `grep -n "docs/architecture/testing" CLAUDE.md`

Expected: one match, the row in the "Architecture Deep Dives" table mentioning `testing.md`.

- [ ] **Step 2: Add the two new references in the table**

After the `testing.md` row in the Architecture Deep Dives table, add:

```markdown
| Precision-testing discipline (decorations, coord mapping, projections) | [testing-precision.md](docs/architecture/testing-precision.md) |
| Coverage waivers + the waiver process | [tests/COVERAGE.md](tests/COVERAGE.md) |
```

- [ ] **Step 3: Add a one-line rule in the Critical Rules section**

In the `## Critical Rules` block, after the existing bullets, add:

```markdown
- **Precision tests are required** for decoration plugins, coord mappings,
  and store→DOM projections. See
  [docs/architecture/testing-precision.md](docs/architecture/testing-precision.md).
  Untested source files need a row in
  [tests/COVERAGE.md](tests/COVERAGE.md).
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): link precision-testing + coverage waiver policy"
```

---

## Task 11: Re-tag the selection-line regression test

**Files:**
- Modify: `tests/unit/editor/selection-line.test.ts`

- [ ] **Step 1: Update the describe tag**

Change:
```ts
describe('buildSelectionDecorations', () => {
```

To:
```ts
describe('[precision][regression] buildSelectionDecorations — partial selections ≠ full-line (bug: 2026-04-21 commit de79a92-era regression)', () => {
```

Note: use `git log --oneline -- app/lib/editor/selection-line.ts` to confirm the commit SHA of the regression fix and replace `de79a92-era` with the actual fix SHA once committed.

- [ ] **Step 2: Run the test**

Run: `pnpm test tests/unit/editor/selection-line.test.ts`
Expected: all 8 tests still pass. The tag doesn't affect execution.

- [ ] **Step 3: Run the precision filter to verify the tag takes effect**

Run: `pnpm test -t "\[precision\]"`
Expected: the selection-line tests run (and only those until P2+ adds more).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/editor/selection-line.test.ts
git commit -m "test(editor): tag selection-line test as [precision][regression]"
```

---

## Task 12: Re-tag two representative existing tests to seed convention

**Files:**
- Modify: `tests/integration/editor/image-block-deco.test.ts` (if Task 1/5 moved it there) or `tests/unit/editor/image-block-deco.test.ts`
- Modify: `tests/integration/editor/slash-runtime.test.ts`

- [ ] **Step 1: Tag image-block-deco describes as [precision]**

The file has multiple top-level describes per the spec ("21 tests covering decoration strategy, height map, coordinate mapping, zoom impact"). For each top-level `describe(...)`, prefix with `[precision]`:

Example change:
```ts
describe('image decoration strategy', ...)
```
Becomes:
```ts
describe('[precision] image decoration strategy', ...)
```

Apply the same to every top-level describe in the file. Do NOT tag nested describes.

- [ ] **Step 2: Tag slash-runtime describes as [contract]**

slash-runtime tests verify the widget lifecycle API (open / filter / close / keyboard handling). These are contract tests.

```ts
describe('slashMenuPlugin — ...', ...)
```
Becomes:
```ts
describe('[contract] slashMenuPlugin — ...', ...)
```

Apply to every top-level describe.

- [ ] **Step 3: Run the tests**

Run: `pnpm test`
Expected: same pass count as before (~635).

- [ ] **Step 4: Run the filters**

Run: `pnpm test -t "\[precision\]"`
Expected: selection-line (from Task 11) + image-block-deco tests run.

Run: `pnpm test -t "\[contract\]"`
Expected: slash-runtime tests run.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/editor/image-block-deco.test.ts tests/integration/editor/slash-runtime.test.ts
git commit -m "test: seed [precision]/[contract] tag convention on existing tests"
```

---

## Task 13: Wire coverage into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the coverage step**

Find the `Vitest` step:

```yaml
      - name: Vitest
        run: pnpm test
```

Replace with:

```yaml
      - name: Vitest (unit + integration)
        run: pnpm test

      - name: Vitest coverage
        run: pnpm test:coverage

      - name: Upload coverage report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage-report
          path: coverage/
          retention-days: 7
```

Only modify the `check` job (macOS runner) — the `check-linux` job runs Rust-only and doesn't need coverage.

- [ ] **Step 2: Sanity-check the YAML**

Run: `pnpm exec yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"`

Expected: no error. If `yaml-lint` not available, the python fallback works.

- [ ] **Step 3: Commit (do NOT push — thresholds not yet enabled, but the coverage step runs)**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run vitest coverage + upload report artifact"
```

At this point CI still passes (thresholds disabled); next task enables thresholds.

---

## Task 14: Enable coverage thresholds

**Files:**
- Modify: `vitest.config.ts`
- Delete: `tests/COVERAGE-BASELINE.md`

Precondition: review Task 7's baseline. If any metric is >8 pts below target, STOP. Do not proceed with this task; surface to user per spec §4 stop-the-line rule.

- [ ] **Step 1: Uncomment the thresholds**

In `vitest.config.ts`, change:
```ts
      // Thresholds DISABLED at first run; enabled after baseline in Task 14.
      // thresholds: { lines: 80, functions: 85, branches: 70, statements: 80 },
```

To:
```ts
      thresholds: {
        lines: 80,
        functions: 85,
        branches: 70,
        statements: 80,
      },
```

- [ ] **Step 2: Run coverage locally**

Run: `pnpm test:coverage`

Expected: either passes (ship it) or fails with a clear message naming which metric fell short.

If it fails: revert the threshold change, reopen discussion with the user about the gap. Do NOT merge a commit that fails the gate it just added.

- [ ] **Step 3: Delete the temporary baseline file**

Run: `git rm tests/COVERAGE-BASELINE.md`

The file has served its purpose; the gate is the new source of truth.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tests/COVERAGE-BASELINE.md
git commit -m "test: enable coverage thresholds (lines 80 / funcs 85 / branches 70 / stmts 80)"
```

---

## Task 15: Final check — full CI dry run locally

**Files:** none (verification only)

- [ ] **Step 1: Simulate the CI pipeline**

Run these in order:
```bash
pnpm check
pnpm test
pnpm test:coverage
pnpm test:e2e:browser
```

Expected: all pass. If `pnpm check` fails on pre-existing errors unrelated to P1 (the three `FileNode.mtime` ones noted in the 2026-04-21 selection fix session), note them but do NOT fix here — out of scope for this plan.

- [ ] **Step 2: Skim the diff once**

Run: `git log --oneline main..HEAD`

Expected: the 11 commits from Tasks 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 (plus any sub-commits from tasks that split).

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin <branch-name>
gh pr create --title "test: phase-1 test hierarchy + coverage governance" --body "$(cat <<'EOF'
## Summary
- Split vitest into unit (node) + integration (happy-dom) projects
- Moved CM6-view tests to tests/integration/editor/
- Added @vitest/coverage-v8 with thresholds 80/85/70/80 and a waiver registry (tests/COVERAGE.md)
- Published the precision-testing discipline doc (docs/architecture/testing-precision.md)
- Re-tagged existing tests to seed the [precision]/[contract]/[regression] convention
- Wired coverage step into CI

Implements Phase 1 of docs/superpowers/specs/2026-04-21-test-hierarchy-and-coverage-design.md.

## Test plan
- [x] pnpm test:unit passes
- [x] pnpm test:integration passes
- [x] pnpm test:coverage passes at thresholds
- [x] pnpm test -t "\[precision\]" runs expected tests
- [x] pnpm check has no new errors introduced by this PR
- [ ] Reviewer confirms waiver list in tests/COVERAGE.md is justified
EOF
)"
```

---

## Self-review

Checked against spec:

- §1 directory layout → Tasks 3–5 ✓
- §2 describe-block tagging → Tasks 11–12 seed convention; full tagging happens in P2+ ✓ (P1 acceptable scope)
- §3 waiver registry → Task 8 ✓; cross-check in Task 8 step 2 enforces config/registry sync
- §4 coverage gate → Tasks 2, 3, 6, 7, 13, 14 ✓; stop-the-line rule referenced in Task 14 precondition
- §5 precision discipline doc → Task 9 ✓
- §6 phasing → this plan is P1 only, as stated in the Scope boundary
- §8 success criteria:
  - `testing-precision.md` + `COVERAGE.md` linked from CLAUDE.md → Task 10 ✓
  - Selection-line bug has `[regression]` test → Task 11 ✓
  - CI fails on coverage regression → Tasks 13–14 ✓
  - Thresholds enabled → Task 14 ✓

Placeholders scan: no "TBD" / "similar to task N" / "handle edge cases" — all code shown inline.

Type consistency: the `$lib` alias matches `vite.config.ts`; `vitest/config`'s `projects` API is the stable multi-project syntax.

Potential issues:
- Task 3 step 3 may reveal >4 tests needing happy-dom. The task explicitly asks engineer to STOP + surface. Acceptable.
- Task 14 may fail the threshold. Acceptable + explicit STOP rule.
- CI may show a different failure mode on macOS-latest than locally. Acceptable risk; PR review catches it.

No gaps identified.
