# Novelist Phase 2: WYSIWYG Decorations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the plain Markdown editor from Phase 1 into a near-Typora WYSIWYG experience where syntax markers are hidden when the cursor is away and revealed when the cursor enters.

**Architecture:** A single CM6 `ViewPlugin` reads the Lezer Markdown syntax tree on every update, builds a `DecorationSet` that hides syntax markers and applies visual styling. A cursor-awareness layer tracks which syntax node the cursor is inside and excludes those nodes from decoration hiding — revealing their raw Markdown. An IME guard freezes decoration updates during CJK input composition.

**Tech Stack:** CodeMirror 6 (ViewPlugin, Decoration, WidgetType, syntax tree), Lezer Markdown parser (already included via `@codemirror/lang-markdown`)

**Spec:** `design/design-overview.md` sections 5.1, 5.1.1

**Scope:** Covers inline decorations (bold, italic, code, links), heading decorations, block decorations (blockquotes, code blocks), todo checkboxes, IME guard, and cursor transition smoothing. Tables are deferred (post-MVP complexity).

---

## File Structure (Phase 2)

All new/modified files are in `src/lib/editor/`:

```
src/lib/editor/
├── setup.ts                    # MODIFY: add WYSIWYG extensions to editor config
├── wysiwyg.ts                  # NEW: core WYSIWYG ViewPlugin + decoration builder
├── wysiwyg-widgets.ts          # NEW: WidgetType subclasses (checkbox, image, code block header)
├── ime-guard.ts                # NEW: IME composition event detection
└── wysiwyg.css                 # NEW: styles for WYSIWYG decorations
```

---

### Task 1: WYSIWYG Core Infrastructure

**Files:**
- Create: `src/lib/editor/wysiwyg.ts`
- Create: `src/lib/editor/wysiwyg.css`
- Modify: `src/lib/editor/setup.ts`
- Modify: `src/app.css`

This task builds the foundation: a ViewPlugin that walks the Lezer syntax tree, identifies Markdown syntax nodes, and creates decorations. It includes cursor-awareness (nodes containing the cursor keep their markers visible).

- [ ] **Step 1: Create wysiwyg.css with decoration styles**

Create `src/lib/editor/wysiwyg.css`:

```css
/* Hidden syntax markers */
.cm-novelist-hidden {
  font-size: 0;
  width: 0;
  display: inline;
  overflow: hidden;
}

/* Headings */
.cm-novelist-h1 { font-size: 1.8em; font-weight: 700; line-height: 1.3; }
.cm-novelist-h2 { font-size: 1.5em; font-weight: 700; line-height: 1.3; }
.cm-novelist-h3 { font-size: 1.25em; font-weight: 600; line-height: 1.4; }
.cm-novelist-h4 { font-size: 1.1em; font-weight: 600; line-height: 1.4; }
.cm-novelist-h5 { font-size: 1.0em; font-weight: 600; line-height: 1.4; }
.cm-novelist-h6 { font-size: 0.95em; font-weight: 600; line-height: 1.4; color: var(--novelist-text-secondary); }

/* Inline styles */
.cm-novelist-bold { font-weight: 700; }
.cm-novelist-italic { font-style: italic; }
.cm-novelist-bold-italic { font-weight: 700; font-style: italic; }
.cm-novelist-strikethrough { text-decoration: line-through; }
.cm-novelist-inline-code {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 0.9em;
  background: var(--novelist-code-bg);
  border-radius: 3px;
  padding: 1px 4px;
}

/* Links */
.cm-novelist-link-text {
  color: var(--novelist-link-color);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--novelist-link-color) 40%, transparent);
  cursor: pointer;
}

/* Blockquote */
.cm-novelist-blockquote {
  border-left: 3px solid var(--novelist-blockquote-border);
  padding-left: 12px;
  color: var(--novelist-text-secondary);
}

/* Horizontal rule */
.cm-novelist-hr {
  display: block;
  border: none;
  border-top: 2px solid var(--novelist-border);
  margin: 8px 0;
}

/* Code block */
.cm-novelist-codeblock {
  background: var(--novelist-code-bg);
  border-radius: 4px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 0.9em;
  padding: 2px 0;
}

/* Checkbox */
.cm-novelist-checkbox {
  cursor: pointer;
  font-size: 1.1em;
  vertical-align: middle;
  margin-right: 4px;
}
```

