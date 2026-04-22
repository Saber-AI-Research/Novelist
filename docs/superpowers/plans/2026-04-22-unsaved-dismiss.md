# Unsaved-changes dialog — Cancel/Dismiss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the native 2-button `ask()` unsaved-changes prompt with a custom Svelte dialog that has a third "Cancel" option (ESC / backdrop click / Cancel button → abort the close).

**Architecture:** New `UnsavedChangesDialog.svelte` modeled on `ConflictDialog.svelte`. A tiny module-level store (`unsaved-prompt.svelte.ts`) exposes an async `confirmUnsavedChanges()` that sets reactive state + stores a resolver. `App.svelte` renders the dialog when state is non-null. Three call sites (`tabs.svelte.ts`, `app-lifecycle.svelte.ts`, `Sidebar.svelte`) migrate from `ask()` / `confirm()` to the new helper and branch on `'cancel'`.

**Tech Stack:** Svelte 5 runes (`$state`), TypeScript, vitest, Tauri plugin-dialog (removed from these call sites).

---

## File Structure

**New files:**
- `app/lib/components/UnsavedChangesDialog.svelte` — modal UI, 3 buttons + ESC + backdrop-click handlers.
- `app/lib/composables/unsaved-prompt.svelte.ts` — module-level `$state` + `confirmUnsavedChanges()` promise helper.
- `tests/unit/composables/unsaved-prompt.test.ts` — unit tests for the helper.

**Modified files:**
- `app/lib/i18n/locales/en.ts` — add `dialog.unsavedCancel`.
- `app/lib/i18n/locales/zh-CN.ts` — add `dialog.unsavedCancel`.
- `app/App.svelte` — render `UnsavedChangesDialog` when store has pending prompt.
- `app/lib/stores/tabs.svelte.ts` — `closeTab` uses helper; branch on `'cancel'` skips the whole close.
- `app/lib/composables/app-lifecycle.svelte.ts` — `onCloseRequested` uses helper; branch on `'cancel'` leaves window open.
- `app/lib/components/Sidebar.svelte` — `openProjectFromPath` uses helper; branch on `'cancel'` aborts switching project.
- `tests/unit/composables/app-lifecycle.test.ts` — add a cancel-branch case; swap `ask` mock for the new helper.

---

### Task 1: Add i18n keys

**Files:**
- Modify: `app/lib/i18n/locales/en.ts`
- Modify: `app/lib/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add English key**

In `app/lib/i18n/locales/en.ts`, inside the `// --- Unsaved changes ---` block, after `'dialog.dontSave': "Don't Save",` insert:

```ts
  'dialog.unsavedCancel': 'Cancel',
```

Keep `dialog.cancel` unchanged — it's used elsewhere.

- [ ] **Step 2: Add Chinese key**

In `app/lib/i18n/locales/zh-CN.ts`, inside the `// --- Unsaved changes ---` block, after `'dialog.dontSave': '不保存',` insert:

```ts
  'dialog.unsavedCancel': '取消',
```

- [ ] **Step 3: Run type check**

Run: `pnpm check`
Expected: PASS (no new errors).

- [ ] **Step 4: Commit**

```bash
git add app/lib/i18n/locales/en.ts app/lib/i18n/locales/zh-CN.ts
git commit -m "feat(i18n): add dialog.unsavedCancel key for unsaved-changes dismiss"
```

---

### Task 2: Create `confirmUnsavedChanges` helper (test-first)

