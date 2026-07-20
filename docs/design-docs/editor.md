# Editor (CodeMirror 6) Architecture

Novelist's editor is CodeMirror 6 with extensive custom decoration and
interaction work. These invariants have been stabilized through real
regressions — preserve them when touching anything under `app/lib/editor/`.

## Large file handling — four tiers

Four modes, picked by file size and line count:

- **Normal** (< 1MB, ≤ 5000 lines): Full WYSIWYG + stats.
- **Tall doc** (< 1MB, > 5000 lines): No WYSIWYG decorations, flat heading
  sizes — prevents CM6 height-map drift that causes click-after-scroll jump
  bugs.
- **Large** (1-3.5MB): Stripped editable extensions, reduced stat frequency.
- **Huge** (≥ 3.5MB): Stripped read-only CodeMirror state. Rust-backed
  viewport editing is a future design and is not wired into `Editor.svelte`.

**Why tall-doc mode exists**: CM6 estimates heights for off-screen lines.
WYSIWYG decorations (heading font-size changes, blockquote styling, etc.)
only apply within the viewport. The difference between estimated and actual
heights accumulates as the user scrolls, causing `posAtCoords` (click →
document position) to land on the wrong line. For documents > 5000 lines,
this drift becomes user-visible. The fix: disable all height-changing
decorations and use uniform heading font sizes via
`flatNovelistHighlightStyle` in `app/lib/editor/setup.ts`.

Huge-file scroll stabilizer: see `docs/design-docs/scroll-stabilizer-bug.md`
for the three-layer native guard that prevents catastrophic `scrollTop`
jumps after scrollbar-drag in 150k+ line files.

## CM6 block widget decorations (images)

Image rendering uses `Decoration.replace({block: true, widget})` via a
`StateField` in `app/lib/editor/wysiwyg.ts`. Key lessons learned:

- **Use single block replace, not widget+hide**: A single
  `Decoration.replace({block: true, widget}).range(line.from, line.to)`
  produces one height-map entry. The old approach (3 decorations: widget +
  line class + inline replace) created misaligned height-map entries causing
  `posAtCoords` click offsets proportional to image height.
- **Cursor-line toggle is allowed, but pointer events must be filtered**:
  The image widget collapses when the cursor enters its line (so the user
  can edit `![alt](url)` source — e.g. fix a broken path). Implemented via
  `cursorImageLineField`. The earlier rule "must NOT toggle on cursor
  position" was rooted in a real regression: toggling during a click
  (`select.pointer` events) shifts the height map between mousedown and
  mouseup, causing infinite cursor oscillation. The current implementation
  filters out `select.pointer` transactions, so the widget only collapses
  on keyboard nav / typing / focus events — never mid-click. Initial state
  is `null` so doc-open with cursor at pos 0 doesn't hide the first image.
- **Block decorations must be provided via StateField**: Only
  `StateField.provide(f => EditorView.decorations.from(f))` makes CM6
  account for block widget heights in its height map. `ViewPlugin`
  decorations don't.
- **No CSS vertical margin on block widgets**: CM6 cannot see CSS margin.
  Use `padding` inside the widget instead.
