# Coverage Audit — 2026-04-22

Generated from `pnpm test:coverage` + manual source-file classification.
Informs the batches in `docs/superpowers/plans/2026-04-22-coverage-campaign.md`.

Source files audited: **129** (under `app/lib/**/*.{ts,svelte.ts,svelte}`).
Test files present: **42** (under `tests/unit/**` + `tests/integration/**`).

## Baseline before campaign

Fresh numbers from this run (included in `/tmp/cov-run.txt`):

| Metric | Pre-campaign |
|---|---|
| Lines | 24.05 % |
| Functions | 15.89 % |
| Branches | 23.30 % |
| Statements | 19.40 % |

(Phase-1 `tests/COVERAGE-BASELINE.md` recorded 24.21 / 16.14 / 23.34 / 19.64 — the ~0.1 pt drift reflects recent source additions outpacing tests.)

## Bucket totals

| Bucket | Count |
|---|---|
| covered | 28 |
| partial | 11 |
| precision-testable | 6 |
| contract-testable | 14 |
| integration-only | 1 |
| waive | 69 |
| **total** | **129** |

Waive breakdown: 56 `.svelte` UI components + 6 auto-generated/barrel/data + 1 Tauri platform (`updater.ts`) + 2 dev harnesses (`benchmark`, `scroll-edit-test`) + 3 platform/window/instrumentation glue (`resize-drag`, `window-drag`, `startup-timing`) + 1 (i18n `types.ts` already in 6; keeping it explicit) = 69 total paths waived (only 13 tabled because `.svelte` are bulk-waived by glob).

## Classification

### Covered (≥ 70 % lines, has test)

| File | % Lines | Test file |
|---|---|---|
| app/lib/editor/formatting.ts | 78.00 % | tests/unit/editor/formatting.test.ts |
| app/lib/editor/ime-guard.ts | 90.00 % | tests/integration/editor/wysiwyg-runtime.test.ts (covered indirectly) |
| app/lib/editor/large-file.ts | 100 % | tests/unit/editor/large-file.test.ts |
| app/lib/editor/selection-line.ts | 100 % | tests/unit/editor/selection-line.test.ts |
| app/lib/editor/slash-commands.ts | 90.27 % | tests/unit/editor/slash-commands.test.ts |
| app/lib/editor/table.ts | 85.07 % | tests/unit/editor/table.test.ts |
| app/lib/themes.ts | 71.79 % | tests/unit/utils/themes.test.ts |
| app/lib/stores/new-file-settings.svelte.ts | 100 % | tests/unit/stores/new-file-settings.test.ts |
| app/lib/stores/plugin-settings.svelte.ts | 88.88 % | tests/unit/stores/plugin-settings.test.ts |
| app/lib/stores/shortcuts.svelte.ts | 87.09 % | tests/unit/stores/shortcuts.test.ts |
| app/lib/utils/file-sort.ts | 93.75 % | tests/unit/utils/file-sort.test.ts |
| app/lib/utils/filename.ts | 100 % | tests/unit/utils/filename.test.ts |
| app/lib/utils/h1.ts | 100 % | tests/unit/utils/h1.test.ts |
| app/lib/utils/markdown-copy.ts | 96.87 % | tests/unit/utils/markdown-copy.test.ts |
| app/lib/utils/mindmap.ts | 100 % | tests/unit/utils/mindmap.test.ts |
| app/lib/utils/numbering.ts | 94.49 % | tests/unit/utils/numbering.test.ts |
| app/lib/utils/placeholder.ts | 97.39 % | tests/unit/utils/placeholder.test.ts |
| app/lib/utils/scratch.ts | 100 % | tests/unit/utils/scratch.test.ts |
| app/lib/utils/template-tokens.ts | 100 % | tests/unit/utils/template-tokens.test.ts |
| app/lib/utils/typora-theme.ts | 94.25 % | tests/unit/utils/typora-theme.test.ts |
| app/lib/components/ai-talk/cleanup.ts | 100 % | tests/unit/components/ai-talk-cleanup.test.ts |
| app/lib/components/ai-talk/openai.ts | 100 % | tests/unit/components/ai-talk-openai.test.ts |
| app/lib/components/ai-talk/presets.ts | 100 % | tests/unit/components/ai-talk-presets.test.ts |
| app/lib/components/ai-talk/presets.svelte.ts | 86.84 % | tests/unit/components/ai-talk-prompt-presets.test.ts |
| app/lib/components/ai-talk/sessions.svelte.ts | 80.24 % | tests/unit/components/ai-talk-sessions.test.ts |
| app/lib/components/ai-talk/settings.svelte.ts | 100 % | tests/unit/components/ai-talk-settings-store.test.ts |
| app/lib/components/ai-agent/settings.svelte.ts | 100 % | tests/unit/components/ai-agent-settings-store.test.ts |
| app/lib/composables/app-shortcuts.svelte.ts | 79.48 % | tests/unit/composables/app-shortcuts.test.ts (in progress on user branch) |