**Files:**
- Create: `tests/unit/composables/unsaved-prompt.test.ts`
- Create: `app/lib/composables/unsaved-prompt.svelte.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/composables/unsaved-prompt.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  confirmUnsavedChanges,
  unsavedPromptState,
  resolveUnsavedPrompt,
  type UnsavedChoice,
} from '$lib/composables/unsaved-prompt.svelte';

describe('[contract] confirmUnsavedChanges', () => {
  beforeEach(() => {
    // Ensure no pending prompt leaks between tests.
    if (unsavedPromptState.pending) resolveUnsavedPrompt('cancel');
  });

  it('sets pending state with fileNames and saveLabel', async () => {
    const p = confirmUnsavedChanges({ fileNames: 'a.md', saveLabel: 'Save' });
    expect(unsavedPromptState.pending).not.toBeNull();
    expect(unsavedPromptState.pending?.fileNames).toBe('a.md');
    expect(unsavedPromptState.pending?.saveLabel).toBe('Save');
    resolveUnsavedPrompt('cancel');
    await p;
  });

  it('resolves with the chosen outcome and clears pending', async () => {
    const p = confirmUnsavedChanges({ fileNames: 'a.md', saveLabel: 'Save' });
    resolveUnsavedPrompt('save');
    const result: UnsavedChoice = await p;
    expect(result).toBe('save');
    expect(unsavedPromptState.pending).toBeNull();
  });

  it('resolves with discard', async () => {
    const p = confirmUnsavedChanges({ fileNames: 'a.md', saveLabel: 'Save' });
    resolveUnsavedPrompt('discard');
    expect(await p).toBe('discard');
  });

  it('resolves with cancel', async () => {
    const p = confirmUnsavedChanges({ fileNames: 'a.md', saveLabel: 'Save' });
    resolveUnsavedPrompt('cancel');
    expect(await p).toBe('cancel');
  });

  it('queues a second call until the first resolves', async () => {
    const p1 = confirmUnsavedChanges({ fileNames: 'a.md', saveLabel: 'Save' });
    const p2 = confirmUnsavedChanges({ fileNames: 'b.md', saveLabel: 'Save' });
    // While p1 is pending, the store reflects p1's request.
    expect(unsavedPromptState.pending?.fileNames).toBe('a.md');
    resolveUnsavedPrompt('save');
    expect(await p1).toBe('save');
    // Now p2 takes over.
    expect(unsavedPromptState.pending?.fileNames).toBe('b.md');
    resolveUnsavedPrompt('discard');
    expect(await p2).toBe('discard');
    expect(unsavedPromptState.pending).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/composables/unsaved-prompt.test.ts`
Expected: FAIL with "Cannot find module '$lib/composables/unsaved-prompt.svelte'".

- [ ] **Step 3: Write minimal implementation**

Create `app/lib/composables/unsaved-prompt.svelte.ts`:

```ts
export type UnsavedChoice = 'save' | 'discard' | 'cancel';

interface PendingPrompt {
  fileNames: string;
  saveLabel: string;
}

interface QueuedRequest extends PendingPrompt {
  resolve: (choice: UnsavedChoice) => void;
}

// Reactive state rendered by App.svelte. Non-null when a dialog is showing.
export const unsavedPromptState: { pending: PendingPrompt | null } = $state({ pending: null });

const queue: QueuedRequest[] = [];

function activateNext() {
  const next = queue[0];
  unsavedPromptState.pending = next
    ? { fileNames: next.fileNames, saveLabel: next.saveLabel }
    : null;
}

/**
 * Opens the unsaved-changes dialog and resolves with the user's choice.
 * Concurrent calls queue — the second dialog opens after the first resolves.
 */
export function confirmUnsavedChanges(opts: {
  fileNames: string;
  saveLabel: string;
}): Promise<UnsavedChoice> {
  return new Promise<UnsavedChoice>((resolve) => {
    queue.push({ fileNames: opts.fileNames, saveLabel: opts.saveLabel, resolve });
    if (queue.length === 1) activateNext();
  });
}

/**
 * Resolves the currently-active prompt. Called by UnsavedChangesDialog when
 * the user clicks a button, presses ESC, or clicks the backdrop. Exported so
 * tests can drive the helper without rendering the component.
 */
export function resolveUnsavedPrompt(choice: UnsavedChoice): void {
  const current = queue.shift();
  if (!current) return;
  current.resolve(choice);
  activateNext();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/unit/composables/unsaved-prompt.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/composables/unsaved-prompt.svelte.ts tests/unit/composables/unsaved-prompt.test.ts
git commit -m "feat(composable): add confirmUnsavedChanges helper with three-way result"
```

---

### Task 3: Create `UnsavedChangesDialog.svelte`

**Files:**
- Create: `app/lib/components/UnsavedChangesDialog.svelte`