- [ ] **Step 2: Implement the core WYSIWYG ViewPlugin**

Create `src/lib/editor/wysiwyg.ts`:

The plugin must:
1. On every view update (doc change or selection change), walk the visible portion of the syntax tree
2. For each Markdown syntax node, decide what decorations to apply
3. Check if the cursor is inside the node — if so, skip hiding (reveal markers)
4. Return a `DecorationSet`

Key approach: use `syntaxTree(state).iterate()` to walk nodes. The Lezer Markdown parser produces node types like `ATXHeading1`, `StrongEmphasis`, `Emphasis`, `InlineCode`, `Link`, `Blockquote`, `FencedCode`, `BulletList`, `Task`, etc.

The cursor-awareness check: for each syntax node `{from, to}`, check if `state.selection.main.head` is within `[from, to]`. If yes, don't hide the markers for that node.

Structure the code as:
```typescript
import { ViewPlugin, Decoration, DecorationSet, EditorView, ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Range } from '@codemirror/state';

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const cursor = state.selection.main.head;
  const decorations: Range<Decoration>[] = [];
  
  // Only process visible ranges for performance
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        // Check node type and build decorations
        // Skip hiding if cursor is inside this node
      }
    });
  }
  
  return Decoration.set(decorations, true);
}

export const wysiwygPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
```

Implement handling for these node types in Phase 2 Task 1:
- `ATXHeading1` through `ATXHeading6` — hide `#` markers, apply heading class
- `StrongEmphasis` — hide `**`/`__` markers, apply bold class
- `Emphasis` — hide `*`/`_` markers, apply italic class
- `InlineCode` — hide backtick markers, apply code class
- `Strikethrough` — hide `~~` markers, apply strikethrough class

For hiding markers, use `Decoration.replace({ widget: undefined })` to collapse the marker range, or use `Decoration.mark({ class: "cm-novelist-hidden" })` with `font-size: 0`.

**IMPORTANT**: Use `Decoration.mark()` with the hidden class for markers rather than `Decoration.replace()` — replace decorations cause issues with cursor positioning. The `font-size: 0` approach keeps the text in the document but visually hides it, and CM6 handles cursor movement through it correctly.

- [ ] **Step 3: Add WYSIWYG extension to editor setup**

Modify `src/lib/editor/setup.ts`:
- Import `wysiwygPlugin` from `./wysiwyg`
- Import `./wysiwyg.css`
- Add `wysiwygPlugin` to the extensions array in `createEditorExtensions()`

- [ ] **Step 4: Import wysiwyg.css in app.css**

Add to `src/app.css`:
```css
@import "./lib/editor/wysiwyg.css";
```

Or import it in `setup.ts` via:
```typescript
import './wysiwyg.css';
```

- [ ] **Step 5: Verify build and basic WYSIWYG**

```bash
npx vite build
```

Must compile. Then `pnpm tauri dev` — open a markdown file. Headings should render with larger font sizes, bold/italic should show styled text with markers hidden when cursor is away.

- [ ] **Step 6: Commit**

```bash
git add src/lib/editor/wysiwyg.ts src/lib/editor/wysiwyg.css src/lib/editor/setup.ts src/app.css
git commit -m "feat: add WYSIWYG core with heading, bold, italic, code decorations"
```

---

### Task 2: Link and Blockquote Decorations

**Files:**
- Modify: `src/lib/editor/wysiwyg.ts`

Extend the WYSIWYG plugin to handle:

- [ ] **Step 1: Add link decorations**

For `Link` nodes in the syntax tree:
- Structure: `[link text](url)`
- When cursor is NOT inside: hide `[`, `](url)`, show only the link text with `.cm-novelist-link-text` class
- When cursor IS inside: show full syntax

The Lezer Markdown Link node has children: `LinkMark` `[`, content, `LinkMark` `]`, `URL` `(url)`.
Use `node.getChild()` to find the URL child, then:
- Mark decoration on `LinkMark` `[` → hidden
- Mark decoration on content → link-text class
- Mark decoration from `]` to end of URL → hidden

