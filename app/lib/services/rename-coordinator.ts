import { commands } from '$lib/ipc/commands';

type RenameFlushProvider = (oldPath: string) => Promise<void> | void;
type RenameResult = Awaited<ReturnType<typeof commands.renameItem>>;
type MoveResult = Awaited<ReturnType<typeof commands.moveItem>>;

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const PROVIDER_REGISTRY_KEY = '__NOVELIST_RENAME_FLUSH_PROVIDERS__';
const providerGlobal = globalThis as typeof globalThis & {
  [PROVIDER_REGISTRY_KEY]?: Set<RenameFlushProvider>;
};
const providers = providerGlobal[PROVIDER_REGISTRY_KEY]
  ?? (providerGlobal[PROVIDER_REGISTRY_KEY] = new Set<RenameFlushProvider>());

export function registerRenameFlushProvider(provider: RenameFlushProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

export async function flushRenameSidecars(
  oldPath: string,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const flushes = [...providers].map((provider) => withTimeout(
    Promise.resolve().then(() => provider(oldPath)),
    timeoutMs,
  ));
  await Promise.all(flushes);
}

export async function renameItemAfterSidecarFlush(
  projectDir: string | null | undefined,
  oldPath: string,
  newName: string,
  allowCollisionBump: boolean | null,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<RenameResult> {
  if (!projectDir?.trim()) {
    return {
      status: 'error',
      error: 'Cannot rename without a valid project root',
    } as RenameResult;
  }
  try {
    await flushRenameSidecars(oldPath, timeoutMs);
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    } as RenameResult;
  }
  const result = await commands.renameItem(projectDir, oldPath, newName, allowCollisionBump);
  logMigrationWarning('Rename', result);
  return result;
}

export async function moveItemAfterSidecarFlush(
  projectDir: string | null | undefined,
  oldPath: string,
  targetDir: string,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<MoveResult> {
  if (!projectDir?.trim()) {
    return {
      status: 'error',
      error: 'Cannot move without a valid project root',
    } as MoveResult;
  }
  try {
    await flushRenameSidecars(oldPath, timeoutMs);
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    } as MoveResult;
  }
  const result = await commands.moveItem(projectDir, oldPath, targetDir);
  logMigrationWarning('Move', result);
  return result;
}

function logMigrationWarning(
  operation: 'Rename' | 'Move',
  result: RenameResult | MoveResult,
): void {
  if (result.status !== 'ok' || result.data.migration.status !== 'user_file_renamed_with_metadata_errors') return;
  const { migration } = result.data;
  console.warn(
    `${operation} completed with metadata errors: migrated=${migration.migrated} conflicts=${migration.conflicts} errors=${migration.errors.length}`,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Rename sidecar flush timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function __resetRenameFlushProvidersForTests(): void {
  providers.clear();
}

export function __getRenameFlushProviderCountForTests(): number {
  return providers.size;
}
