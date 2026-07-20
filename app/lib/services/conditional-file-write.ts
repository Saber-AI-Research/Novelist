import { commands } from '$lib/ipc/commands';

export type ConditionalFileWriteResult = 'written' | 'conflict';

export async function conditionalFileWrite(
  projectDir: string,
  path: string,
  expectedContent: string | null,
  content: string,
): Promise<ConditionalFileWriteResult> {
  const result = await commands.writeFileIfUnchanged(projectDir, path, expectedContent, content);
  if (result.status === 'error') throw result.error;
  return result.data;
}
