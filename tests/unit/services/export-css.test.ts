import { describe, expect, it, vi } from 'vitest';
import { builtinThemes } from '$lib/themes';
import {
  EXPORT_CSS_CANCEL_CLEANUP_WARNING,
  EXPORT_CSS_STAGE_ERROR,
  stageThemeCssForExport,
} from '$lib/services/export-css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('[contract] stageThemeCssForExport', () => {
  const theme = builtinThemes[0];

  it('removes staged CSS and skips backend ownership when cancellation happens while write is pending', async () => {
    let cancelled = false;
    const write = deferred<{ status: 'ok'; data: string }>();
    const deleteItem = vi.fn(async () => ({ status: 'ok' as const, data: null }));
    const staging = stageThemeCssForExport(theme, {
      stageCss: vi.fn(() => write.promise),
      deleteItem,
      requestId: 'abc123',
      isCancelled: () => cancelled,
    });

    cancelled = true;
    write.resolve({ status: 'ok', data: '/tmp/novelist-export-theme-abc123.html' });
    const result = await staging;

    expect(result).toEqual({ status: 'cancelled' });
    expect(deleteItem).toHaveBeenCalledWith('/tmp/novelist-export-theme-abc123.html');
  });

  it('passes staged CSS args to backend ownership on normal themed export', async () => {
    const deleteItem = vi.fn();
    const result = await stageThemeCssForExport(theme, {
      stageCss: vi.fn(async () => ({ status: 'ok' as const, data: '/tmp/novelist-export-theme-abc123.html' })),
      deleteItem,
      requestId: 'abc123',
      isCancelled: () => false,
    });

    expect(result).toEqual({ status: 'ok', args: ['--include-in-header', '/tmp/novelist-export-theme-abc123.html'] });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('surfaces bounded CSS write failure and does not delete or produce backend args', async () => {
    const deleteItem = vi.fn();
    const result = await stageThemeCssForExport(theme, {
      stageCss: vi.fn(async () => ({ status: 'error' as const, error: 'disk full with path details' })),
      deleteItem,
      requestId: 'abc123',
      isCancelled: () => false,
    });

    expect(result).toEqual({ status: 'error', message: EXPORT_CSS_STAGE_ERROR });
    expect(deleteItem).not.toHaveBeenCalled();
  });

  it('does not proceed when cancellation cleanup fails', async () => {
    const warn = vi.fn();
    const result = await stageThemeCssForExport(theme, {
      stageCss: vi.fn(async () => ({ status: 'ok' as const, data: '/tmp/novelist-export-theme-abc123.html' })),
      deleteItem: vi.fn(async () => ({ status: 'error' as const, error: 'permission denied' })),
      requestId: 'abc123',
      isCancelled: () => true,
      warn,
    });

    expect(result).toEqual({
      status: 'cancelled',
      warning: EXPORT_CSS_CANCEL_CLEANUP_WARNING,
    });
    expect(warn).toHaveBeenCalledWith(EXPORT_CSS_CANCEL_CLEANUP_WARNING);
  });
});
