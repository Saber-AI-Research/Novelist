import { commands } from '$lib/ipc/commands';
import {
  detach,
  enableManaged,
  hasCanonicalTitleToken,
  parse,
  reEnable,
  serialize,
  updateAnchor,
  type ManagedNameState,
} from '$lib/utils/managed-name';

export type ManagedNameLoadResult =
  | { kind: 'ready'; state: ManagedNameState }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string };

// Managed state is cross-window durable ownership. Reads intentionally bypass
// in-memory caching so detach, migration conflicts, and failed enrollment are
// observed from the sidecar before any rename decision.
export function invalidateManagedName(_projectDir: string, _filePath: string): void {}

export function clearManagedNameCache(): void {}

export async function migrateManagedNameCachePath(
  _projectDir: string,
  _oldPath: string,
  _newPath: string,
): Promise<void> {}

export async function computeManagedDocumentKey(
  projectDir: string,
  filePath: string,
): Promise<string | null> {
  const result = await commands.computeDocumentKey(projectDir, filePath);
  return result.status === 'ok' ? result.data : null;
}

export async function loadManagedName(
  projectDir: string,
  filePath: string,
): Promise<ManagedNameLoadResult> {
  const result = await commands.readManagedNameState(projectDir, filePath);
  if (result.status !== 'ok') {
    return { kind: 'invalid', error: String(result.error) } as const;
  }
  if (result.data === null) {
    return { kind: 'missing' } as const;
  }
  const parsed = parse(JSON.stringify(result.data));
  const next = parsed
    ? ({ kind: 'ready', state: parsed } as const)
    : ({ kind: 'invalid', error: 'Invalid managed-name state shape' } as const);
  return next;
}

export async function writeManagedName(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
): Promise<ManagedNameState | null> {
  if (!serialize(state)) return null;
  const result = await commands.writeManagedNameState(projectDir, filePath, state);
  if (result.status !== 'ok') return null;
  return state;
}

export async function enableManagedNameForCreatedFile(
  projectDir: string,
  filePath: string,
  resolvedTemplateRaw: string,
  currentH1: string,
): Promise<ManagedNameState | null> {
  if (!hasCanonicalTitleToken(resolvedTemplateRaw)) return null;
  const documentKey = await computeManagedDocumentKey(projectDir, filePath);
  if (!documentKey) return null;
  const state = enableManaged(resolvedTemplateRaw, documentKey, currentH1);
  if (!state) return null;
  const written = await writeManagedName(projectDir, filePath, state);
  if (written) return written;
  return null;
}

export async function confirmManagedNameEnrollment(
  projectDir: string,
  filePath: string,
  expected: ManagedNameState,
): Promise<boolean> {
  try {
    const result = await commands.readManagedNameState(projectDir, filePath);
    if (result.status !== 'ok' || result.data === null) return false;
    const persisted = parse(JSON.stringify(result.data));
    const expectedRaw = serialize(expected);
    const persistedRaw = persisted ? serialize(persisted) : null;
    if (!persisted || expectedRaw === null || persistedRaw !== expectedRaw) return false;
    return true;
  } catch {
    return false;
  }
}

export async function detachManagedName(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
): Promise<ManagedNameState | null> {
  return writeManagedName(projectDir, filePath, detach(state));
}

export async function reEnableManagedName(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
): Promise<ManagedNameState | null> {
  return writeManagedName(projectDir, filePath, reEnable(state));
}

export async function deleteManagedName(projectDir: string, filePath: string): Promise<boolean> {
  const result = await commands.deleteManagedNameState(projectDir, filePath);
  return result.status === 'ok';
}

export async function updateManagedNameAnchor(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
  currentH1: string,
): Promise<ManagedNameState | null> {
  return writeManagedName(projectDir, filePath, updateAnchor(state, currentH1));
}
