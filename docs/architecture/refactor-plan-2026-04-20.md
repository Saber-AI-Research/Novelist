# Maintainability Refactor — 2026-04-20

**Goal**: reduce surface area of the three hardest-to-maintain artifacts without
touching product behavior or removing features. Three phases, in order.

> **Rule**: Plugins (canvas, mindmap, kanban) and the template panel are
> **core product features**, not refactor targets. No hiding, collapsing, or
> "push to plugin protocol" for existing bundled plugins. See memory
> `feedback_preserve_core_features.md`.

---

## Phase 1 — Split `app/App.svelte` (currently 1475 lines)

### Inventory of responsibilities

Measured from the current file:

| Block | Lines (script) | Concern | Extraction target | Risk |
|-------|---------------|---------|-------------------|------|
| A | 52–75 | Per-pane editor state (wordCount, cursor, headings, ref) + derived status-bar bindings | stays in App for now; see note below | n/a |
| B | 77–85 | Palette/dialog open flags | stays | n/a |
| C | 88–155 | Split divider + sidebar + right-panel resize drags (3 handlers) | `$lib/utils/resize-drag.ts` | low |
| D | 172–188 | Window title `$effect` | `$lib/composables/window-title.svelte.ts` | trivial |
| E | 168, 191–196, 980–982 | Recent projects state + refresh + event listener | folded into `app-events` composable (#6) | low |
| F | 203–387 | Open project / new window / new scratch / smart new file / template execute / save-as-template | `$lib/services/new-file.svelte.ts` + `project-actions.svelte.ts` | **high** |
| G | 389–400 | Window drag region (macOS title-bar) | `$lib/utils/window-drag.ts` | low |
| H | 402–429 | Close-tab with save prompt | `$lib/composables/close-tab.svelte.ts` | medium |
| I | 431–435 | `getActiveEditorView` helper | `$lib/stores/tabs.svelte.ts` (already a natural home) | trivial |
| J | 437–499 | **Editor right-click context menu** — state + 6 handlers | `$lib/composables/editor-context-menu.svelte.ts` | **low, self-contained**, dedicated E2E spec |
| K | 501–594 | Editor formatting helpers (`wrapSelection`, `toggleWrap`, `toggleLinePrefix`) | `$lib/editor/formatting.ts` (pure functions) | low |
| L | 596–700 | `shortcutHandlers` map + `handleKeydown` + Cmd+1–9 + zoom | `$lib/composables/app-shortcuts.svelte.ts` | medium (ordering matters) |
| M | 702–717 | `handleMoveSection`, `handleGoToLine` | minor helpers; inline or `$lib/utils/go-to-line.ts` | trivial |
| N | 719–741 | Conflict dialog handlers | `$lib/composables/conflict-handlers.svelte.ts` | low |
| O | 743–1098 | `onMount` mega-block: ~30 `commandRegistry.register` calls, 6 event listeners, sync timer, close-requested, beforeunload, goto-line, startup marks | split into three files: `commands-registration.ts`, `app-events.svelte.ts`, `app-lifecycle.svelte.ts` | high |

### Execution order (smallest & safest first)

1. **J — Editor context menu** (~63 lines out). Done first because it's the
   textbook "god component extraction" candidate: self-contained state, has a
   dedicated E2E spec (`tests/e2e/specs/editor-context-menu.spec.ts`), and no
   cross-wiring.
2. **K — Editor formatting helpers** (~94 lines out). Pure functions; move to
   `$lib/editor/formatting.ts`. Trivial.
3. **C + G — Resize drag + window drag helpers** (~80 lines out). Mechanical.
4. **D + M — Window title + go-to-line** (~30 lines out). Trivial.
5. **O split part 1 — commandRegistry population** (~110 lines out). Move the
   flat list of `commandRegistry.register(...)` into a new
   `app/lib/app-commands.ts` that accepts a handler context object. This is the
   single biggest win for `onMount` size.
6. **O split part 2 — event listeners** (~80 lines out). `file-changed`,
   `file-renamed`, `recent-projects-updated`, `open-file`, drag-drop → one
   `useAppEvents(ctx)` composable that returns a cleanup fn.
7. **O split part 3 — lifecycle** (~60 lines out). Close-requested handler,
   beforeunload sync, sync timer → `useAppLifecycle(ctx)`.
8. **N — Conflict handlers** (~23 lines out). Small; pair with `app-events` if
   trivial, else standalone.
9. **H + L — Close-tab + shortcut routing** (~130 lines out). Do last because
   they're the most entangled with dialog state flags and editor refs.
10. **F — Smart new-file + template execution** (~185 lines out). Last and
    largest. Will need its own mini-plan before touching.

Expected end state: `App.svelte` script ≈ 350–450 lines of layout and
state-passthrough, with concerns lifted into `app/lib/composables/` (new dir)
and `app/lib/services/` (new dir).

### Hard rules during extraction

- **Run between each extraction**: `pnpm test && pnpm test:e2e:browser` must
  stay green. No moving to the next step if either fails.
- **No DOM/structure changes** to `App.svelte` markup during Phase 1 — only
  `<script>` body moves. Markup stays byte-identical until all script
  concerns are extracted, then we revisit markup separately.
- **No API changes to stores/commands** — extraction is script-layout only.
- Each extraction is its own commit (`refactor(app): extract <concern>`).

---

## Phase 2 — Consolidate `CLAUDE.md`

### Current problem

`CLAUDE.md` is 286 lines and mixes:
- Stable architecture overview (tech stack, IPC rules, command layout)
- Deep dives that rot when code changes (slash menu internals, block-widget
  decoration strategy, settings two-tier schema)
- Recent additions log that's essentially a changelog

### Target structure

Keep `CLAUDE.md` as a **pointer index** (~80–100 lines max), with deep dives
moved into `docs/architecture/*.md`:

- `docs/architecture/editor-wysiwyg.md` — block decorations, height-map rules,
  CSS zoom migration, image block strategy, scroll stabilizer link
- `docs/architecture/editor-slash-menu.md` — trigger rules, precedence,
  positioning retry, IME fallback
- `docs/architecture/editor-context-menu.md` — snapshot semantics, why
  right-click needs a custom menu only inside `.cm-content`
- `docs/architecture/plugin-system.md` — asset protocol, WKWebView iframe
  rules, bundled plugin pipeline, file-handler extensions
- `docs/architecture/settings.md` — two-tier overlay, plugin deltas,
  localStorage migration, new-file location tracking
- `docs/architecture/file-lifecycle.md` — watcher hashing, rename-ignore,
  cross-window broadcast, encoding migration
- `docs/architecture/testing.md` — three-tier strategy, testid conventions,
  `__test_api__` bridge, mock IPC
- `docs/architecture/feature-boundaries.md` — Phase 3 output (see below)

`CLAUDE.md` post-consolidation holds: project overview, tech stack, commands,
"where to find X" pointers, `## Key Conventions` (CJK, atomic writes,
BLAKE3), and a **short** recent-additions list or link to `CHANGELOG.md`.

Move contents verbatim first (no rewording) — that way `git blame` still works
and any phrasing I've preserved in memory still refers to real text.

---

## Phase 3 — Document feature boundaries

Output: `docs/architecture/feature-boundaries.md`.

Purpose: make it explicit (for AI assistants and future contributors) which
modules are **core product features** vs. **pure infrastructure**. This is
*documentation only* — no code moves, no disabling, no "could be a plugin"
refactoring.

Proposed categories:

- **Core editor & file surface** (non-negotiable): CM6 editor + WYSIWYG,
  sidebar tree, tab bar, status bar, outline, zen mode, command palette,
  project search, settings panel, welcome screen.
- **Core product features** (first-class, user-facing): canvas plugin, kanban
  plugin, mindmap plugin + Cmd+Shift+M overlay, template panel + template
  files, draft notes, snapshots, stats panel, export pipeline.
- **Infrastructure** (engine): plugin host / sandbox, file watcher, rope
  document, auto-save, WebDAV sync, updater, startup instrumentation,
  cross-window broadcast.
- **Dev/diagnostics**: benchmark commands, scroll test, plugin reload.

Deliverable is a markdown table listing each module and its category, with a
"what changes would require user approval" column. No code changes.

---

## Cross-phase deliverables

- [ ] Memory entries under `~/.claude/projects/...Novelist-app/memory/` —
      **done 2026-04-20** (initial set; update as refactor discovers new
      invariants).
- [ ] `docs/architecture/refactor-plan-2026-04-20.md` — **this file**.
- [ ] Per-extraction commits with `refactor(app): ...` prefix.
- [ ] End-of-phase checkpoint: all three test tiers green + user sign-off
      before moving to the next phase.
