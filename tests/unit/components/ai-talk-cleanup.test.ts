import { describe, it, expect, vi } from 'vitest';
import { cancelPendingStreams } from '$lib/components/ai-talk/cleanup';

describe('cancelPendingStreams', () => {
  it('cancels every non-null id exactly once', () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    cancelPendingStreams(['stream-a', 'stream-b'], cancel);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(1, 'stream-a');
    expect(cancel).toHaveBeenNthCalledWith(2, 'stream-b');
  });

  it('skips null and undefined ids', () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    cancelPendingStreams([null, undefined, 'only-real-one'], cancel);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith('only-real-one');
  });

  it('is a no-op when every id is null/undefined', () => {
    const cancel = vi.fn();
    cancelPendingStreams([null, undefined], cancel);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not throw when the cancel helper rejects', async () => {
    // Synchronous call must return before the rejection propagates; any
    // unhandled rejection would be caught by the helper's internal .catch.
    const cancel = vi.fn().mockRejectedValue(new Error('ipc gone'));
    expect(() => cancelPendingStreams(['a', 'b'], cancel)).not.toThrow();
    // Flush microtasks so the rejection-swallowing .catch runs without
    // triggering an unhandledrejection in the test harness.
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('calls cancel synchronously for each id (does not await between them)', () => {
    // Regression guard: if one stream's cancel hangs, the other must still
    // be issued. Using a never-resolving promise for the first id must not
    // block the second call.
    const never = new Promise<void>(() => {});
    const cancel = vi
      .fn<(id: string) => Promise<unknown>>()
      .mockImplementationOnce(() => never)
      .mockResolvedValue(undefined);
    cancelPendingStreams(['hangs', 'quick'], cancel);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenNthCalledWith(1, 'hangs');
    expect(cancel).toHaveBeenNthCalledWith(2, 'quick');
  });
});
