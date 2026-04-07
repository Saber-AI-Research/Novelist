# Novelist Phase 4: Writing Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Outline panel (heading navigation), Zen Mode (fullscreen immersive writing), and Command Palette (keyboard-driven actions).

**Architecture:** Outline panel derives headings from CM6 syntax tree via a StateField, displayed in a Svelte component in the right panel. Zen Mode is a CSS-driven fullscreen overlay with typewriter scrolling and paragraph dimming via CM6 extensions. Command Palette is a Svelte modal with fuzzy search over registered commands.

**Tech Stack:** CodeMirror 6 (StateField, ViewPlugin), Svelte 5 (Runes)

**Spec:** `design/design-overview.md` sections 12.1, 12.2, 12.3, 13

---

### Task 1: Outline Panel

**Files:**
- Create: `src/lib/editor/outline.ts` — CM6 StateField that extracts headings from syntax tree
- Create: `src/lib/components/Outline.svelte` — right panel UI
- Modify: `src/App.svelte` — add outline panel to layout, wire Cmd+Shift+O toggle
- Modify: `src/lib/stores/ui.svelte.ts` — already has outlineVisible toggle

Implement:
- `outline.ts`: A StateField or function that walks the Lezer syntax tree, extracts heading nodes (H1-H6), returns `Array<{ level: number, text: string, from: number }>`. Debounce updates (300ms).
- `Outline.svelte`: Renders headings as a collapsible tree (indented by level). Click a heading → scroll CM6 editor to that position. Live-updates as document changes.
- App.svelte: Show Outline panel on right side when `uiStore.outlineVisible`. Cmd+Shift+O toggles.

### Task 2: Zen Mode

**Files:**
- Create: `src/lib/editor/zen.ts` — CM6 typewriter scrolling extension + paragraph focus
- Create: `src/lib/components/ZenMode.svelte` — fullscreen overlay container
- Modify: `src/App.svelte` — toggle Zen Mode with F11 or Cmd+Shift+Z
- Modify: `src/lib/stores/ui.svelte.ts` — add zenMode state
- Modify: `src/app.css` — add Zen Mode CSS variables and styles

Implement:
- **Typewriter mode**: CM6 extension that keeps the active line vertically centered. Use `EditorView.scrollIntoView` with custom effect, or a ViewPlugin that adjusts scroll position after each cursor move.
- **Paragraph focus**: Dim paragraphs that don't contain the cursor. Use line decorations with opacity.
- **ZenMode.svelte**: Fullscreen overlay (position: fixed, z-index: 9999) with just the editor, no sidebar/tabs/status. Optional floating word count HUD in bottom-right that fades after 3s.
- **Entry/exit**: Smooth CSS transition (opacity/transform). Toggle via F11 or Cmd+Shift+Z.
- **Zen theme**: Dark background (#1a1a2e), light text (#e0e0e0), different from main theme.

### Task 3: Command Palette

**Files:**
- Create: `src/lib/components/CommandPalette.svelte`
- Create: `src/lib/stores/commands.svelte.ts` — command registry
- Modify: `src/App.svelte` — toggle with Cmd+Shift+P

Implement:
- `commands.svelte.ts`: A registry of `{ id, label, shortcut?, handler }` entries. Pre-register built-in commands: Toggle Sidebar, Toggle Outline, Toggle Zen Mode, Save File, Close Tab, Open Directory.
- `CommandPalette.svelte`: Modal overlay with text input. Fuzzy-filters commands as user types. Enter to execute selected, Escape to close. Arrow keys to navigate. Show keyboard shortcut on right side of each entry.
- Wire Cmd+Shift+P in App.svelte to toggle the palette.

---

## Phase 4 deliverables:
- Outline panel with heading navigation (click to scroll)
- Zen Mode with typewriter scrolling + paragraph dimming
- Command Palette with fuzzy search and keyboard navigation