> `ai-agent/host.ts` hits 66.66 % via `tests/unit/components/ai-agent-host.test.ts`; treating as **partial** below.

### Partial (< 70 % lines, has a test file that imports the module)

| File | % Lines | Test file | Likely gap |
|---|---|---|---|
| app/lib/stores/commands.svelte.ts | 66.66 % | (indirect via app-shortcuts) | `clear()` path, duplicate-id guard, missing-id error branches — direct contract test needed |
| app/lib/stores/project.svelte.ts | 67.14 % | tests/unit/stores/project-{sort,tree}.test.ts | Uncovered: IPC failure branches, file ops, toggle paths (lines 70-121, 128, 144-145) |
| app/lib/stores/settings.svelte.ts | 27.47 % | tests/unit/stores/settings-store.test.ts | Only new-file helpers tested; persistence + effective-overlay paths uncovered (lines 94-175, 225-312) |
| app/lib/stores/tabs.svelte.ts | 36.50 % | tabs-auto-rename.test.ts, tabs-update-path.test.ts | Split-pane logic, open/close ordering, reload paths largely uncovered |
| app/lib/editor/outline.ts | 0 % | tests/unit/editor/outline.test.ts | Test only exercises the bare regex, not `extractHeadings()` — real fn needs `EditorState` driver |
| app/lib/editor/markdown-extensions.ts | 53.52 % | tests/integration/editor/* | Lines 165, 186-198, 234 — pure helpers extractable |
| app/lib/editor/math.ts | 64.62 % | tests/integration/editor/wysiwyg-runtime | Lines 242-253, 263-289 — render-only paths |
| app/lib/editor/wysiwyg.ts | 42.32 % | tests/integration/editor/wysiwyg-runtime, image-block-deco | Large decoration class, many branches uncovered |
| app/lib/editor/setup.ts | 40.62 % | tests/integration/editor/* | Lines 95, 567, 591-631 — extension assembly, mostly integration |
| app/lib/components/ai-agent/host.ts | 66.66 % | tests/unit/components/ai-agent-host.test.ts | Lines 18-62, 133, 144-148 — spawn/stream lifecycle branches |
| app/lib/utils/wordcount.ts | 62.85 % | tests/unit/utils/wordcount.test.ts | Lines 42-44, 63-76 — emoji/surrogate + boundary paths |

### Precision-testable (no test, pure logic)

| File | Rationale |
|---|---|
| app/lib/editor/section-move.ts | Pure: takes headings list + positions, returns dispatch shape — can mock `EditorView` minimally |
| app/lib/editor/languages.ts | Array of `LanguageDescription.of(...)` — assert aliases, shape, that `load` is a function |
| app/lib/editor/annotations.ts | 7 lines; `Annotation.define<boolean>()` — assert identity equality across imports |
| app/lib/editor/zen.ts | `highlightFocusedBlock` helper + typewriter plugin; decoration-math helpers extractable as pure fns |
| app/lib/utils/chinese.ts | Async converters with lazy-loaded opencc/pinyin; can test with module mocks or real dict (small) |
| app/lib/utils/go-to-line.ts | 11 lines; stub `window.prompt`, assert jump callback triggers + guards |

### Contract-testable (no test, narrow boundary)

| File | Rationale | Mock boundary |
|---|---|---|
| app/lib/app-commands.ts | Sole `commandRegistry.register` site; import + assert every id present | No mock needed — imports real stores; fake `AppCommandContext` |
| app/lib/conflict-handlers.ts | Thin IPC wrapper over `tabsStore` | `vi.mock('$lib/ipc/commands')`, stub `tabsStore` method |
| app/lib/services/new-file.ts | IPC-orchestrated file creation + H1 auto-rename | `vi.mock('$lib/ipc/commands')`, seed `tabsStore`/`projectStore` |
| app/lib/stores/extensions.svelte.ts | Built-in panel store + IPC-driven plugin panel list | `vi.mock('$lib/ipc/commands')` |
| app/lib/stores/templates.svelte.ts | IPC CRUD mirror over `template_files` commands | `vi.mock('$lib/ipc/commands')` |
| app/lib/stores/ui.svelte.ts | Rune state + localStorage side-effects | stub `localStorage`; drive setters |
| app/lib/components/ai-talk/host.ts | Thin IPC + event-listener wrapper for the AI Talk panel | `vi.mock('$lib/ipc/commands')`, mock `@tauri-apps/api/event` |
| app/lib/components/ai-agent/sessions.svelte.ts | Multi-session store, `localStorage` persistence, `killClaudeSession` side-effect | Stub `localStorage`, `vi.mock('./host')` |
| app/lib/composables/close-tab.svelte.ts | Factory + guard flag | `vi.mock('@tauri-apps/api/window')`, stub `tabsStore`/`projectStore` |
| app/lib/composables/editor-context-menu.svelte.ts | Snapshot-selection logic around cut/copy | Stub `EditorView` minimally, mock `navigator.clipboard` |
| app/lib/composables/window-title.svelte.ts | `$effect` that sets Tauri window title | Mock `getCurrentWindow`, wrap in `$effect.root` harness |
| app/lib/composables/app-events.svelte.ts | Event-listener wiring + `openFileByPath` helper | Extract `openFileByPath`; mock IPC + tabs/project stores |
| app/lib/composables/app-lifecycle.svelte.ts | Close-request + sync-timer wiring | Mock `invoke`, `getCurrentWindow`, fake timers |
| app/lib/i18n/index.svelte.ts | Pluralization + `{param}` interpolation | Pure — just import and assert |

### Integration-only (needs `EditorView` / Svelte render / Tauri runtime)

| File | Rationale | Action |
|---|---|---|
| app/lib/editor/viewport.ts | `ViewportManager` drives real `EditorView.dispatch` + scroll; IPC-coupled | Class boundary testable by injecting a fake view, but the value is low (mostly IPC orchestration). Deferred — revisit only if Batch C has spare budget. |

> Other files that require an `EditorView` mount for the remainder of their lines (`editor/setup.ts`, `editor/wysiwyg.ts`, `editor/mermaid.ts`) already have a `.test.ts` / integration test and are classified in **partial** — their Batch G raises target pure-helper extraction, not full `EditorView` wiring.

### Waive (not worth testing here)

#### UI — Svelte components (56 files)

Covered by Playwright e2e; no Svelte-component unit tests in scope.

| Path | Category | Reason |
|---|---|---|
| app/lib/components/**/*.svelte (all 56 `.svelte` files) | UI | e2e covers these; no Svelte-component unit tests in this campaign. |

