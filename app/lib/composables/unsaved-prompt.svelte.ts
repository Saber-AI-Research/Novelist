export type UnsavedChoice = 'save' | 'discard' | 'cancel';

interface PendingPrompt {
  fileNames: string;
  saveLabel: string;
}

interface QueuedRequest extends PendingPrompt {
  resolve: (choice: UnsavedChoice) => void;
}

export const unsavedPromptState: { pending: PendingPrompt | null } = $state({ pending: null });

const queue: QueuedRequest[] = [];

function activateNext() {
  const next = queue[0];
  unsavedPromptState.pending = next
    ? { fileNames: next.fileNames, saveLabel: next.saveLabel }
    : null;
}

export function confirmUnsavedChanges(opts: {
  fileNames: string;
  saveLabel: string;
}): Promise<UnsavedChoice> {
  return new Promise<UnsavedChoice>((resolve) => {
    queue.push({ fileNames: opts.fileNames, saveLabel: opts.saveLabel, resolve });
    if (queue.length === 1) activateNext();
  });
}

export function resolveUnsavedPrompt(choice: UnsavedChoice): void {
  const current = queue.shift();
  if (!current) return;
  current.resolve(choice);
  activateNext();
}
