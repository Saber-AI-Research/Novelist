import { invoke } from '@tauri-apps/api/core';
import type {
  AiPromptAsset,
  AiPromptAssets,
  AiSessionFile,
  AiSessionKind,
} from '$lib/ipc/commands';

export type {
  AiPromptAsset,
  AiPromptAssets,
  AiSessionFile,
  AiSessionKind,
} from '$lib/ipc/commands';

function sessionKindArg(kind: AiSessionKind): 'talk' | 'agent' {
  return kind;
}

export async function listAiSessions(
  projectDir: string,
  kind: AiSessionKind,
): Promise<AiSessionFile[]> {
  return invoke<AiSessionFile[]>('list_ai_sessions', {
    projectDir,
    kind: sessionKindArg(kind),
  });
}

export async function readAiSession(
  projectDir: string,
  kind: AiSessionKind,
  id: string,
): Promise<string | null> {
  return invoke<string | null>('read_ai_session', {
    projectDir,
    kind: sessionKindArg(kind),
    id,
  });
}

export async function writeAiSession(
  projectDir: string,
  kind: AiSessionKind,
  id: string,
  value: unknown,
): Promise<void> {
  await invoke('write_ai_session', {
    projectDir,
    kind: sessionKindArg(kind),
    id,
    bodyJson: JSON.stringify(value),
  });
}

export async function deleteAiSession(
  projectDir: string,
  kind: AiSessionKind,
  id: string,
): Promise<void> {
  await invoke('delete_ai_session', {
    projectDir,
    kind: sessionKindArg(kind),
    id,
  });
}

export async function listAiPromptAssets(projectDir: string): Promise<AiPromptAssets> {
  return invoke<AiPromptAssets>('list_ai_prompt_assets', { projectDir });
}

export async function writeAiMemory(projectDir: string, body: string): Promise<void> {
  await invoke('write_ai_memory', { projectDir, body });
}