- [ ] **Step 1: Write the component**

Create `app/lib/components/UnsavedChangesDialog.svelte`:

```svelte
<script lang="ts">
  import { t } from '$lib/i18n';

  interface Props {
    fileNames: string;
    saveLabel: string;
    onSave: () => void;
    onDontSave: () => void;
    onCancel: () => void;
  }

  let { fileNames, saveLabel, onSave, onDontSave, onCancel }: Props = $props();

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onCancel();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      onCancel();
    }
  }

  function focusPrimary(el: HTMLButtonElement) {
    requestAnimationFrame(() => el.focus());
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center"
  style="background: rgba(0, 0, 0, 0.5);"
  role="dialog"
  aria-modal="true"
  aria-labelledby="unsaved-dialog-title"
  onclick={handleBackdropClick}
  data-testid="unsaved-changes-dialog"
>
  <div
    class="rounded-lg shadow-xl p-6 max-w-md w-full mx-4"
    style="background: var(--novelist-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
    role="document"
  >
    <h2 id="unsaved-dialog-title" class="text-base font-semibold mb-3">
      {t('dialog.unsavedChanges')}
    </h2>

    <p class="text-sm mb-5 whitespace-pre-line" style="color: var(--novelist-text-secondary);">
      {t('dialog.unsavedBeforeClose', { names: fileNames })}
    </p>

    <div class="flex gap-3 justify-end">
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: transparent; color: var(--novelist-text-secondary);"
        onclick={onCancel}
        data-testid="unsaved-cancel"
      >
        {t('dialog.unsavedCancel')}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-bg-secondary); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
        onclick={onDontSave}
        data-testid="unsaved-dont-save"
      >
        {t('dialog.dontSave')}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm rounded cursor-pointer hover:opacity-80"
        style="background: var(--novelist-accent); color: #fff;"
        onclick={onSave}
        use:focusPrimary
        data-testid="unsaved-save"
      >
        {saveLabel}
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Run type check**

Run: `pnpm check`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add app/lib/components/UnsavedChangesDialog.svelte
git commit -m "feat(ui): add UnsavedChangesDialog with Save / Don't Save / Cancel"
```

---

### Task 4: Wire dialog into App.svelte

**Files:**
- Modify: `app/App.svelte` (imports + after the ConflictDialog `{#if}` block)

- [ ] **Step 1: Add imports**

In `app/App.svelte`, near the `import ConflictDialog from '$lib/components/ConflictDialog.svelte';` line, add:

```ts
  import UnsavedChangesDialog from '$lib/components/UnsavedChangesDialog.svelte';
  import { unsavedPromptState, resolveUnsavedPrompt } from '$lib/composables/unsaved-prompt.svelte';
```

- [ ] **Step 2: Render the dialog**

Immediately after the existing `{#if conflictFilePath}...{/if}` block (around line 701), insert:

```svelte
{#if unsavedPromptState.pending}
  <UnsavedChangesDialog
    fileNames={unsavedPromptState.pending.fileNames}
    saveLabel={unsavedPromptState.pending.saveLabel}
    onSave={() => resolveUnsavedPrompt('save')}
    onDontSave={() => resolveUnsavedPrompt('discard')}
    onCancel={() => resolveUnsavedPrompt('cancel')}
  />
{/if}
```

- [ ] **Step 3: Run type check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/App.svelte
git commit -m "feat(app): mount UnsavedChangesDialog via unsaved-prompt store"
```

---

### Task 5: Migrate `tabs.svelte.ts#closeTab` to the helper

**Files:**
- Modify: `app/lib/stores/tabs.svelte.ts:320-350`

- [ ] **Step 1: Update the import**

At the top of `app/lib/stores/tabs.svelte.ts`, remove `ask` from the `@tauri-apps/plugin-dialog` import (keep `save as saveDialog`). Replace with:

```ts
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
```

Note: if `ask` is also used elsewhere in the file, grep and keep it imported — but as of this plan it's only used in `closeTab`. Verify with:

```bash
grep -n "\bask\b" app/lib/stores/tabs.svelte.ts
```

Expected: only the `closeTab` usage that we're about to remove.