- [ ] **Step 2: Add blockquote line decorations**

For `Blockquote` nodes:
- Apply `Decoration.line({ class: "cm-novelist-blockquote" })` to each line
- Hide the `>` marker character using mark decoration with hidden class when cursor is NOT on that line

Blockquote markers are `QuoteMark` nodes in the Lezer tree.

- [ ] **Step 3: Add horizontal rule decoration**

For `HorizontalRule` nodes (`---`, `***`, `___`):
- Replace with a styled `<hr>` widget when cursor is not on the line

- [ ] **Step 4: Verify and commit**

```bash
npx vite build
git commit -m "feat: add link, blockquote, and horizontal rule WYSIWYG decorations"
```

---

### Task 3: Code Block and Todo Checkbox Decorations

**Files:**
- Create: `src/lib/editor/wysiwyg-widgets.ts`
- Modify: `src/lib/editor/wysiwyg.ts`

- [ ] **Step 1: Create widget types**

Create `src/lib/editor/wysiwyg-widgets.ts`:

```typescript
import { WidgetType, EditorView } from '@codemirror/view';

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-novelist-checkbox';
    span.textContent = this.checked ? '☑' : '☐';
    span.addEventListener('mousedown', (e) => {
      e.preventDefault();
      // Toggle the checkbox in the document
      // Find the `- [ ]` or `- [x]` and replace
    });
    return span;
  }
  
  eq(other: CheckboxWidget) { return this.checked === other.checked; }
}
```

- [ ] **Step 2: Add fenced code block decorations**

For `FencedCode` nodes:
- Apply `.cm-novelist-codeblock` class to the code content lines via line decorations
- When cursor is NOT inside the block: hide the opening ``` and closing ``` fence markers
- When cursor IS inside: show everything
- The info string (language label) after opening ``` can be shown as a small label

- [ ] **Step 3: Add todo checkbox decorations**

For `Task` / `TaskMarker` nodes (within `BulletList`):
- Find `[ ]` or `[x]` markers
- When cursor is NOT on the line: replace `- [ ]` / `- [x]` with a CheckboxWidget
- When cursor IS on the line: show raw syntax
- Widget click toggles between `[ ]` and `[x]` by dispatching a CM6 transaction

- [ ] **Step 4: Verify and commit**

```bash
npx vite build
git commit -m "feat: add code block and todo checkbox WYSIWYG decorations"
```

---

### Task 4: IME Guard

**Files:**
- Create: `src/lib/editor/ime-guard.ts`
- Modify: `src/lib/editor/wysiwyg.ts`
- Modify: `src/lib/editor/setup.ts`

- [ ] **Step 1: Create IME composition state tracker**

Create `src/lib/editor/ime-guard.ts`:

```typescript
import { StateField, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const setComposing = StateEffect.define<boolean>();

export const imeComposingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setComposing)) return effect.value;
    }
    return value;
  },
});

export const imeGuardPlugin = EditorView.domEventHandlers({
  compositionstart(event, view) {
    view.dispatch({ effects: setComposing.of(true) });
  },
  compositionend(event, view) {
    view.dispatch({ effects: setComposing.of(false) });
  },
});
```

- [ ] **Step 2: Integrate IME guard into WYSIWYG plugin**

Modify `src/lib/editor/wysiwyg.ts`:
- Import `imeComposingField`
- In `buildDecorations()`: check `state.field(imeComposingField)` — if true, return the previous decoration set unchanged (freeze decorations during composition)
- This prevents decoration flickering during CJK input

- [ ] **Step 3: Add to editor setup**

Modify `src/lib/editor/setup.ts`:
- Import and add `imeComposingField` and `imeGuardPlugin` to extensions

- [ ] **Step 4: Verify and commit**

```bash
npx vite build
git commit -m "feat: add IME composition guard to prevent decoration flicker during CJK input"
```

---

### Task 5: Cursor Transition Smoothing

**Files:**
- Modify: `src/lib/editor/wysiwyg.css`
- Modify: `src/lib/editor/wysiwyg.ts`

- [ ] **Step 1: Add CSS transitions for marker visibility**

Update `src/lib/editor/wysiwyg.css`:

```css
/* Smooth transitions for marker reveal/hide */
.cm-novelist-hidden {
  font-size: 0;
  opacity: 0;
  display: inline;
  overflow: hidden;
  transition: font-size 150ms ease, opacity 150ms ease;
}

