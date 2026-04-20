# Feature Boundaries

This document classifies Novelist-app modules so future refactor /
maintenance work knows what's **core product** (user-facing, not to be
removed without explicit approval) vs. **infrastructure** (engine code
that should stay lean) vs. **diagnostics** (developer-only).

The classification is descriptive, not prescriptive — **no code moves or
removals follow from it**. Its purpose is to make scope decisions
obvious: "should this change require user sign-off?" usually reduces to
"is it touching a core-product feature?".

> **Hard rule**: anything marked **Core product** below is a first-class
> feature. Do not remove, hide, collapse, or "push to plugin protocol"
> without explicit user approval. This specifically includes the canvas,
> mindmap, and kanban plugins, plus the template panel.

---

## Core editor surface (non-negotiable)

The minimum viable app. Removing any of these would make Novelist not
Novelist.

| Module | Purpose |
|--------|---------|
| `app/lib/components/Editor.svelte` + `app/lib/editor/**` | CodeMirror 6 editor with WYSIWYG, slash menu, outline, selection handling, zoom, IME guard |
| `app/lib/components/Sidebar.svelte` + `FileTreeNode.svelte` | File tree, drag-drop, context menus, hidden-file toggle |
| `app/lib/components/TabBar.svelte` | Tab bar with dirty indicators |
| `app/lib/components/StatusBar.svelte` | Word count, cursor, daily goal |
| `app/lib/components/CommandPalette.svelte` | Fuzzy command search |
| `app/lib/components/Welcome.svelte` | Recent projects, new-project entry points |
| `app/lib/components/Settings.svelte` | Settings panel |
| `app/lib/components/Outline.svelte` | Heading navigation |
| `app/lib/components/ZenMode.svelte` | Distraction-free writing mode |
| `app/lib/components/ProjectSearch.svelte` | Project-wide search |
| `app/lib/components/MoveFilePalette.svelte` | Cmd+M move-file picker |
| `app/lib/components/ConflictDialog.svelte` | External-change conflict resolution |
| `app/lib/components/ExportDialog.svelte` | Pandoc-backed export flow |
| `app/lib/components/NewProjectDialog.svelte` | New project creation |

## Core product features (first-class, user-facing)

Real features that users depend on. Not optional — plugins and templates
are **not demotable to optional extras**.

| Module | Purpose |
|--------|---------|
| `plugins/canvas/` + `app/lib/components/CanvasFileEditor.svelte` + `app/lib/components/canvas/` | Freeform canvas drawing on `.canvas` files |
| `plugins/kanban/` + `app/lib/components/KanbanFileEditor.svelte` | Kanban board on `.kanban` files |
| `plugins/mindmap/` + `app/lib/components/MindmapOverlay.svelte` | Mindmap — both a plugin (side-panel) and a Cmd+Shift+M overlay driven by `markmap-lib` |
| `app/lib/components/TemplatePanel.svelte` + `TemplateDialog.svelte` + `app/lib/stores/templates.svelte.ts` + `app/lib/utils/template-tokens.ts` + `core/bundled-templates/` + `core/src/commands/template_files.rs` | Template files (insert & new-file modes) |
| `app/lib/components/DraftNote.svelte` | Side-panel draft/scratchpad |
| `app/lib/components/SnapshotPanel.svelte` | Project snapshots (point-in-time backups) |
| `app/lib/components/StatsPanel.svelte` | Writing stats panel |

## Infrastructure (engine)

Non-user-facing code that powers the product. Safe to refactor for
performance/clarity as long as observable behavior doesn't change.

| Module | Purpose |
|--------|---------|
| `core/src/services/plugin_host/` | QuickJS sandbox, permission tiers |
| `core/src/services/file_watcher.rs` | BLAKE3 self-write suppression, rename-ignore |
| `core/src/services/rope_document.rs` | Ropey-backed huge-file backend |
| `core/src/commands/file.rs`, `project.rs`, `recent.rs`, `settings.rs`, `template_files.rs` | IPC commands |
| `app/lib/stores/*.svelte.ts` | Reactive state |
| `app/lib/composables/app-events.svelte.ts` | Event wiring (file-changed, file-renamed, drag-drop, …) |
| `app/lib/composables/app-lifecycle.svelte.ts` | Sync timer, close-requested, beforeunload |
| `app/lib/composables/app-shortcuts.svelte.ts` | Keyboard router (dispatches via commandRegistry) |
| `app/lib/app-commands.ts` | Sole `commandRegistry.register` site |
| `app/lib/services/new-file.ts` | Scratch + smart new file + template execution |
| `app/lib/editor/formatting.ts` | Pure markdown wrap/toggle helpers |
| `app/lib/utils/*.ts` | Word count, file sort, placeholder parser, numbering, etc. |
| `app/lib/updater.ts` + updater signing | App auto-update |
| WebDAV sync (`get_sync_config`, `sync_now`) | Cross-machine sync |
| Auto-save | `tabsStore` save loop |
| Cross-window broadcast (`broadcast_file_renamed` + `file-renamed` event) | Multi-window coherence |
| Startup instrumentation (`startup-timing.ts` + `log_startup_phase`) | Perf telemetry |
| `app/lib/components/ErrorBoundary.svelte` | White-screen guard around editor |
| `app/lib/components/HelpTooltip.svelte` | Inline help UI primitive |

## Developer / diagnostics

Only useful when debugging or benchmarking. Safe to gate behind flags
or hide from end-user UI.

| Module | Purpose |
|--------|---------|
| `run-benchmark`, `run-release-benchmark`, `run-scroll-test` commands in `app-commands.ts` | Performance benchmarks |
| `app/lib/utils/benchmark.ts`, `scroll-edit-test.ts` | Benchmark implementations |
| `core/src/commands/bench.rs` | Backend benchmark IPC |
| `app/lib/components/PluginScaffoldDialog.svelte` | Plugin author onboarding |
| `tests/bench/` | Performance benchmarks |

---

## When considering changes

Ask: **which category does this module belong to?**

- **Core editor**: changes need E2E coverage before shipping. Any
  performance regression is a release blocker.
- **Core product**: the same, plus removal/hide requires user approval.
- **Infrastructure**: refactor freely, but watch for observable behavior
  changes — especially in the watcher/rename/settings triangle.
- **Diagnostics**: can move, rename, or remove without ceremony.

If you're uncertain which bucket a module belongs to, **default to core**
(bias toward preservation) and ask.
