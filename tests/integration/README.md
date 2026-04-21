# Integration Tests

These tests exercise multiple modules together, and/or require a DOM
environment (happy-dom). They are slower than `tests/unit/` but verify
behavior the unit tier cannot — e.g., CM6 `EditorView` wiring, Svelte
component rendering, cross-store interactions.

**Run:** `pnpm test:integration`

**When to place a test here instead of `tests/unit/`:**
- Constructs `new EditorView(...)` or a Svelte component
- Touches `document.*`, `window.*`, or DOM events
- Asserts against rendered DOM / computed styles
- Wires more than one store / service together end-to-end

If your test only models pure logic (functions, state transitions,
reducers) without DOM, keep it in `tests/unit/`.

See `docs/architecture/testing-precision.md` for describe-tag
conventions (`[precision]`, `[contract]`, `[regression]`, `[smoke]`).