The 56 files break down as: 31 top-level `components/*.svelte` (panels, dialogs, palettes, editors, sidebar, etc.), 3 `components/ai-agent/*.svelte`, 3 `components/ai-talk/*.svelte`, 1 `components/ai-shared/SessionTabs.svelte`, 5 `components/canvas/*.svelte`, 1 `components/kanban/KanbanImpl.svelte`, and 13 `components/icons/Icon*.svelte` atoms.

After Batch-2 waivers land, `coverage.include` is narrowed to `app/lib/**/*.ts`, which removes all 56 from the denominator without needing per-file `exclude` entries.

#### Auto-generated / barrels

| Path | Category | Reason |
|---|---|---|
| app/lib/ipc/commands.ts | Auto-generated | tauri-specta output — already in `coverage.exclude` |
| app/lib/components/icons/index.ts | Barrel | Re-exports only; zero logic |
| app/lib/i18n/index.ts | Barrel | Re-exports only |
| app/lib/i18n/types.ts | Types-only | No runtime code |
| app/lib/i18n/locales/en.ts | Data | Pure translation table — 100 % already |
| app/lib/i18n/locales/zh-CN.ts | Data | Pure translation table — 100 % already |

#### Platform — Tauri runtime bridges

| Path | Category | Reason |
|---|---|---|
| app/lib/updater.ts | Platform | `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-dialog` at module load; requires real Tauri runtime |

#### Dev harness

| Path | Category | Reason |
|---|---|---|
| app/lib/utils/benchmark.ts | Dev harness | Constructs real `EditorView` for in-app perf benchmark; not a product code path |
| app/lib/utils/scroll-edit-test.ts | Dev harness | Manual scroll+edit stability runner; grabs `window.__novelist_view` |

#### Platform — DOM/window glue

