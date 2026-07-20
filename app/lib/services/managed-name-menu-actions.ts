import type { ManagedNameState } from '$lib/utils/managed-name';

export type ManagedNameMenuPersistResult =
  | { kind: 'persisted'; state: ManagedNameState }
  | { kind: 'failed' };

type PersistState = (
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
) => Promise<ManagedNameState | null>;

type Warn = (message: string) => void;

export async function persistStopAutoNamingMenuAction(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
  detachManagedName: PersistState,
  warn: Warn = console.warn,
): Promise<ManagedNameMenuPersistResult> {
  const next = await detachManagedName(projectDir, filePath, state);
  if (!next) {
    warn('Managed-name detach failed from sidebar menu');
    return { kind: 'failed' };
  }
  return { kind: 'persisted', state: next };
}

export async function persistReEnableAutoNamingMenuAction(
  projectDir: string,
  filePath: string,
  state: ManagedNameState,
  reEnableManagedName: PersistState,
  warn: Warn = console.warn,
): Promise<ManagedNameMenuPersistResult> {
  const next = await reEnableManagedName(projectDir, filePath, state);
  if (!next) {
    warn('Managed-name re-enable failed from sidebar menu');
    return { kind: 'failed' };
  }
  return { kind: 'persisted', state: next };
}
