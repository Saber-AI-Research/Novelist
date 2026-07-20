# Testing Precision & Describe-Tag Convention

Background: 2026-04 we shipped a selection-highlight bug that painted
whole lines instead of the character-range. Root cause: the builder
emitted `Decoration.line` for every line a selection touched. No unit
test asserted the builder's output shape — tests covered downstream
behavior, not the builder's contract. See the spec at
`docs/exec-plans/completed/2026-04-21-test-hierarchy-and-coverage-design.md`
for the full incident write-up.

To prevent this class of regression we (a) hierarchized tests into
`tests/unit/**` and `tests/integration/**`, and (b) tag every
describe-block with its **testing intent** so readers (and CI tooling
later) can filter by purpose.

## The Four Tags

Tags are placed as the first token of a `describe()` label, inside
square brackets. A describe may have more than one tag.

These bracketed labels describe the suite's **testing intent**. They are a
Novelist convention, not Playwright tags and not task/workflow selectors.

### `[precision]` — pure function, property-level assertions

The test asserts the exact output shape of a pure function given a
range of inputs, including boundary cases. This is the strongest
guarantee level. Use for:

- Decoration builders, parsers, serializers, transducers
- Pure state-transition reducers
- CJK word-counting, numeric-aware sort, Markdown tokenization

Discipline:

- The function under test must be **pure** (no side effects, no
  reading global state, no DOM). Extract pure helpers from impure
  code before testing.
- Assert **structural** equality (`toEqual`), not stringified output.
- Cover every branch the function has, plus its boundaries (empty
  input, max input, off-by-one).
- One behavior per `it(...)`. "Given X, returns Y." Not "Handles a
  bunch of cases."

### `[contract]` — public API shape, upstream or cross-module

The test asserts that a module's public interface behaves as
documented — inputs, outputs, side-effects at the boundary. Use for:

- Store methods (`someStore.applyFoo(...)`) — assert the resulting
  store state, not internal calls.
- CM6 extension integration (EditorView round-trips).
- IPC command wrappers (mock the IPC, assert the result shape).

Discipline:

- Treat the module as a black box. Do not assert on private helpers.
- Use the narrowest environment that can exercise the boundary
  (`node` for pure TS, `happy-dom` if a View or DOM is required).
- If you need to mock, mock at the module boundary (IPC, `fetch`),
  never halfway inside.

### `[regression]` — reproducer for a specific past bug

A test whose job is "never let this bug come back." The describe
label should include a short identifier for the bug (commit SHA or a
one-line name). Use for:

- Bugs found in production or code review.
- Bugs found during refactors (i.e., the refactor revealed them).

Discipline:

- The test **must fail** on the buggy commit and **pass** on the
  fixed commit. Verify this by checking out the buggy commit and
  running the new test before merging the fix.
- Keep it minimal — reproduce the bug, assert the fixed behavior,
  nothing else. Link the fix commit in a comment.

### `[smoke]` — end-to-end feel, low assertion density

Broad integration sanity checks. Use sparingly — one per major
feature. Use for:

- "Can the editor boot with a document and accept a keystroke?"
- "Does File > New create a file?"

Discipline:

- Lives in `tests/integration/**` or `tests/e2e/**` — never
  `tests/unit/`.
- Assert only enough to prove the wiring is alive. Not a substitute
  for `[precision]` coverage of the same feature.

## Playwright Workflow Tags

Task-focused browser workflows use Playwright `@` tags in test titles, for
example `@task23` and `@task23-negative`. They are selected with Playwright's
regular-expression filter, `--grep`; the filter matches the composed test
identity, including project, file, enclosing `test.describe()` labels, test
title, and tags. These tags answer **which workflow should run**, while
`[precision]`, `[contract]`, `[regression]`, and `[smoke]` answer **why a
suite exists and what kind of guarantee it provides**.

Keep the namespaces separate:

- Put intent labels at the start of a `describe()` title.
- Put a task workflow tag in the Playwright test title (or Playwright tag
  metadata) and filter it with `--grep`.
- Do not infer test precision from `@task23`, or Task 23 membership from an
  intent label. A test may legitimately carry both kinds of metadata.

`--grep` is a regex filter rather than an exact-tag lookup. Use the documented
commands in `testing.md` for the canonical Task 23 aggregate and negative
selections instead of inventing ad hoc filters. See Playwright's official
[tag](https://playwright.dev/docs/test-annotations#tag-tests) and
[`grep`](https://playwright.dev/docs/api/class-testconfig#test-config-grep)
documentation for matching semantics.

## Examples

```ts
// tests/unit/editor/selection-line.test.ts
describe('[precision][regression] buildSelectionDecorations', () => {
  // …
});

// tests/unit/stores/sessions.test.ts
describe('[contract] sessionsStore', () => {
  // …
});

// tests/integration/editor/wysiwyg-runtime.test.ts
describe('[smoke] CM6 WYSIWYG runtime boots', () => {
  // …
});
```

## Extracting Pure Helpers

The `selection-line` fix is the canonical example: the CM6
`ViewPlugin` update path could only be tested by booting a View (slow,
DOM-dependent, vague assertions). Extracting
`buildSelectionDecorations(doc, selection)` as a pure function made
`[precision]` testing possible — every input shape becomes an
assertion. Follow the same pattern elsewhere:

1. Find the logic worth precision-testing inside an impure wrapper.
2. Extract it as an exported pure function.
3. Write the `[precision]` unit test against the pure function.
4. The wrapper becomes a thin `[contract]` test at most.

## Where Tests Live

See also `docs/design-docs/testing.md` for the current layered strategy and
mock-versus-native boundaries.

| Dir | Env | Scope | Typical tags |
|---|---|---|---|
| `tests/unit/` | happy-dom (temporarily; node target for a later phase) | Pure logic | `[precision]`, `[contract]` |
| `tests/integration/` | happy-dom | Multi-module / DOM-required | `[contract]`, `[smoke]` |
| `tests/e2e/` | Playwright | User journeys | `[smoke]`, `[regression]` |

## Enforcement

Phase-1 (current): describe-tag convention is documented + applied to
a starter set. No tooling enforcement yet.

Later phases: a small lint script can scan `tests/**` for untagged
`describe` blocks and fail CI. Deferred until the convention has
settled.
