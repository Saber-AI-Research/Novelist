# Icon Component System (Batch 1)

**Date**: 2026-04-21
**Status**: Design approved, pending implementation plan
**Scope**: Replace emoji usages in core UI chrome with hand-rolled SVG icon components. This spec covers **batch 1 only** (10 emoji sites across template panel and AI Talk presets). Remaining emoji in close buttons, settings gears, warnings, etc. are deferred to subsequent batches.

## Motivation

User feedback: the desktop app uses emoji (📄 ↳ 💬 ✍️ 📝 🌐 📋 💡 📦 …) as UI glyphs for template mode badges, prompt preset icons, close buttons, etc. Emoji rendering is inconsistent across platforms and visually noisy at small sizes. The rest of the app already uses inline stroke SVGs (39 occurrences across 8 components, e.g. `Sidebar.svelte`, `FileTreeNode.svelte`) on a 16×16 grid with `stroke="currentColor"` and stroke width 1.3–2. Emoji usages are the outliers.

This batch establishes a reusable icon component layer consistent with that existing style, and replaces the two most user-visible emoji clusters:
- Template panel mode badges (📄 / ↳)
- AI Talk built-in prompt preset icons (💬 ✍️ 📝 🌐 📋 💡) and the fallback (📦)

## Non-Goals

- Replacing emoji in close buttons (`✕`), setting gears (`⚙`), mindmap toggle (`🗺`), warning prefixes (`⚠️`), AI Agent tool indicators (`🔧 ↳`). Those are batch 2+.
- Adding an icon library dependency (lucide-svelte, heroicons, etc.). The project's existing precedent is hand-rolled inline SVG; we follow that.
- Restricting what users can type as the `icon` field of their own custom presets. Users may still enter any string (including emoji) for custom presets they author — this spec only changes what the app ships by default.

## Architecture

### Folder layout

```
app/lib/components/icons/
  index.ts                 # aggregate re-export
  IconChat.svelte          # 💬 Default preset
  IconPen.svelte           # ✍️ Novelist assistant preset
  IconDocument.svelte      # 📝 Editor preset + 📄 template new-file mode badge
  IconGlobe.svelte         # 🌐 Translator preset
  IconClipboard.svelte     # 📋 Summarizer preset
  IconLightbulb.svelte     # 💡 Brainstorm preset
  IconPackage.svelte       # 📦 built-in preset fallback
  IconArrowInsert.svelte   # ↳ template insert-mode badge
```

Eight icon components in batch 1. `IconDocument` is shared across two sites (AI Talk Editor preset + template panel new-file mode). New icons for future batches will live alongside in the same folder.

### Component contract

Every icon file follows the same shape:

```svelte
<script lang="ts">
  let { size = 14, class: cls = '' }: { size?: number; class?: string } = $props();
</script>
<svg
  width={size} height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={cls}
  aria-hidden="true"
>
  <!-- path data specific to this icon -->
</svg>
```

Contract:
- Props: `size?: number = 14` (pixels, sets both width and height), `class?: string = ''` (forwarded to the root `<svg>` so callers can override margin/color).
- Stroke-only line art on 16×16 grid. Color via `currentColor` — callers control color through CSS `color` on an ancestor.
- `aria-hidden="true"` because icons are decorative; the preset label and mode semantics are already communicated through adjacent text.
- `stroke-width` fixed at 1.5. This sits in the middle of the existing project's 1.3–2.0 range and reads well at sizes 10–20px.
- No animation, no fill, no gradients.

Only deviation allowed: if a specific icon needs a different `stroke-width` for visual balance at small sizes (e.g. a dense glyph), override inside that icon's file. `viewBox` stays 16×16 universally.

### index.ts

```ts
export { default as IconChat } from './IconChat.svelte';
export { default as IconPen } from './IconPen.svelte';
export { default as IconDocument } from './IconDocument.svelte';
export { default as IconGlobe } from './IconGlobe.svelte';
export { default as IconClipboard } from './IconClipboard.svelte';
export { default as IconLightbulb } from './IconLightbulb.svelte';
export { default as IconPackage } from './IconPackage.svelte';
export { default as IconArrowInsert } from './IconArrowInsert.svelte';
```

Consumers import like `import { IconChat } from '$lib/components/icons';` (matches other project import conventions — or relative path, whichever is already used in the file being edited).

## Integration Points

### 1. TemplatePanel.svelte

Currently `modeBadge(mode: string): string` returns `'↳'` or `'📄'` at line 130, rendered as text. Replace:

- Delete the `modeBadge` function.
- At the badge render site, branch on `s.mode === 'insert'` and render `<IconArrowInsert size={12} class="template-badge-icon" />` or `<IconDocument size={12} class="template-badge-icon" />`.
- Any existing CSS targeting the badge text node (size, color) moves to the `.template-badge-icon` class or stays on the parent depending on how the current style is scoped. Since the icons use `currentColor`, the parent's `color` CSS already propagates.

### 2. presets.svelte.ts

Change the `Preset.icon` type:

```ts
// before
export type Preset = { id: string; name: string; icon: string; /* ... */ };

// after
import type { Component } from 'svelte';
export type Preset = {
  id: string;
  name: string;
  icon: Component | string; // Component for built-ins, string for user-created
  /* ... */
};
```