| Path | Category | Reason |
|---|---|---|
| app/lib/utils/resize-drag.ts | Platform glue | `window.addEventListener('mousemove'/'mouseup')` factory; behavioral test would just assert that the listener wiring runs — no logic beyond that. Classify waived unless a precision test emerges trivially. |
| app/lib/utils/window-drag.ts | Platform | `getCurrentWindow().startDragging()` plus target.closest DOM checks — Tauri-only |
| app/lib/utils/startup-timing.ts | Dev-only instrumentation | Uses `performance.mark` + `invoke('log_startup_phase')`; no assertable business logic |

> After Task 2 the `coverage.include` glob narrows to `app/lib/**/*.ts`, so the 48 `.svelte` files drop out of the denominator entirely; the explicit `exclude` list still gets the platform/dev-harness entries above.

## Batch assignments

| Batch | Files | Notes |
|---|---|---|
| A — stores | `stores/commands.svelte.ts` (raise), `stores/extensions.svelte.ts`, `stores/templates.svelte.ts`, `stores/ui.svelte.ts`, `stores/project.svelte.ts` (raise), `stores/tabs.svelte.ts` (raise), `stores/settings.svelte.ts` (raise) | Some are `[contract]` (extensions/templates/ui) + some partial raises to ≥ 70 % |
| B — utils | `utils/chinese.ts`, `utils/go-to-line.ts`, `utils/wordcount.ts` (raise) | `benchmark`/`scroll-edit-test`/`resize-drag`/`startup-timing`/`window-drag` re-classified to waive in this audit |
| C — editor pure | `editor/viewport.ts` (if budget), `editor/section-move.ts`, `editor/outline.ts` (real `extractHeadings`), `editor/annotations.ts`, `editor/languages.ts`, `editor/zen.ts`; raise `themes.ts` toward ≥ 80 % already covered — skip | Uses `EditorState.create()` with `markdown()` for outline/section-move |
| D — composables | `composables/app-events.svelte.ts`, `composables/app-lifecycle.svelte.ts`, `composables/close-tab.svelte.ts`, `composables/editor-context-menu.svelte.ts`, `composables/window-title.svelte.ts` | `$effect.root` harness + `vi.mock` of Tauri API; `app-shortcuts` already covered by user's in-progress work — do not touch |
| E — services | `services/new-file.ts` | Mock IPC + stub stores |
| F — app/lib root | `app-commands.ts`, `conflict-handlers.ts`, `i18n/index.svelte.ts` | `event-handlers.ts` does not exist — the coverage row labelled `...t-handlers.ts` is `conflict-handlers.ts` |
| G — partial improvements | `editor/markdown-extensions.ts`, `editor/math.ts`, `editor/formatting.ts` (bump to 90+), `editor/wysiwyg.ts` (extract helpers), `editor/mermaid.ts` (parse cache only), `editor/setup.ts` (bump what can be bumped), `components/ai-agent/host.ts` (raise) | Focus on extractable pure helpers; skip anything needing `EditorView` mount (defer to tests/integration/) |

## Unclassifiable / escalate

None — every source file landed in a bucket.

## Surprises worth flagging

1. **No `event-handlers.ts` exists.** The plan's Batch F mentioned it, but the coverage report abbreviation `...t-handlers.ts` resolves to `conflict-handlers.ts`. Plan will be slightly adjusted in Batch F to cover `app-commands.ts` + `conflict-handlers.ts` + `i18n/index.svelte.ts`.
2. **`editor/outline.ts` shows 0 % coverage despite having a `.test.ts`.** The existing test only exercises the standalone regex, not `extractHeadings()` — it got classified as **partial** but the real function needs a real test in Batch C.
3. **`stores/commands.svelte.ts` has no direct test file** yet is 66.66 % covered via `app-shortcuts.test.ts` that happens to import it. A dedicated `[contract]` test will both raise the number and anchor behavior.
4. **`close-tab.test.ts` does NOT import `composables/close-tab.svelte.ts`** — it builds a shadow `ProjectStore`. The real composable remains uncovered and is in Batch D.
5. **`utils/benchmark.ts` + `utils/scroll-edit-test.ts` are dev harnesses**, not product code. Re-classified from the plan's precision-testable bucket to **waive/dev-harness**; this trims the denominator instead of inflating coverage with benchmark-shape tests.
6. **`utils/resize-drag.ts` + `utils/window-drag.ts` + `utils/startup-timing.ts`** are thin DOM/window glue; listing as waived (Platform / dev instrumentation) avoids shallow "listener wired" tests.
7. **User's dirty files** (`Settings.svelte`, `app-shortcuts.svelte.ts`, shortcuts store + test, i18n locales) are classified in this audit by their committed state; the campaign must avoid editing these paths until the user has merged.
