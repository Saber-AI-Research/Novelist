import { commands } from '$lib/ipc/commands';

export async function writeDraftNoteStrict(
  projectDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const result = await commands.writeDraftNote(projectDir, filePath, content);
  if (result.status === 'error') {
    throw new Error(result.error);
  }
}

export function handleDraftSaveFireAndForget(
  promise: Promise<void>,
  onFailure: (message: string) => void = console.warn,
): void {
  void promise.catch((error) => {
    onFailure(formatDraftSaveFailure(error));
  });
}

function formatDraftSaveFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safeSummary = raw.split(':')[0]?.trim() || 'unknown error';
  return `Draft note save failed: ${safeSummary}`;
}
