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
- **Large** (1-10MB): Stripped extensions, reduced stat frequency.
- **Huge** (> 10MB): Read-only via rope backend.

**Why tall-doc mode exists**: CM6 estimates heights for off-screen lines.
WYSIWYG decorations (heading font-size changes, blockquote styling, etc.)
only apply within the viewport. The difference between estimated and actual
heights accumulates as the user scrolls, causing `posAtCoords` (click →
document position) to land on the wrong line. For documents > 5000 lines,
this drift becomes user-visible. The fix: disable all height-changing
decorations and use uniform heading font sizes via
`flatNovelistHighlightStyle` in `app/lib/editor/setup.ts`.

Huge-file scroll stabilizer: see `docs/design/scroll-stabilizer-bug.md`
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
- **Block decorations must NOT toggle on cursor position**: Toggling changes
  the height map between mousedown/mouseup, causing infinite cursor
  oscillation.
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
  `tests/unit/editor/slash-runtime.test.ts` "ArrowDown moves selection in
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

Tests: `tests/unit/editor/slash-commands.test.ts` covers
template/insertion logic (pure functions);
`tests/unit/editor/slash-runtime.test.ts` builds a real `EditorView` to
exercise the trigger, fallback, widget lifecycle (hidden-until-positioned,
no self-destroy on null coords), and keyboard close behavior.

## Unified selection background

CM6's `drawSelection` paints first-line and middle-line rects in different
coordinate frames, leaving a ~19px stair-step on the left edge across
heading lines. We neutralize this by making `.cm-selectionBackground`
transparent (keeping it only for cursor/caret rendering) and painting
selections ourselves in `app/lib/editor/selection-line.ts` via a hybrid:

- **Fully-covered lines** → `Decoration.line`
  (`cm-novelist-selected-line`) — uniform full-line background, handles
  middle lines and empty lines inside the range.
- **Partial lines** → no decoration; the theme's native `::selection`
  rule (same 18% accent tint) paints the selected text. This matters for
  wrapped lines: native selection fills continuation visual rows to the
  container's right edge, while an inline-span `Decoration.mark` would
  end each wrapped row at its last glyph and look ragged. To stop the
  two layers stacking on fully-selected lines that contain text,
  `::selection` is forced transparent inside `.cm-novelist-selected-line`.

Regression tests in `tests/e2e/specs/selection-geometry.spec.ts` and
`tests/unit/editor/selection-line.test.ts`.

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