For each of the 6 built-in presets, replace the emoji string with the corresponding icon component:
- Default: `IconChat`
- 小说助手: `IconPen`
- Editor: `IconDocument`
- Translator: `IconGlobe`
- Summarizer: `IconClipboard`
- Brainstorm: `IconLightbulb`

User-created presets continue to store strings (unchanged — users can still type emoji or any text for their own presets).

### 3. PromptPresetManager.svelte

Line 112 renders `{p.icon ?? (p.builtin ? '📦' : '📝')}` and line 146 shows `📦` in the hidden-builtins section. Change both:

```svelte
{#if !p.icon}
  {#if p.builtin}<IconPackage size={14} />{:else}<IconDocument size={14} />{/if}
{:else if typeof p.icon === 'string'}
  <span class="icon-text">{p.icon}</span>
{:else}
  <svelte:component this={p.icon} size={14} />
{/if}
```

Same treatment for line 146 (built-in fallback → `<IconPackage size={14} />`).

### 4. AiTalkImpl.svelte (preset rendering only)

If this file renders a preset's icon anywhere (beyond the preset-manager UI), it must handle the same `Component | string` discriminated union identically. Discover and adjust during implementation.

The other `AiTalkImpl.svelte` emojis (📝 chip icon line 472, ✕ close line 483, ⚠️ warnings, ⚙ gear) are **out of scope** for batch 1 — do not touch them.

## Data Flow

No backend changes. All edits are frontend-only under `app/lib/components/` and `app/lib/components/ai-talk/`. No Rust, no IPC, no storage format change. Built-in preset definitions live entirely in `presets.svelte.ts` (not persisted to disk), so swapping `string` → `Component` for built-ins doesn't break any serialized state.

User-authored presets in project/global settings are persisted with `icon: string` today and continue to be. The discriminated union tolerates both: builtins carry components at runtime, user presets carry strings.

## Error Handling

- If the type narrowing in the preset renderer is bypassed (e.g. someone adds a third icon form later), Svelte will render nothing silently. Acceptable for batch 1 — no need for a runtime guard. If this becomes a footgun, revisit in a later batch.
- Icon components have no failure modes: pure static SVG, no props validation required beyond the types.

## Testing

- **No new unit tests or E2E tests** in batch 1. The change is a visual replacement of existing elements; correctness is verified by:
  1. `pnpm check` — types still compile (`Component | string` discriminated union is the main risk surface).
  2. `pnpm test` — existing preset tests pass.
  3. `pnpm test:e2e:browser` — existing ai-panels E2E tests pass.
  4. `pnpm tauri dev` — manual visual check: template panel badges look right, prompt presets show line icons.
- **If existing tests assert on emoji characters** (e.g. `expect(...).toContain('💬')`), update them to assert on something stable like preset `id`, `name`, or `aria-label`. Implementation plan will enumerate which tests need updates after grepping.

## Batch 1 Scope Boundary

Changes in batch 1, exhaustive list:
- Create 8 new files under `app/lib/components/icons/` + `index.ts`.
- Edit `app/lib/components/TemplatePanel.svelte` (remove `modeBadge`, swap render).
- Edit `app/lib/components/ai-talk/presets.svelte.ts` (type change + 6 built-in icon swaps).
- Edit `app/lib/components/ai-talk/PromptPresetManager.svelte` (fallback icon render at lines 112, 146).
- Edit `app/lib/components/ai-talk/AiTalkImpl.svelte` **only if** it renders a preset icon (needs discovery).
- Edit any existing test that asserts on emoji characters in preset data.

**Not in batch 1**:
- Close buttons (`✕` in 6 files), settings gear (`⚙` in 3 files), mindmap map (`🗺`), warnings (`⚠️` in 3 sites), AI Agent tool indicators (`🔧 ↳`), selection chip document (`📝`). These get their own batch(es) later.

## Open Questions / Verification Needed During Planning

Design decisions are resolved; the following code-level facts must be verified before implementation begins (part of the implementation plan's discovery step):

1. **Does the presets store ever serialize built-in presets?** The spec assumes built-ins are code-only (not persisted), so switching their `icon` field to a Svelte `Component` is safe. If the store's save/load path round-trips built-ins through JSON, a Component value would be lost/corrupted silently. Resolution path: grep `presets.svelte.ts` and `tests/unit/stores/ai-talk-presets.test.ts` for serialization calls; if built-ins are persisted, shift to a two-field model (keep `icon?: string` for user presets, add `builtinIcon?: Component` for built-ins).
2. **Does `AiTalkImpl.svelte` render a preset's `icon` field anywhere?** If yes, it must adopt the same discriminated-union rendering as `PromptPresetManager.svelte`. If no, it's out of scope. Resolution path: grep `AiTalkImpl.svelte` for `preset.icon` / `p.icon` / `.icon`.
3. **Which existing tests assert on emoji characters?** Resolution path: grep tests under `tests/unit/` and `tests/e2e/` for the 8 emoji in batch 1. Any failing test updates are part of batch 1.

Resolved decisions:
- Folder structure: one file per icon, flat under `icons/`, `index.ts` re-exports.
- No icon library dependency — hand-rolled SVG matching existing project style.
- Preset icon type: `Component | string` discriminated union, not a name registry (contingent on question 1 above).
- No new tests, rely on existing test suites.
- Scope strictly limited to 10 emoji sites; other emoji deferred.