- [ ] **Step 2: Replace the prompt call**

In `closeTab`, replace lines 320-349 (the `if (tab.isDirty) { ... }` block) with:

```ts
      // Prompt for unsaved changes (Save / Don't Save / Cancel)
      if (tab.isDirty) {
        const scratch = isScratchFile(tab.filePath);
        const choice = await confirmUnsavedChanges({
          fileNames: tab.fileName,
          saveLabel: scratch ? t('dialog.saveAs') : t('dialog.save'),
        });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          this.syncFromView(tab.id);
          const fresh = this.findByPath(tab.filePath);
          if (fresh?.content) {
            if (scratch) {
              const savePath = await saveDialog({
                defaultPath: fresh.fileName,
                filters: [{ name: 'Text files', extensions: ['md', 'markdown', 'txt', 'json', 'jsonl', 'csv'] }],
              });
              if (savePath) {
                await commands.registerWriteIgnore(savePath);
                const result = await commands.writeFile(savePath, fresh.content);
                if (result.status === 'ok') this.markSaved(fresh.id);
              } else {
                // User cancelled the Save-As native picker — abort the close.
                return;
              }
            } else {
              await commands.registerWriteIgnore(fresh.filePath);
              const result = await commands.writeFile(fresh.filePath, fresh.content);
              if (result.status === 'ok') {
                await this.tryRenameAfterSave(fresh.filePath, fresh.content);
                this.markSaved(fresh.id);
              }
            }
          }
        }
        // choice === 'discard' falls through: close without saving.
      }
```

Note on the new `else { return; }` inside scratch-file flow: prior behavior silently closed the tab and lost the content if the user dismissed the native Save-As dialog. With an explicit Cancel path now available, abort the close instead. This is a user-facing improvement consistent with the dismiss intent.

- [ ] **Step 3: Run type check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Run existing tabs tests**

Run: `pnpm test app/lib/stores/tabs` (or `pnpm test tabs` depending on layout).
Expected: any existing tests still PASS. If there are none, skip.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stores/tabs.svelte.ts
git commit -m "feat(tabs): closeTab supports Cancel via confirmUnsavedChanges"
```

---

### Task 6: Migrate `app-lifecycle.svelte.ts` to the helper

**Files:**
- Modify: `app/lib/composables/app-lifecycle.svelte.ts:1-78`

- [ ] **Step 1: Swap imports**

Replace line 2:

```ts
import { ask } from '@tauri-apps/plugin-dialog';
```

with:

```ts
import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
```

- [ ] **Step 2: Replace the prompt and handle cancel**

Replace the body of the `if (dirty.length > 0) { ... }` block (lines 64-77) with:

```ts
    if (dirty.length > 0) {
      event.preventDefault();
      const names = dirty.map(dt => dt.fileName).join(', ');
      const choice = await confirmUnsavedChanges({
        fileNames: names,
        saveLabel: ctx.t('dialog.save'),
      });
      if (choice === 'cancel') return;
      if (choice === 'save') {
        await tabsStore.saveAllDirty();
      }
      for (const tab of tabsStore.dirtyTabs) tabsStore.markSaved(tab.id);
      closeConfirmed = true;
      await getCurrentWindow().destroy();
    }
```

Key invariant preserved from the spec: `closeConfirmed` only flips to `true` on `'save'` / `'discard'`, never on `'cancel'`.

- [ ] **Step 3: Run type check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/composables/app-lifecycle.svelte.ts
git commit -m "feat(lifecycle): onCloseRequested supports Cancel via confirmUnsavedChanges"
```

---

### Task 7: Update `app-lifecycle.test.ts` to cover Cancel branch

**Files:**
- Modify: `tests/unit/composables/app-lifecycle.test.ts`

- [ ] **Step 1: Replace the `ask` mock with the new helper mock**

At the top of `tests/unit/composables/app-lifecycle.test.ts`, inside the `vi.hoisted(...)` block, rename the existing `ask` to `confirmUnsaved` so the test reads naturally. Change:

```ts
  const ask = vi.fn();
```

to:

```ts
  const confirmUnsaved = vi.fn();
```

Update the return value:

