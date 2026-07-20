import { commands } from '$lib/ipc/commands';

export async function saveAiChat(
  projectDir: string,
  filename: string,
  body: string,
): Promise<string> {
  const result = await commands.saveAiChat(projectDir, filename, body);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export function aiChatBasename(path: string): string {
  return path.split(/[\\/]/u).at(-1) || path;
}