- **CSS `zoom` breaks CM6**: The app's zoom feature must use
  `transform: scale()` (which CM6 detects via `scaleX`/`scaleY`), NOT
  `document.documentElement.style.zoom` (which CM6 doesn't understand). CSS
  zoom causes `posAtCoords` to return wrong positions because
  `getBoundingClientRect` and internal height-map coordinates become
  inconsistent. See `app/lib/stores/ui.svelte.ts` `setZoom()`.
- **`requestMeasure()` after async image load**: When image loads
  asynchronously, call `view.requestMeasure()` followed by
  `view.dispatch({ effects: [] })` to force CM6 to re-measure block heights.
  `requestMeasure()` alone may skip height measurement if `contentDOMHeight`
  hasn't visibly changed.
- **No duplicate gutter markers**: With `Decoration.replace({block: true})`,
  CM6's line number gutter automatically generates a line number for the
  replaced range. Do NOT add a `lineNumberWidgetMarker` — it creates
  duplicate line numbers.

Regression coverage: 21 tests in
`tests/unit/editor/image-block-deco.test.ts` covering decoration strategy,
height map, coordinate mapping, zoom impact.

## Editable tables (Typora-style)

`app/lib/editor/table.ts`. GFM tables are **always** rendered as a styled
`<table>` widget (block `Decoration.replace` via `tableBlockDecoField`,
StateField — block decos must not come from a ViewPlugin). Unlike math/mermaid,
the cursor entering the table does **not** reveal raw markdown: cells are
`contenteditable` and edited in place. Hard-won details:

- **Cell editing is an isolated island.** Cells are `contenteditable=true`
  inside a `contenteditable=false` wrapper; `ignoreEvent()` returns `true` so
  CM6 doesn't process widget events. Keyboard/input events that originate in a
  cell are `stopPropagation()`-ed at the wrapper so CM6's keymap/input handling
  never fires. **`Mod+A` must be handled manually** (select the cell's
  contents): WebKit's native select-all otherwise targets the outer
  `.cm-content` editing host, selecting the whole document and stealing focus.
- **Commit timing.** Edits commit back to the markdown source on `focusout`
  that leaves the table (and on `Escape`), and immediately on any structural
  change. `commitFromDom` reads cell text via `cellDomToMarkdown`, keeps
  alignments from the current source, and dispatches one replace transaction.
  Commit is skipped mid-IME-composition and deferred to `compositionend`.
- **`updateDOM` preserves focus.** A commit changes the doc → the StateField
  rebuilds the widget. `TableWidget.updateDOM` patches non-focused cells in
  place and returns `true` when the shape is unchanged, so cell focus/caret
  survive. It returns `false` on a shape change (add/remove row/col) to force a
  fresh DOM; `tableFocusPlugin` then restores focus to the intended cell via a
  module-level `pendingFocus` keyed by the table's source-range start.
- **Range is resolved fresh, never stored.** `currentTableRange` uses
  `view.posAtDOM(tableEl)` + the syntax tree, so commits stay correct after
  edits to other tables shift positions.
- **Serialization is compact** (`| a | b |`, no column realignment) for clean
  diffs; literal `|` in a cell is escaped to `\|`. Structural ops
  (`insertRow`/`deleteRow`/`insertColumn`/`deleteColumn`/`setAlignment`) are
  pure model transforms. Both a focus-anchored toolbar (row + column gutters)
  and a right-click context menu (reusing the global `.context-menu` classes)
  trigger them.

Coverage: pure logic in `tests/unit/editor/table.test.ts` (parse, serialize,
DOM→markdown, model ops); interaction in `tests/e2e/specs/table-edit.spec.ts`
(edit/commit, Tab-append-row, CJK, context-menu delete, Escape, toolbar).

## Slash command menu

Notion-style `/` block-insertion menu, implemented in
`app/lib/editor/slash-commands.ts`. Three extensions cooperate:

- `slashMenuField` (`StateField<SlashMenuState | null>`) — source of truth.
  Mutated only via the `showSlashMenu` `StateEffect`. Doc-change path
  re-maps `pos` and drops the field if the `/` is deleted or the preceding
  context is no longer line-start-only-whitespace.
- `slashTriggerHandler` (`EditorView.inputHandler`) — fast path. When text
  is `/` or full-width `／` (U+FF0F) and the prefix on the current line
  trims to empty, it dispatches a single transaction that inserts `/`,
  advances the cursor, and emits the `showSlashMenu` effect.
- `slashMenuPlugin` (`ViewPlugin`) — owns the widget DOM. Creates a
  `SlashMenuWidget` when the field becomes active; updates the filter query
  as the user types; destroys the widget on `destroy()` or when the field
  clears. Also contains the IME fallback: when a transaction changes the
  doc, no field is set, and the char before the cursor is `/` / `／` at
  line start, the plugin schedules (via `queueMicrotask`) a
  `showSlashMenu` dispatch.
- `slashKeyHandler` (`EditorView.domEventHandlers` wrapped in
  `Prec.highest`) — consumes ArrowUp/Down/Enter/Tab/Escape while the menu
  is open. **Precedence matters**: `defaultKeymap` binds arrows to
  `cursorLineUp/Down`, and without `Prec.highest` the keymap wins and the
  cursor moves instead of the menu selection. Regression test:
  `tests/integration/editor/slash-runtime.test.ts` "ArrowDown moves selection in
  menu without moving editor cursor".

### Widget positioning

**Must not be synchronous inside `update()`**, and direction is chosen
*before* the menu becomes visible:

- The plugin runs before CM6's measure/layout cycle, so
  `view.coordsAtPos(slashPos)` on a just-inserted character can return
  `null`. The original implementation called `destroy()` on null —
  resulting in the menu being created and immediately removed, with no
  visible response to the user.
- Fix: `SlashMenuWidget` appends with `visibility: hidden`, then calls
  `view.requestMeasure({read, write})` to resolve coords in the next read
  phase. If `coordsAtPos` is still null, we retry up to 5 rAF frames
  (covers WKWebView cases where the first measure races the inserted
  glyph). Fallback side `-1` (one char left of `/`) is tried to cover
  end-of-doc / EOL associativity.
- Flip direction in `applyPosition` (no post-hoc re-clamp): measure the
  hidden menu, then pick below-cursor if `spaceBelow ≥ menuH + gap`,
  otherwise above-cursor, otherwise whichever side has more room with a
  viewport clamp. All decisions made before `visibility: visible` is
  flipped so there's no one-frame flash at the wrong position.
  `updateQuery` re-runs positioning because filtering the item list
  changes `menuH`.

Trigger rule is intentionally restrictive — `/` only fires when everything
before it on the line is whitespace. If a looser (Notion-style mid-line)
trigger is needed, relax the `textBefore.trim() !== ''` guard in both
`slashTriggerHandler` and the `slashMenuPlugin` fallback.

i18n labels flow through `setSlashCommandI18n(Map<id, {label, description}>)`;
`Editor.svelte.onMount` populates the map from the current locale. Keys live
under `slash.*` in `app/lib/i18n/locales/*.ts`.

Icons are inline SVG strings (24×24 viewBox, `currentColor` stroke) defined
at the top of `slash-commands.ts` and rendered via `innerHTML` into
`.cm-slash-menu-icon`. CSS (`wysiwyg.css`) sizes the child `<svg>` to 20×20
and swaps the icon color to `--novelist-accent` on the selected row. No
emoji — keeps rendering consistent across locales and WebKit font fallbacks.

Tests: `tests/integration/editor/slash-runtime.test.ts` builds a real
`EditorView` to exercise the trigger, fallback, widget lifecycle
(hidden-until-positioned, no self-destroy on null coords), and keyboard close
behavior.

## Unified selection background

**Do not touch without reading this section end-to-end.** This subsystem
has been broken and repaired three times (2026-04-17, 2026-04-21a,
2026-04-21b) and each regression came from a plausible-looking edit that
missed one of the invariants below.

### Why we don't use CM6's default selection paint

CM6's built-in `drawSelection` computes the selection rectangles in
`rectanglesForRange` (in `@codemirror/view/dist/index.cjs`) using:

```
leftSide = contentRect.left + parseInt(firstLine.paddingLeft)
```

That adds only the **`.cm-line`** padding to the `.cm-content` rect's
left. Our theme puts horizontal padding on `.cm-content` (`3rem 1.5rem`),
**not** on `.cm-line` (which only has `0 0.25rem`). So `leftSide` lands
~24px to the left of where the actual text starts. First/last-line rects
use `coordsAtPos` (i.e. the real glyph position), so those align with
the text — middle-line "between" rects use `leftSide` and don't. The
result is a ~19px stair-step on the left edge of any multi-line
selection, most visible across heading lines because the height deltas
make the offset obvious. For that reason `.cm-selectionBackground` is
forced `transparent !important` in the theme; those rects must never
render. `selection-geometry.spec.ts` guards this invariant.

### The three-layer paint system

Selection backgrounds are painted from three coordinated places:

1. **`.cm-line.cm-novelist-selected-line`** (line decoration emitted by
   `app/lib/editor/selection-line.ts`) — covers **fully-covered logical
   lines**: middle lines of a multi-line selection, empty lines inside a
   range, and single-line selections whose extent equals the whole line.
   Paints `18%` accent across the entire `.cm-line` div, so empty lines
   and wrapped full lines are continuous rectangles.

2. **Native browser `::selection`** (theme rule in
   `app/lib/editor/setup.ts`) — covers **partial ranges**: the first /
   last line of a multi-line selection when the caret stops mid-line,
   and any single-line partial selection. Painted at `18%` accent too.
   This must be native `::selection` (not `Decoration.mark`) because
   browsers render `::selection` via the text engine, so on a logical
   line that wraps into several visual rows the continuation rows fill
   to the container's right edge — a wrap-aware behavior an inline-span
   background cannot reproduce (a `<span>` background ends at the last
   glyph of each wrapped fragment, producing a ragged per-word look).

3. **Suppression inside fully-selected lines** — `::selection` is
   forced `transparent` inside `.cm-line.cm-novelist-selected-line` to
   prevent layer 1 and layer 2 from stacking on characters of a fully
   selected line (which would tint glyphs ~33% while the rest of the
   line is still 18%, making "selected text" look brighter than the
   whitespace around it).

All three use the same 18% accent tint — so partial, full, and
mixed multi-line selections settle at one visually identical color.

### The CSS specificity trap

`drawSelection` installs an internal extension called
`hideNativeSelection` at **`Prec.highest`** that emits:

```
.cm-theme_<hash> .cm-line ::selection { background-color: transparent !important }
```

Specificity is `(0,2,1)` and `!important` is set. A naïve theme rule of
just `'::selection': { ... }` scopes to `.cm-theme_<hash> ::selection`
→ `(0,1,1)` and loses. Our rule **must** outrank it, so we write:

```
'.cm-content .cm-line ::selection, .cm-content .cm-line::selection': {
  backgroundColor: '… 18% …!important',
}
```

The extra `.cm-content` ancestor takes specificity to `(0,3,1)` and the
`!important` ties the tiebreak. The suppression rule for fully-selected
lines adds one more class (`.cm-novelist-selected-line`) for `(0,4,1)`,
so it beats our own "paint" rule.

**If you simplify the selector, CM6's `hideNativeSelection` will silently
reclaim `::selection` and partial selections will render invisible.**
Verify by opening the devtools Styles pane on a `.cm-line` inside a
selection: you should see our rule winning.

### Invariants — things that must stay true

| # | Invariant | Guard |
|---|-----------|-------|
| 1 | `.cm-selectionBackground` computes to a fully transparent color | `selection-geometry.spec.ts` → `native drawSelection backgrounds are suppressed` |
| 2 | Every `.cm-novelist-selected-line` element shares one left x-coordinate | `selection-geometry.spec.ts` → `all selected-line backgrounds share a single left x-coordinate` |
| 3 | Partial single-line selections produce a visible `::selection` paint (not transparent) | `selection-geometry.spec.ts` → `partial single-line selection paints a non-transparent ::selection` |
| 4 | Partial-and-full selections produce the same computed RGB background on selected pixels | `selection-geometry.spec.ts` → `partial and full-line selection tints match` |
| 5 | A multi-row wrapped partial selection fills each non-terminal visual row to the container's right edge | `selection-geometry.spec.ts` → `wrapped partial selection fills continuation rows` |
| 6 | `buildSelectionDecorations` emits line decorations **only** for fully-covered lines | `tests/unit/editor/selection-line.test.ts` |

### Where to change things

- **Decoration logic (what lines get a line deco):**
  `app/lib/editor/selection-line.ts` — pure builder
  `buildSelectionDecorations(doc, selection)` is unit-tested in
  `tests/unit/editor/selection-line.test.ts` with
  `[precision][regression]` tag.
- **Selection colors / CSS selectors / specificity:** the `novelistTheme`
  block in `app/lib/editor/setup.ts` around lines 295–335. All three
  paint layers and their specificity notes live there in one span so
  changes stay coordinated.
- **Visual / geometry assertions:**
  `tests/e2e/specs/selection-geometry.spec.ts` — runs against a real
  browser so CSS specificity wars are actually observable.

### Why not revert to `Decoration.mark` for partial lines?

We tried. An inline `<span>` wrapping the selected text with a
background works for unwrapped lines, but on any logical line that
wraps across visual rows the background box ends at each wrap's last
glyph instead of the container's right edge, so a long partial
selection looks like a stack of ragged per-word ribbons. CSS
`box-decoration-break: clone` and pseudo-element tricks don't fix this —
inline fragment backgrounds are fundamentally glyph-bound. Native
`::selection` is the only mechanism that paints the full continuation
row, so that's what we use.

## Block transforms and structural hierarchy

Block formatting is one command surface backed by
`app/lib/editor/block-transform.ts`. The 12 targets are **Paragraph**,
**Heading 1** through **Heading 6**, **Quote**, **Unordered List**,
**Ordered List**, **Task List**, and **Fenced Code**. Their stable command IDs
are registered once in `app/lib/app-commands.ts`; the command palette, editor
context menu, native menu bridge, and global shortcut router dispatch command
IDs through `commandRegistry.execute()` rather than maintaining parallel
handlers. Block commands without an assigned shortcut remain registry commands;
the routing architecture does not imply an undocumented shortcut.

Selected-`>` interception and structural Tab/Shift+Tab are installed in the
normal, tall-document, and editable large-file extension sets. Large-file mode
keeps its parser/WYSIWYG/slash-menu omissions, but includes the constant-time
IME guard and the local structural handlers; structural hierarchy remains
before generic `indentWithTab`. The optional slash-menu field lookup is closed
when that extension is absent. Huge read-only mode omits all editing handlers.
Saved editor states are root-reconfigured with the current tier extensions
before restoration, preserving history without carrying stale editing handlers
across normal/large/read-only boundaries.

The following table is the durable behavior contract. Test titles are quoted
exactly so changes can be audited against executable coverage.

| Area | Contract | Automated guards |
|---|---|---|
| Command surface | Every target has one stable `editor-block-*` registration. Palette and context-menu actions invoke the same transform and each command action executes the registry once. A transforming palette action has one document-changing dispatch; a context-menu action first makes a selection-only dispatch to restore its snapshot, then the transform dispatches once. No-op and IME-refused transforms do not dispatch a document change. | `tests/unit/app-commands.test.ts` - `registers every BlockTransformTarget under one stable command id exactly once`, `%s passes the active EditorView to target %s`; `tests/e2e/specs/command-palette.spec.ts` - `Convert to Task List matches the context command without duplicate dispatch @task23`, `Enter dispatches the selected Block Type command through the registry exactly once`; `tests/unit/composables/menu-events.test.ts` - `dispatches the payload command ID through commandRegistry.execute`; `tests/unit/composables/app-shortcuts.test.ts` - `Cmd+B dispatches the bold formatting command` |
| Logical-line selection | A cursor acts on its current logical line. A nonempty partial, reversed, CJK, or multi-range selection expands to every touched logical line, deduplicates overlaps, maps every anchor/head while preserving direction and `mainIndex`, and leaves untouching lines unchanged. | `tests/unit/editor/block-transform.test.ts` - `expands partial selections to touched full lines`, `maps CJK selection positions through inserted block prefixes`, `deduplicates touched lines across multiple ranges`, `maps all selection ranges and preserves mainIndex for multi-range edits`, `preserves reversed anchor/head direction while mapping selections` |
| Normalize or toggle | Mixed paragraph/heading/quote/list/task lines first lose prefixes recognized by the transform parser, then receive the requested target without content loss. Only when every selected nonblank line already matches the requested non-paragraph target does that target toggle the selection to paragraphs. Paragraph removes the recognized prefixes. Empty-document paragraph is a no-op. | `tests/unit/editor/block-transform.test.ts` - `toggles an all-target heading selection back to paragraphs`, `toggles an all-target %s selection back to paragraphs`, `normalizes mixed block types to the requested heading without content loss`, `converts any supported block target back to paragraph text`, `returns null for an empty document no-op cursor selection` |
| Indentation, markers, and blanks | Prefix recognition consumes zero or more leading quote markers, then at most one heading marker and one task, unordered, or ordered-list marker, in that order. Indentation attached to a recognized list/task marker is retained separately from the removable marker and checkbox: list-family conversions and all-target paragraph toggles preserve it. Other content whitespace and lines outside the touched set are not silently rewritten. Non-code transforms leave blank lines blank. Unordered-list normalization preserves existing `-`, `*`, or `+` markers. Ordered lists renumber from `1` per contiguous nonblank selected group. Task-list normalization preserves an existing checkbox state and a compatible `-` or `*` marker from task/UL input; unsupported `+` or markerless input deterministically receives `-`, and non-task input receives an unchecked box. This transform rule does not make `+` eligible for structural Tab hierarchy. | `tests/unit/editor/block-transform.test.ts` - `peels nested quote/list/task prefixes while preserving list indentation for paragraph`, `normalizes nested quote/list/task content to a task list without losing text`, `keeps blank lines unprefixed for non-code transforms`, `preserves existing unordered markers when normalizing mixed lines to unordered list`, `renumbers ordered lists deterministically per contiguous nonblank group`, `preserves existing task checkbox state when normalizing to task list`, `preserves supported markers, checkbox state, and indentation in mixed task-list normalization`, `uses the unchecked dash fallback for unsupported or markerless mixed task-list input`, `preserves supported task markers and indentation when converting tasks to unordered list`, `preserves indentation when an all-target %s selection toggles to paragraph`; `tests/integration/editor/block-transform-runtime.test.ts` - `preserves mixed task markers, check state, indentation, and partial CJK selection through one undo` |
| Fenced code | Fenced Code wraps each selected contiguous line group with a backtick fence longer than any run in its body. A selection inside one unindented backtick or tilde block recognized by the transform parser unwraps only that enclosing block; a closing fence is not an opener and plain text between adjacent blocks is not absorbed. | `tests/unit/editor/block-transform.test.ts` - `wraps selected lines in a safe fenced code block`, `toggles an existing fenced code block back to its body`, `unwraps a tilde fenced block with a longer compatible closing fence`, `does not treat a closing fence line as an opener`, `does not unwrap across plain text between fenced blocks`, `unwraps only the adjacent fenced block containing the selection` |
| Transaction, IME, and undo | A transform dispatches one CodeMirror transaction. Active IME composition returns `false` without changing document or selection; after composition settles, the command may run. One undo restores the exact source and selection, including multi-range direction and `mainIndex`. | `tests/integration/editor/block-transform-runtime.test.ts` - `dispatches one undoable transaction and restores source plus selection`, `unwraps code fences with one undo restoring all ranges and mainIndex`, `refuses to dispatch while IME composition is active, then runs after composition ends` |
| Selected `>` input | Exact `>` input is intercepted only when CodeMirror's input-handler `from/to` replacement range is nonempty. That provided range alone chooses touched whole lines; unrelated live selections are not transform targets. CodeMirror's canonical selection mapping preserves direction, `mainIndex`, range metadata, and endpoint association through the one transaction. Selected CJK text, focus, and one-step undo remain intact. Collapsed `>` typing and any other replacement text follow ordinary CodeMirror input. Active IME composition and an open slash menu bypass interception. | `tests/integration/editor/structural-hierarchy-runtime.test.ts` - `converts exact selected > replacement to quotes without deleting selected CJK text`, `uses the nonempty input replacement range instead of an unrelated current selection`, `does not intercept a collapsed input range because another selection is nonempty`, `transforms only the provided range while mapping every current selection range`, `keeps an unrelated forward selection outside an inserted quote at its endpoint`, `keeps an unrelated reversed selection outside an inserted quote at its endpoint`, `ignores ordinary replacement text and empty-selection > typing`, `lets CodeMirror apply ordinary replacement and collapsed > input`, `bypasses selected > conversion during IME composition`, `bypasses selected > conversion while the slash menu is open`, `wires selected > conversion in normal editor setup`, `wires selected > conversion in tall editor setup`, `wires selected > conversion in large editor setup`, `reconfigures saved state across editable and read-only structural mode boundaries`, `keeps structural input and hierarchy disabled in huge read-only setup`; `tests/e2e/specs/editor-context-menu.spec.ts` - `typing > over selected CJK text converts whole lines and preserves focus @task23` |
| Structural Tab / Shift+Tab | Before generic `indentWithTab`, Tab nests touched Quote lines by adding one quote level and nests `-`/`*` unordered and task lines by two spaces; Shift+Tab removes one level. A cursor affects its current line, and a selection acts only when every touched nonblank line is supported. Markers and checkbox state are preserved. Ordered lists, `+` lists, plain text, mixed structural/plain selections, and an open slash menu fall through to existing handling. Outdent at the hierarchy floor is a no-op with no transaction. | `tests/integration/editor/structural-hierarchy-runtime.test.ts` - `nests and unnests quote, unordered, and task lines while preserving markers and checkboxes`, `nests selected structural lines as one undoable transaction`, `uses current-line behavior for cursor Tab and has a deterministic Shift+Tab floor`, `falls through for ordered lists, plus-marker lists, ordinary text, and mixed selections`, `bypasses structural Tab while slash menu is open`, `bypasses structural Tab during IME composition and resumes after composition ends`, `maps multi-range selections through one structural transaction`, `keeps a forward hierarchy range outside the next line's inserted indent`, `keeps a reversed hierarchy range outside the next line's inserted indent`, `keeps structural hierarchy ahead of generic Tab in normal editor setup`, `keeps structural hierarchy ahead of generic Tab in tall editor setup`, `keeps structural hierarchy ahead of generic Tab in large editor setup`, `routes ordered, plus, and plain Tab through generic indent in normal editor setup`, `routes ordered, plus, and plain Tab through generic indent in tall editor setup`, `routes ordered, plus, and plain Tab through generic indent in large editor setup`, `keeps structural input and hierarchy disabled in huge read-only setup`; `tests/e2e/specs/editor-context-menu.spec.ts` - `Tab and Shift+Tab preserve list and task hierarchy selection and focus @task23` |
| Context-menu restoration | The context menu snapshots `{from, to}` when opened. Before a block command executes it restores that forward range, dispatches through the registry, then restores editor focus. Unit and mocked-browser tests model the live range collapsing after right-click. One undo restores the tested pre-command text and forward selection; anchor/head direction is not retained by the snapshot. | `tests/unit/composables/editor-context-menu.test.ts` - `restores the snapshot range before dispatching the registered command`; `tests/e2e/specs/editor-context-menu.spec.ts` - `Block Type > Quote restores a three-line CJK selection and remains one-step undoable @task23` |

Do not describe block commands as unconditional toggles: mixed selections
normalize to the requested target. Do not intercept ordered-list or ordinary
text Tab in the structural hierarchy extension; their behavior belongs to the
later generic CodeMirror keymaps.

Both selected-`>` and structural hierarchy implementations check active IME
and open-slash-menu state before dispatch. The regression matrix independently
covers all four combinations: selected `>` during IME and while slash-open,
plus structural Tab during IME and while slash-open.

## Editor right-click menu

Right-clicking inside `.cm-content` shows a styled custom menu that matches
the app theme instead of the native WKWebView "Reload / Inspect Element"
menu. Lives in `app/lib/composables/editor-context-menu.svelte.ts`
(post-2026-04-20; previously inline in `App.svelte`) with aliases that let
App's markup stay byte-identical. Renders with the shared `.context-menu` /
`.context-menu-item` classes (promoted to `app/app.css` so the styling also
applies in zen mode, where `Sidebar.svelte` isn't mounted). The menu shows
Cut / Copy / Copy-as-Rich-Text / Copy-as-Plain-Text when a selection
exists, plus Paste / Select All in every state.

Two subtleties:

- **Snapshot the selection range at menu-open time.** WKWebView's
  right-click mousedown can collapse or move the CM selection before the
  user clicks a menu item, so the composable stores `{from, to}` captured
  in the `oncontextmenu` handler. Cut/Copy read from that snapshot;
  Copy-as-Rich/Plain go through `editorCtx.runCommand(id)`, which restores
  the snapshot selection before invoking the existing `copy-rich-text` /
  `copy-plain-text` command-palette handlers.
- **Other editable surfaces keep the native menu.** The window-level
  `oncontextmenu` only intercepts `.cm-content`; `input`, `textarea`, and
  other `contenteditable` widgets still get the OS text menu so
  spell-check / Look Up stay available. All non-editable chrome continues
  to have the native menu suppressed.

Regression coverage: `tests/e2e/specs/editor-context-menu.spec.ts`
(selection-state item visibility, Esc/outside-click dismissal, Select All
behavior, Cut actually mutating the doc, and non-editor chrome not opening
the editor menu).

## Editor formatting helpers

Pure functions of `EditorView` in `app/lib/editor/formatting.ts`:
`wrapSelection(view, before, after)`, `toggleWrap(view, marker)`,
`toggleLinePrefix(view, prefix)`. Used by the bold/italic/link/heading/
code/strikethrough keyboard shortcuts and palette commands. `toggleWrap`
handles three cases (marker inside selection → strip; marker just outside
selection → strip; otherwise wrap), with a special-case for single `*` to
avoid splitting `**bold**` runs.