```ts
    hoisted: {
      invoke,
      confirmUnsaved,
      unlisten,
      getCurrentWindow,
      destroy,
      tabsState,
      projectState,
      getCloseHandler: () => closeRequestedHandler,
      resetCloseHandler: () => { closeRequestedHandler = null; },
    },
```

Replace the module mock:

```ts
vi.mock('@tauri-apps/plugin-dialog', () => ({ ask: vi.fn() }));
vi.mock('$lib/composables/unsaved-prompt.svelte', () => ({
  confirmUnsavedChanges: (opts: unknown) => hoisted.confirmUnsaved(opts),
}));
```

(Keep the `@tauri-apps/plugin-dialog` mock because other imports in the module may pull it transitively; but if nothing in `app-lifecycle.svelte.ts` imports `ask` any more, you can delete that mock line too — run `pnpm check` after deletion to confirm.)

In `beforeEach`, replace `hoisted.ask.mockReset();` with `hoisted.confirmUnsaved.mockReset();`.

- [ ] **Step 2: Update existing onCloseRequested cases**

Find each `hoisted.ask.mockResolvedValue(true)` / `(false)` and replace:

- `hoisted.ask.mockResolvedValue(true);` → `hoisted.confirmUnsaved.mockResolvedValue('save');`
- `hoisted.ask.mockResolvedValue(false);` → `hoisted.confirmUnsaved.mockResolvedValue('discard');`

Find each `expect(hoisted.ask).toHaveBeenCalled()` → `expect(hoisted.confirmUnsaved).toHaveBeenCalled()`.

Find each `expect(hoisted.ask).not.toHaveBeenCalled()` → `expect(hoisted.confirmUnsaved).not.toHaveBeenCalled()`.

- [ ] **Step 3: Add the Cancel-branch test**

Inside the `describe('[contract] useAppLifecycle — onCloseRequested', ...)` block, add this test after the "skips saveAllDirty but still destroys when user says 'dont save'" case:

```ts
  it('does NOT destroy and does NOT save when user cancels', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValue('cancel');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    const preventDefault = vi.fn();
    await hoisted.getCloseHandler()!({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(hoisted.confirmUnsaved).toHaveBeenCalled();
    expect(hoisted.tabsState.saveAllDirty).not.toHaveBeenCalled();
    expect(hoisted.tabsState.markSaved).not.toHaveBeenCalled();
    expect(hoisted.destroy).not.toHaveBeenCalled();
    teardown();
  });

  it('does NOT latch closeConfirmed after cancel — subsequent close re-prompts', async () => {
    hoisted.tabsState.dirtyTabs = [{ id: 't1', fileName: 'a.md' }];
    hoisted.confirmUnsaved.mockResolvedValueOnce('cancel');
    const teardown = useAppLifecycle(ctx());
    await flushListeners();
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    // Second close attempt: helper must be called again (not latched).
    hoisted.confirmUnsaved.mockResolvedValueOnce('discard');
    await hoisted.getCloseHandler()!({ preventDefault: vi.fn() });
    expect(hoisted.confirmUnsaved).toHaveBeenCalledTimes(2);
    expect(hoisted.destroy).toHaveBeenCalledTimes(1); // only the discard call destroyed
    teardown();
  });
```

- [ ] **Step 4: Run the test file**

Run: `pnpm test tests/unit/composables/app-lifecycle.test.ts`
Expected: all PASS (including 2 new tests).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/composables/app-lifecycle.test.ts
git commit -m "test(lifecycle): cover Cancel branch of unsaved-changes prompt"
```

---

### Task 8: Migrate `Sidebar.svelte` project-switch prompt

**Files:**
- Modify: `app/lib/components/Sidebar.svelte:100-113`

- [ ] **Step 1: Add import**

Near the other imports at the top of the `<script>` block in `app/lib/components/Sidebar.svelte`, add:

```ts
  import { confirmUnsavedChanges } from '$lib/composables/unsaved-prompt.svelte';
