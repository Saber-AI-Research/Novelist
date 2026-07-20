type ProjectSwitchFlushProvider = (
  previousProjectDir: string | null,
  nextProjectDir: string | null,
) => Promise<void> | void;

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
const providers = new Set<ProjectSwitchFlushProvider>();

export function registerProjectSwitchFlushProvider(
  provider: ProjectSwitchFlushProvider,
): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

export async function flushProjectSwitch(
  previousProjectDir: string | null,
  nextProjectDir: string | null,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  const snapshot = [...providers];
  const results = await Promise.allSettled(
    snapshot.map((provider) =>
      withTimeout(
        Promise.resolve().then(() => provider(previousProjectDir, nextProjectDir)),
        timeoutMs,
      ),
    ),
  );
  const first = results.find((r) => r.status === 'rejected') as
    | PromiseRejectedResult
    | undefined;
  if (first) throw first.reason;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Project-switch flush timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      },
    );
  });
}

export function __resetProjectSwitchFlushProvidersForTests(): void {
  providers.clear();
}
