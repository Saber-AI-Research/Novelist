import { describe, expect, it, vi } from 'vitest';
import type { ManagedNameState } from '$lib/utils/managed-name';
import {
  persistReEnableAutoNamingMenuAction,
  persistStopAutoNamingMenuAction,
} from '$lib/services/managed-name-menu-actions';

function state(overrides: Partial<ManagedNameState> = {}): ManagedNameState {
  return {
    version: 1,
    status: 'managed',
    templateRaw: '第{N}章-{title}',
    currentH1: '开篇',
    documentKey: 'chapter.md',
    ...overrides,
  };
}

describe('[contract] managed-name sidebar menu actions', () => {
  it('keeps stop action open/honest when detach persistence fails', async () => {
    const warn = vi.fn();
    const detach = vi.fn().mockResolvedValue(null);

    await expect(
      persistStopAutoNamingMenuAction('/proj', '/proj/chapter.md', state(), detach, warn),
    ).resolves.toEqual({ kind: 'failed' });

    expect(warn).toHaveBeenCalledWith('Managed-name detach failed from sidebar menu');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/chapter.md');
  });

  it('returns detached state only after stop persistence succeeds', async () => {
    const detached = state({ status: 'detached' });
    const detach = vi.fn().mockResolvedValue(detached);

    await expect(
      persistStopAutoNamingMenuAction('/proj', '/proj/chapter.md', state(), detach, vi.fn()),
    ).resolves.toEqual({ kind: 'persisted', state: detached });
  });

  it('keeps re-enable action open/honest when persistence fails', async () => {
    const warn = vi.fn();
    const reEnable = vi.fn().mockResolvedValue(null);

    await expect(
      persistReEnableAutoNamingMenuAction('/proj', '/proj/chapter.md', state({ status: 'detached' }), reEnable, warn),
    ).resolves.toEqual({ kind: 'failed' });

    expect(warn).toHaveBeenCalledWith('Managed-name re-enable failed from sidebar menu');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/proj/chapter.md');
  });

  it('returns managed state only after re-enable persistence succeeds', async () => {
    const managed = state({ status: 'managed' });
    const reEnable = vi.fn().mockResolvedValue(managed);

    await expect(
      persistReEnableAutoNamingMenuAction('/proj', '/proj/chapter.md', state({ status: 'detached' }), reEnable, vi.fn()),
    ).resolves.toEqual({ kind: 'persisted', state: managed });
  });
});