```

- [ ] **Step 2: Replace `confirm()` with helper**

Replace lines 106-113 (inside `openProjectFromPath`, the `if (projectStore.isOpen) { ... }` block) with:

```ts
    if (projectStore.isOpen) {
      const dirty = tabsStore.dirtyTabs;
      if (dirty.length > 0) {
        const names = dirty.map(t => t.fileName).join(', ');
        const choice = await confirmUnsavedChanges({
          fileNames: names,
          saveLabel: t('dialog.save'),
        });
        if (choice === 'cancel') return;
        if (choice === 'save') await tabsStore.saveAllDirty();
      }
    }
```

- [ ] **Step 3: Run type check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/components/Sidebar.svelte
git commit -m "feat(sidebar): project switch supports Cancel via confirmUnsavedChanges"
```

---

### Task 9: Run the full test suite

**Files:** none (verification only)

- [ ] **Step 1: Unit tests**

Run: `pnpm test`
Expected: PASS (including the 5 new `unsaved-prompt` tests and the 2 new `app-lifecycle` tests).

- [ ] **Step 2: Type check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Browser E2E (smoke)**

Run: `pnpm test:e2e:browser`
Expected: PASS. If any dirty-tab test was relying on `ask()` via mocked IPC, update the mock to the new helper (likely none, since browser E2E uses mock IPC not `@tauri-apps/plugin-dialog`).

- [ ] **Step 4: Commit any fallout fixes**

If test fixes are needed, commit separately:

```bash
git add <fixed files>
git commit -m "test: align fixtures with three-way unsaved-changes choice"
```

---

### Task 10: Manual QA in `pnpm tauri dev`

**Files:** none (manual verification)

- [ ] **Step 1: Start the app**

Run: `pnpm tauri dev`

- [ ] **Step 2: Close-tab flow**

1. Open any file, edit it (make dirty).
2. Close the tab (Cmd+W / click ×).
3. Verify the custom dialog appears with three buttons: Cancel, Don't Save, Save (scratch files show "Save As…" instead).
4. Click Cancel → tab stays, still dirty.
5. Press ESC → same result.
6. Click backdrop → same result.
7. Click Don't Save → tab closes without saving.
8. Re-dirty, click Save → file saves and tab closes.

- [ ] **Step 3: Window-close flow**

1. With at least one dirty tab, press Cmd+Q.
2. Verify the same dialog appears.
3. Cancel → window stays, tab still dirty, no "closeConfirmed" latch (Cmd+Q again re-prompts).
4. Repeat with Save and Don't Save.

- [ ] **Step 4: Project-switch flow**

1. Open a project, dirty a file, open Sidebar project switcher, pick another recent project.
2. Cancel → current project stays, dirty file unchanged.
3. Save / Don't Save → switch proceeds.

- [ ] **Step 5: IME sanity**

1. In CJK IME, start composing text in an editor.
2. Trigger any unsaved-changes prompt.
3. Press ESC to cancel composition inside the editor input — verify the dialog only dismisses when the IME composition is NOT active (the `!e.isComposing` guard).

- [ ] **Step 6: Commit if any manual-QA follow-ups**

If QA reveals a bug, fix and commit with a clear message. Otherwise no commit needed.

---

## Self-review (performed 2026-04-22)

**Spec coverage:**
- Spec `## Goal` (3-way outcome): Tasks 2, 3 ✓
- Spec ESC + backdrop → Cancel: Task 3 ✓
- Spec call-site matrix: Tasks 5, 6, 8 ✓
- Spec i18n key `dialog.unsavedCancel`: Task 1 ✓
- Spec unit tests for helper + app-lifecycle cancel branch: Tasks 2, 7 ✓
- Spec risk "closeConfirmed latch must not flip on cancel": Task 6 + Task 7 (second test) ✓
- Spec risk "IME composition guard": Task 3 (`!e.isComposing`) + Task 10 step 5 ✓

**Placeholder scan:** no TBD / TODO / "similar to Task N" / "add validation" placeholders.

**Type consistency:** `UnsavedChoice = 'save' | 'discard' | 'cancel'` is used identically in Task 2 (definition), Tasks 5/6/8 (call-site branching), Task 7 (test assertions).

**Naming consistency:** `confirmUnsavedChanges` / `unsavedPromptState` / `resolveUnsavedPrompt` consistent across all tasks.
