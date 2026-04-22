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
