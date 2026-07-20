export {
  NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
  NATIVE_FIXTURE_TIMEOUT_MS,
  NATIVE_WORKFLOW_TIMEOUT_MS,
} from './native-timeout-policy.mjs';

export type NativeStageLogger = (message: string) => void | Promise<void>;

export async function runNativeStage<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>,
  log: NativeStageLogger,
): Promise<T> {
  const startedAt = Date.now();
  await log(`native_stage=${label} state=begin timeout_ms=${timeoutMs} at=${new Date(startedAt).toISOString()}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`native stage "${label}" timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    await log(`native_stage=${label} state=pass elapsed_ms=${Date.now() - startedAt} at=${new Date().toISOString()}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(`native_stage=${label} state=fail elapsed_ms=${Date.now() - startedAt} error=${JSON.stringify(message)} at=${new Date().toISOString()}`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