/* When cursor enters a node, markers become visible */
.cm-novelist-marker-visible {
  font-size: inherit;
  opacity: 0.5;
  color: var(--novelist-text-secondary);
  transition: font-size 150ms ease, opacity 150ms ease;
}
```

- [ ] **Step 2: Use marker-visible class instead of no-decoration for cursor-active nodes**

When the cursor is inside a syntax node, instead of simply not creating a decoration (which causes a jarring layout shift), apply `.cm-novelist-marker-visible` to the marker text. This shows the markers at reduced opacity with a smooth transition.

Modify `buildDecorations()` in `wysiwyg.ts`:
- For marker ranges where cursor IS inside the parent node: apply `Decoration.mark({ class: "cm-novelist-marker-visible" })`
- For marker ranges where cursor is NOT inside: apply `Decoration.mark({ class: "cm-novelist-hidden" })`

- [ ] **Step 3: Add debounced decoration update**

To prevent excessive decoration rebuilds during rapid cursor movement:
- Add a 50ms debounce on selection-only updates (no debounce on doc changes)
- Track a timeout in the ViewPlugin class

```typescript
class WysiwygPluginValue {
  decorations: DecorationSet;
  private pendingUpdate: ReturnType<typeof setTimeout> | null = null;
  
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.clearPending();
      this.decorations = buildDecorations(update.view);
    } else if (update.selectionSet) {
      this.clearPending();
      this.pendingUpdate = setTimeout(() => {
        this.decorations = buildDecorations(update.view);
        update.view.requestMeasure(); // trigger re-render
      }, 50);
    }
  }
  
  clearPending() {
    if (this.pendingUpdate) {
      clearTimeout(this.pendingUpdate);
      this.pendingUpdate = null;
    }
  }
  
  destroy() { this.clearPending(); }
}
```

- [ ] **Step 4: Verify smooth transitions and commit**

Open a markdown file, move cursor through headings, bold, links. Markers should fade in/out smoothly, no layout jumps.

```bash
npx vite build
git commit -m "feat: add smooth cursor transition animations for WYSIWYG markers"
```

---

### Task 6: Integration Testing and Edge Cases

**Files:** No new files. Verification and edge case fixes.

- [ ] **Step 1: Test nested syntax**

Test with content like:
```markdown
# **Bold heading**
***bold italic text***
> **bold in blockquote**
- [ ] **bold in todo item**
```

Verify decorations compose correctly (bold + heading, bold + italic, bold + blockquote).

- [ ] **Step 2: Test cursor behavior**

- Move cursor into/out of decorated regions
- Select text across decorated regions
- Undo/redo with decorations
- Copy/paste decorated text

- [ ] **Step 3: Test IME**

If on a system with IME:
- Start composing pinyin/other CJK input
- Verify decorations don't flicker during composition
- Verify decorations update correctly after composition ends

- [ ] **Step 4: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix: edge case fixes for WYSIWYG decorations"
```

---

## Phase 2 Complete

After this phase, Novelist provides a Typora-like WYSIWYG editing experience:
- Headings render with proper font sizes, `#` markers hidden
- Bold/italic/strikethrough/code render with proper styling, markers hidden
- Links show as styled text, full syntax hidden
- Blockquotes have left border styling, `>` hidden
- Code blocks have background styling, fences hidden
- Todo checkboxes render as clickable widgets
- Cursor reveals raw Markdown when entering any syntax node
- Smooth transitions when markers show/hide
- IME input doesn't cause decoration flickering

## Next Phases

- **Phase 3: File Management** — file watcher, conflict resolution, auto-save timer, large file viewport mode
- **Phase 4: Writing Features** — Outline panel, Zen Mode, command palette
- **Phase 5: Polish & Extensibility** — Split view, theme plugin system, welcome screen, recent projects
- **Phase 6: Plugin System & Export** — QuickJS sandbox, plugin API, pandoc export
