# Scroll Stabilizer Bug — Click-After-Scrollbar-Drag Position Jump

## Summary

In a 150k-line document (`novelist-150k.md`, ~3.19 MB, 150,009+ lines), using the native scrollbar to quickly drag to a distant position and then clicking in the editor content causes the cursor and/or viewport to land on the wrong line. The document uses `createLargeFileExtensions()` (no WYSIWYG, no line wrapping, minimal CM6 extensions).

## Root Cause

CodeMirror 6 maintains a **height map** that estimates pixel heights for off-screen lines. After a fast scrollbar drag spanning tens of thousands of lines, the height map is stale:

- `posAtCoords(clientX, clientY)` is **DOM-based** and returns the **correct** document position for whatever line is rendered at the click coordinates.
- CM6's `scrollIntoView` (triggered automatically on pointer selection) uses the **stale height map** to compute where the selection "should" be on screen, and scrolls the viewport — often catastrophically wrong (e.g., jumping from scrollTop=3,163,996 back to scrollTop=0).

## Reproduction Steps

1. Open `novelist-150k.md` (150k lines, ~3 MB)
2. Click somewhere to place cursor (e.g., line 169)
3. Grab the scrollbar and drag quickly to a distant position (e.g., to around line 108,856 area)
4. Release the scrollbar
5. Click in the editor content area
6. **Observe**: the viewport jumps to a completely different position, cursor lands on wrong line

## Observed Behaviors

### Behavior A — Catastrophic viewport jump (original, no fix)

Without any scroll stabilizer, CM6's pointer handler dispatches a selection with `scrollIntoView: true`. The stale height map tells CM6 the clicked position should be visible at scrollTop ≈ 0, so the viewport jumps from scrollTop=3,163,996 all the way back to the document start.

**Log evidence:**
```
mousedown → pos=2405822 line=114409 scrollTop=3203241
selection changed → line=23 scrollTop=420          ← jumped to document start!
```

### Behavior B — Viewport offset after intercepted click

With the mousedown-intercept fix (stopPropagation + preventDefault, dispatch selection ourselves, restore scrollTop), the catastrophic jump is prevented. However, the dispatch itself causes CM6 to update its height map, which changes which lines map to the same scrollTop value. Result: the viewport shifts by ~20-40 lines even though scrollTop is restored.

**Specific case (the "line 21010" bug):**

- User is at line 137,300 (scrollTop=3,844,412)
- Scrollbar-drags to line 20,999 area (scrollTop=587,987)
- Clicks at line 21,010
- After intercept: scrollTop successfully restored to 587,987 (`restored=true`)
- **But** the viewport now starts at line 21,026 instead of 20,999 — a 27-line shift
- The cursor IS at line 21,010 (confirmed by typing), but it's **above the visible viewport** (invisible)
- The user cannot see the cursor; the viewport shows lines starting from 21,026

**Log evidence:**
```
mousedown (412,344) btn=0 detail=1
  | posAtCoords→pos=430064 line=21010
  | curSel: anchor=2909399 head=2909420 line=137300
  | scrollTop=587987
  | pending=true onScrollbar=false

INTERCEPTED → pos=430064 line=21010
  | scrollTop: saved=587987 actual=587987 restored=true
  | pending now=false
```

Despite `restored=true`, the next click at the same screen coordinates resolves to a different line:
```
mousedown (650,184) → posAtCoords→pos=2374347 line=112978
```

This confirms the same scrollTop now maps to different lines after the height-map update.

### Behavior C — CM6's dispatch shifts scrollTop

Even without `scrollIntoView`, our `dispatch({ selection: { anchor: pos } })` triggers CM6's update cycle which re-measures visible lines and updates the height map. This can cause scrollTop to shift:

**Case where CM6 adjusts scrollTop during dispatch:**
```
before=0  cm6Adjusted=768  ← CM6 moved scrollTop by 768px during dispatch
```

**Case where CM6 does NOT adjust (common):**
```
before=3047753  cm6Adjusted=3047753  ← no change by CM6
```

### Behavior D — Empty dispatch({}) causes ~800px shift

An attempt to sync CM6's internal state by dispatching an empty transaction after scrollTop restoration caused CM6's height-map correction to shift scrollTop by ~800-900px — making things **worse** in the common case where CM6 didn't adjust during the selection dispatch.

```
before=3047753  cm6Adjusted=3047753  restored=3047753  final=3046902
                                                        ↑ empty dispatch shifted by 851px
```

### Behavior E — Re-triggering: second click also intercepted

The scroll caused by our dispatch triggers an async scroll event. If the `dispatching` flag is cleared synchronously (before the async event fires), `onScroll` sees a large delta and re-arms `largeScrollPending = true`. This causes the second click to also be intercepted, breaking drag-select and requiring a third click.

**Fix:** Clear `dispatching` flag via `requestAnimationFrame` so async scroll events are blocked.

## Key Constraints

1. **`posAtCoords` is correct** — it uses the DOM and returns the right line for whatever is rendered on screen.
2. **`coordsAtPos` is unreliable for off-screen positions** — it uses the height map, which is the very thing that's wrong.
3. **Any `dispatch()` can shift scrollTop** — CM6's update cycle includes height-map correction that adjusts scrollTop to maintain viewport stability. This is internal and cannot be prevented.
4. **`scrollTop` restoration can be clamped** — if the dispatch changes `scrollHeight`, the browser may clamp our restored value.
5. **Same scrollTop ≠ same lines** — after a height-map update, the mapping from scrollTop to visible lines changes.

## Current Fix (mousedown intercept approach)

```
1. Detect large scroll (Δ > 0.5 × viewport) → set largeScrollPending = true
2. On mousedown (capture phase), if pending:
   a. posAtCoords → get correct document position
   b. stopPropagation + preventDefault → block CM6's handler
   c. dispatch({ selection: { anchor: pos } }) → no scrollIntoView
   d. Restore scrollTop to pre-dispatch value
   e. Clear settleTimer to prevent post-intercept measurement cascade
   f. dispatching=true, cleared via requestAnimationFrame
```

**What works well:**
- Prevents the catastrophic jump (Behavior A)
- Cursor is at the correct document position
- Second click works normally (drag-select, double-click)
- No post-intercept viewport shift (Behaviors B/C fixed)

**Why drift compensation was removed:**
Even a 3-4px scrollTop change for drift compensation triggers:
scroll event → settleTimer (150ms) → requestMeasure() → CM6 height-map
correction → ~740px viewport shift.  The sub-pixel drift (0-4px, < 1/7
line height) is imperceptible; the cascade it triggered was not.

**Remaining known issue:**
- Sub-pixel cursor offset (0-4px) — imperceptible in practice

## Alternative Approach (transactionFilter)

Strip `scrollIntoView` from `select.pointer` transactions using `EditorState.transactionFilter`. This lets CM6 handle the click normally but prevents the stale-height-map scroll. Key issue: the scrollIntoView flag in CM6 is stored as an **effect** in `tr.effects`, not just as a boolean. Must omit effects when rebuilding the transaction, not just set `scrollIntoView: false`.

## Test File

See `src/lib/editor/scroll-stabilizer.test.ts` for state-machine tests covering:
- Guard activation/deactivation
- Boolean flag (no timeout race)
- dispatching flag blocks async scroll re-triggering
- Scrollbar clicks don't consume the guard
- Multiple scroll-click cycles
- Regression cases from actual user sessions
