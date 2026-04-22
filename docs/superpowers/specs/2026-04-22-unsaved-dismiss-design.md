# Unsaved-changes dialog — add Cancel/Dismiss

**Date:** 2026-04-22
**Scope:** New `UnsavedChangesDialog.svelte`, new `confirmUnsavedChanges` composable, three call sites (`app/lib/stores/tabs.svelte.ts`, `app/lib/composables/app-lifecycle.svelte.ts`, `app/lib/components/Sidebar.svelte`), i18n keys in `zh-CN.ts` / `en.ts`.
**Out of scope:** Conflict dialog, save-failure dialog, any other prompt. Save/discard/saveAs logic at call sites is untouched except for respecting the new `'cancel'` return value.

## Problem

The "Unsaved changes" prompt before closing a tab / window / project uses Tauri's native `ask()` which is limited to two buttons (Save / Don't Save). There is no way for the user to back out — pressing ESC or clicking outside the dialog still maps to "Don't Save" (or "Save", depending on OS), which silently discards or force-saves work the user was not ready to decide on.

The user wants a third outcome: **dismiss** — abort the close, return to the editor, leave the tab/window/project open and dirty.

## Goal

1. The unsaved-changes prompt offers three choices: **Save**, **Don't Save**, **Cancel**.
2. ESC and backdrop-click both map to **Cancel**.
3. On **Cancel**, the close (tab / window / project) is aborted; no save, no discard, no state change.
4. Existing Save / Don't Save behavior is preserved byte-for-byte at each call site.

## Non-goals

- Do not replace other native dialogs (`ConflictDialog` already exists; save-failure, export errors, etc. stay as-is).
- No animation, focus trap, or accessibility work beyond what `ConflictDialog.svelte` already does.
- No keyboard shortcut for Save/Don't Save beyond the default button (Enter → Save).

## Architecture

### New component: `app/lib/components/UnsavedChangesDialog.svelte`

Modeled on `ConflictDialog.svelte`. Props:

```ts
interface Props {
  fileNames: string;       // pre-joined, ready to render
  saveLabel: string;       // "Save" or "Save As..." (scratch files)
  onSave: () => void;
  onDontSave: () => void;
  onCancel: () => void;
}
```

Renders:
- Backdrop `<div>` with `role="dialog" aria-modal="true"`.
- Title: `t('dialog.unsavedChanges')`.
- Message: `t('dialog.unsavedBeforeClose', { names: fileNames })`.
- Three buttons right-aligned: `Cancel` (tertiary), `Don't Save` (secondary), `Save` (primary, autofocus).
- `onkeydown` on the backdrop → ESC calls `onCancel`.
- Backdrop click (not inner panel) calls `onCancel`.

### New helper: `app/lib/composables/confirm-unsaved-changes.svelte.ts`

Promise-based one-shot mount:

```ts
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

export function confirmUnsavedChanges(opts: {
  fileNames: string;
  saveLabel?: string;        // defaults to t('dialog.save')
}): Promise<UnsavedChoice>;
```

Implementation sketch:
- Uses Svelte 5 `mount()` to attach `UnsavedChangesDialog` to `document.body`.
- Returns a promise that resolves with the chosen outcome, then `unmount()`s the component.
- Single concurrent dialog — if called while one is open, the new call queues (or returns `'cancel'` immediately; pick **queue** so nothing is silently dropped).

### Call-site changes

All three sites switch from `ask()` / `confirm()` to `confirmUnsavedChanges()` and branch on `'cancel'`:

| File | Current | New behavior on `'cancel'` |
|------|---------|----------------------------|
| `app/lib/stores/tabs.svelte.ts:322` (`closeTab`) | `ask()` returns bool | Early `return;` — tab stays open, still dirty |
| `app/lib/composables/app-lifecycle.svelte.ts:67` (`onCloseRequested`) | `ask()` returns bool | Already `event.preventDefault()`'d; skip save + don't call `destroy()` — window stays open |
| `app/lib/components/Sidebar.svelte:109` (close project) | browser `confirm()` | Early `return;` from the close-project handler — project stays open |

Save / Don't Save branches at each site remain unchanged, mapped as:
- `'save'` → existing "shouldSave = true" path.
- `'discard'` → existing "shouldSave = false" path (no save, but proceed with close).

### i18n

Add one new key:

| Key | zh-CN | en |
|-----|-------|----|
| `dialog.unsavedCancel` | 取消 | Cancel |

Reuse existing: `dialog.unsavedChanges`, `dialog.unsavedBeforeClose`, `dialog.save`, `dialog.saveAs`, `dialog.dontSave`.

## Testing

### Unit tests (vitest)

New file `tests/unit/composables/confirm-unsaved-changes.test.ts`:
- Mounts helper, simulates clicking each button → expects correct resolved value.
- Simulates ESC keydown on backdrop → resolves `'cancel'`.
- Simulates backdrop click → resolves `'cancel'`.
- Simulates click on inner panel → does NOT resolve (dialog stays open).

### Call-site tests

- Extend `tests/unit/composables/app-lifecycle.test.ts` with a "cancel branch" case: mock the helper to return `'cancel'`, assert `destroy()` is NOT called and no `markSaved` happens.
- Extend tabs store test (if one exists for `closeTab`) similarly; otherwise add a minimal one.

### Manual QA checklist

- Close dirty tab → Cancel → tab still present, still dirty.
- Cmd+Q with dirty files → Cancel → window stays, files still dirty.
- Close project (Sidebar "new project" flow) → Cancel → project stays open.
- Each dialog: ESC = Cancel, click backdrop = Cancel, click inside panel = no-op.
- Save and Don't Save paths unchanged in both scratch and real-file cases.

## Risks & mitigations

- **Focus stealing during IME composition**: the autofocus on Save could break CJK IME state. Mitigation: only `autofocus` after `requestAnimationFrame`, and guard ESC handler with `event.isComposing === false`.
- **Double-prompt on window close**: `closeConfirmed` latch in `app-lifecycle.svelte.ts` must NOT flip to `true` on the cancel branch. We only set it on `'save'` / `'discard'`.
- **Queued dialogs**: if two close attempts race (unlikely but possible via shortcuts), the helper queues rather than drops. Simpler than a reject-if-busy rule and matches the user's mental model.
