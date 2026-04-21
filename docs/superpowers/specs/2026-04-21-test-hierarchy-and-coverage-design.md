# Test Hierarchy & Coverage Governance — Design

**Date**: 2026-04-21
**Status**: Design approved, awaiting implementation plan
**Trigger**: The 2026-04-21 selection-background bug —
`unifiedLineSelectionPlugin` painted whole-line backgrounds for any
selection, making partial selections look like full-line ones. The
underlying `view.state.selection` was correct; the derived decoration
wasn't. The pre-existing e2e test (`selection-geometry.spec.ts`) only
asserted left-edge alignment across heading lines — a structural
invariant — and was silent on the character-precision invariant. The
class of failure ("derived view disagrees with source state at a
precision the user can see, and no test caught it") can recur in any
decoration plugin, any state→DOM projection, any coord-at-pos mapping.
This spec lays out the process + structure to prevent it.

## Goals

1. **Precision as a first-class test category** — every module that
   produces a derived view of state must have at least one test asserting
   the derived view matches the source at user-perceivable precision.
2. **All frontend features have tests or explicit waivers** — no silent
   coverage gaps; every untested source file has a documented reason.
3. **Test suite is hierarchically organised** — unit / integration / e2e
   are separated by runtime cost so CI can fail fast.
4. **Coverage is gated in CI** — regressions in coverage fail PRs.

Non-goals:
- Testing the Rust core (separate existing `pnpm test:rust` pipeline,
  untouched).
- Rewriting existing tests that already pass.
- Adding tests to generated files (`app/lib/ipc/commands.ts`) or
  dev-only tooling.

## 1. Directory Layout

```
tests/
  unit/                # vitest, node env (no DOM)
    editor/ stores/ utils/ services/ components/
  integration/         # vitest, happy-dom env (real CM6 view, DOM APIs)
    editor/            # migrated: wysiwyg-runtime, slash-runtime,
                       #           image-rendering, selection-line (if
                       #           it grows a DOM-facing counterpart)
    composables/       # $effect wiring, window-title, etc.
  e2e/specs/           # Playwright, unchanged
  fixtures/            # shared helpers: makeView(), mockIPC(), etc.
  COVERAGE.md          # waiver registry (see §3)
```

**Rationale for `integration/`**: happy-dom setup is ~3× slower per file
than a pure node unit test. Keeping those tests in a separate directory
lets CI run the unit layer as the gate on every push, and the
integration layer once per PR.

**Migration scope** (P1): four existing files move from `tests/unit/
editor/` → `tests/integration/editor/`:
- `wysiwyg-runtime.test.ts`
- `slash-runtime.test.ts`
- `image-rendering.test.ts`
- any future DOM-backed selection-line test (the current
  `selection-line.test.ts` stays in unit because it's pure).

## 2. Describe-block Tagging

Every top-level `describe` block in a test file begins with one of these
tags, in brackets:

| Tag | Meaning | Failure signals |
|---|---|---|
| `[precision]` | The derived view exactly matches source state at a user-perceivable precision (character position, pixel range). | A rendering bug that passes type-check and doesn't throw. |
| `[contract]` | Public function/API behaves per its docstring for all documented inputs. | An API regression that breaks callers. |
| `[regression]` | Reproduces a specific past bug; the describe block must cite the commit SHA or issue. | That specific bug is back. |
| `[smoke]` | Module loads, basic path runs, no throws. | The module is fundamentally broken. |

Example:
```ts
describe('[precision] buildSelectionDecorations', () => { ... });
describe('[regression] image decoration height-map (commit 5adaf10)', () => { ... });
```

CI commands:
- `pnpm test -t "\[precision\]"` — run only precision tests.
- `pnpm test -t "\[regression\]"` — run all named-bug tests (good for
  post-refactor confidence check).

These tags are documentation + filter, not enforcement — no ESLint rule
blocks a missing tag. The precision-testing discipline (§5) names
`[precision]` explicitly, and PR review checks for it on decoration-
producing modules.

## 3. Waiver Registry (`tests/COVERAGE.md`)

Format: markdown table. Columns: **File**, **Reason**, **Covered by**.

| File | Reason | Covered by |
|---|---|---|
| `app/lib/utils/benchmark.ts` | Dev-only timing tool, not in prod bundle | — |
| `app/lib/utils/scroll-edit-test.ts` | Test helper (name suggests it) | — |
| `app/lib/utils/startup-timing.ts` | Zero-branch probe — only calls `console.time` | — |
| `app/lib/utils/window-drag.ts` | Pure DOM mousedown/move/up choreography | `tests/e2e/specs/editor.spec.ts` (window drag) |
| `app/lib/utils/resize-drag.ts` | Pure DOM mousedown/move/up choreography | `tests/e2e/specs/split-view.spec.ts` |
| `app/lib/composables/app-events.svelte.ts` | Pure `$effect` listener registration | `tests/e2e/specs/editor.spec.ts` (event paths) |
| `app/lib/composables/app-lifecycle.svelte.ts` | Pure `$effect` orchestration | `tests/e2e/specs/welcome.spec.ts` + `tests/e2e/specs/editor.spec.ts` |
| `app/lib/ipc/commands.ts` | Auto-generated from Rust via tauri-specta | Rust tests in `core/` |

Process for adding a waiver:
1. Propose in PR description with reason.
2. Entry in this file mirroring the PR's PR link.
3. `vitest.config.ts` `coverage.exclude` pattern covers the file.

Process for removing a waiver: the opposite — add tests, remove from
this table, remove from `vitest.config.ts` exclude.

The file is append-only in spirit — removing a waiver without adding
tests first is a regression.

## 4. Coverage Gate

`vitest.config.ts` additions (v8 provider, bundled with vitest):

```ts
test: {
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
    thresholds: {
      lines: 80,
      functions: 85,
      branches: 70,
      statements: 80,
    },
  },
},
```

CI wiring (GitHub Actions — we check `.github/workflows/` during P1 for
the exact file):
- Add `pnpm test:coverage` step after `pnpm test`, failing the job on
  threshold breach.
- Upload `coverage/` as an artifact for PR inspection.

**Baseline risk**: if P1's first coverage run shows current `lines` is
<72% (≥8 pts below the 80 gate), we stop and ask: "raise coverage
first, or lower the gate and set a calendar reminder?" Per user
decision (§4 of brainstorm), default is "one-shot target"; deviation
requires explicit user sign-off, not autonomous downgrade.

## 5. Precision-Testing Discipline (`docs/architecture/testing-precision.md`)

A new architecture doc, load-bearing — linked from `CLAUDE.md` next to
the existing testing doc.

Scope: **any module that produces a derived view of some source state**.
In this codebase:
- CM6 decoration plugins (`wysiwyg.ts`, `selection-line.ts`,
  `mermaid.ts`, `math.ts`, `table.ts`, `annotations.ts`,
  `section-move.ts`, image block deco inside `wysiwyg.ts`)
- Coord↔position mapping (`posAtCoords`, `coordsAtPos` callers —
  outline, viewport, slash menu, editor context menu)
- Store→DOM projections (anything rendering a store into the Svelte
  tree that a user can visually verify)

### The rule

> A module in scope MUST have at least one `[precision]` test that
> asserts the derived view matches the source at the precision a user
> can perceive (character position, pixel range, DOM subtree shape).
> Asserting only structural invariants (e.g. "all backgrounds align on
> left edge") is insufficient — those would have passed through the
> 2026-04-21 selection bug.

### Checklist (PR-gate, not machine-enforced)

For each decoration/projection module in scope:

- [ ] For every selection/input shape the module handles, we assert the
      exact `{from, to, class/kind}` set, not just "some decoration
      exists" or "count > 0".
- [ ] Partial vs fully-covered cases are distinguished in tests —
      explicitly named as such.
- [ ] Edge cases: empty selection, selection at doc end, selection
      spanning empty lines, multi-range selection.
- [ ] For coord-at-pos modules: at least one test that does
      `posAtCoords(coordsAtPos(x))` round-trip on a non-trivial doc.

### Anti-patterns (caught in PR review)

- Asserting only shape/count of decorations.
- Asserting only `querySelectorAll('.foo').length > 0` on rendered DOM.
- Using `toMatchSnapshot` for decoration output (hides the precision
  contract behind a blob).

## 6. Implementation Phasing

Each phase ends on a commitable state. Phases are independent enough
that a phase can ship on its own if the next is deferred.

| Phase | Deliverable | Scope |
|---|---|---|
| **P1** | Policy + baseline | Write `testing-precision.md`, `COVERAGE.md`, update `vitest.config.ts` with coverage provider + thresholds, migrate runtime tests to `tests/integration/`, run coverage baseline, ship as one PR. |
| **P2** | Editor decoration precision audit | For each of `wysiwyg.ts` (internal), `annotations.ts`, `math.ts`, `mermaid.ts`, `table.ts`, `section-move.ts`, `viewport.ts`: walk the precision checklist, add missing tests, label `[precision]`. |
| **P3** | Editor tail + services | `ime-guard.ts`, `languages.ts`, `markdown-extensions.ts`, `zen.ts`; `services/new-file.ts`. |
| **P4** | Store layer | `stores/commands.svelte.ts`, `stores/extensions.svelte.ts`, `stores/templates.svelte.ts`, `stores/ui.svelte.ts` (and any projection that renders these to DOM gets a `[precision]` test). |
| **P5** | Utils tail | `utils/chinese.ts`, `utils/go-to-line.ts` (rest waived). |
| **P6** | Composables | `editor-context-menu.svelte.ts`, `window-title.svelte.ts`, `close-tab.svelte.ts` (rest waived). |
| **P7** | Final coverage push + CI wire-up | Run coverage, identify files below threshold, fill gaps, enable CI gate. |

**Stop-the-line triggers** (from §6 of brainstorm):
- If a phase's baseline shows coverage >8 pts below the 80 gate: stop,
  surface to user, ask before continuing.
- If a single file requires >2 hours to write precision tests for:
  stop, surface to user, ask whether to refactor the file or proceed.

## 7. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Coverage gate blocks legitimate PRs | Medium | Waiver process is explicit and fast; any PR can add a waiver with justification in the same PR. |
| `[precision]` tag gets applied sloppily (as a word, not a discipline) | Medium | Review checklist in §5 is the gate; we audit in PR review, not by CI. |
| happy-dom diverges from real browser on some CM6 feature | Low | Existing `wysiwyg-runtime.test.ts` already uses happy-dom without issues. Precision tests that must run in real browser go to `tests/e2e/`. |
| P2-P6 work surfaces real bugs in production code | Medium | Expected and desirable. Bugs get their own fix PRs; test-only PRs don't bundle fixes. |
| The `[precision]` discipline is ignored for future new modules | High (process problem) | `CLAUDE.md` gets a one-line rule linking to `testing-precision.md`; every new decoration/projection module gets PR-review-flagged. |

## 8. Success Criteria

- All source files in `app/lib/` either have tests or a waiver row in
  `COVERAGE.md`.
- `pnpm test:coverage` passes at 80/85/70/80 lines/functions/branches/
  statements.
- Every decoration-producing file in `app/lib/editor/` has at least
  one `[precision]`-tagged test.
- CI fails a PR that lowers coverage below threshold.
- `CLAUDE.md` references `testing-precision.md` and `COVERAGE.md`.
- The 2026-04-21 selection bug has a `[regression]` test (the tests I
  already added against `buildSelectionDecorations` are re-tagged).

## 9. Open Questions (resolve in implementation plan)

- Exact baseline coverage numbers — known only after P1 runs.
- Whether `app/lib/components/*.svelte` needs per-component unit tests
  or whether existing E2E + component-level smoke is enough. Proposed:
  defer to P7; most component logic lives in composables/stores already
  tested; only add unit tests where Svelte template logic has
  non-trivial branches.
