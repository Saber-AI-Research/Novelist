import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    moveItem: vi.fn(),
    renameItem: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';
import {
  __resetRenameFlushProvidersForTests,
  moveItemAfterSidecarFlush,
  registerRenameFlushProvider,
  renameItemAfterSidecarFlush,
} from '$lib/services/rename-coordinator';

describe('rename sidecar flush coordinator', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    __resetRenameFlushProvidersForTests();
    (commands.renameItem as any).mockResolvedValue({
      status: 'ok',
      data: { new_path: '/project/new.md', migration: { status: 'full_success', migrated: 1, conflicts: 0, errors: [] } },
    });
    (commands.moveItem as any).mockResolvedValue({
      status: 'ok',
      data: { new_path: '/project/archive/old.md', migration: { status: 'full_success', migrated: 1, conflicts: 0, errors: [] } },
    });
  });

  it('awaits registered DraftNote/recovery flush promises before rename IPC', async () => {
    const order: string[] = [];
    registerRenameFlushProvider(async (oldPath) => {
      expect(oldPath).toBe('/project/old.md');
      order.push('flush-start');
      await Promise.resolve();
      order.push('flush-end');
    });
    (commands.renameItem as any).mockImplementation(async () => {
      order.push('rename');
      return { status: 'ok', data: { new_path: '/project/new.md', migration: { status: 'full_success', migrated: 1, conflicts: 0, errors: [] } } };
    });

    const result = await renameItemAfterSidecarFlush('/project', '/project/old.md', 'new.md', true);

    expect(result.status).toBe('ok');
    expect(order).toEqual(['flush-start', 'flush-end', 'rename']);
    expect(commands.renameItem).toHaveBeenCalledWith('/project', '/project/old.md', 'new.md', true);
  });

  it('does not invoke rename IPC when project root is missing', async () => {
    const result = await renameItemAfterSidecarFlush('', '/project/old.md', 'new.md', null);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain('project root');
    }
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('does not invoke rename IPC when a flush provider rejects', async () => {
    registerRenameFlushProvider(async () => {
      throw new Error('draft write failed');
    });

    const result = await renameItemAfterSidecarFlush('/project', '/project/old.md', 'new.md', null);

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain('draft write failed');
    }
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('does not invoke rename IPC when a flush provider times out', async () => {
    vi.useFakeTimers();
    registerRenameFlushProvider(() => new Promise(() => {}));

    const pending = renameItemAfterSidecarFlush('/project', '/project/old.md', 'new.md', null, 25);
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toContain('timed out');
    }
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('logs soft migration errors safely without converting successful rename to error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (commands.renameItem as any).mockResolvedValue({
      status: 'ok',
      data: {
        new_path: '/project/new.md',
        migration: {
          status: 'user_file_renamed_with_metadata_errors',
          migrated: 1,
          conflicts: 0,
          errors: ['draft write failed: secret draft content'],
        },
      },
    });

    const result = await renameItemAfterSidecarFlush('/project', '/project/old.md', 'new.md', null);

    expect(result.status).toBe('ok');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('Rename completed with metadata errors');
    expect(message).toContain('migrated=1');
    expect(message).not.toContain('secret draft content');
    warn.mockRestore();
  });

  it('flushes sidecars before moving and supplies the project root to IPC', async () => {
    const order: string[] = [];
    registerRenameFlushProvider(async (oldPath) => {
      expect(oldPath).toBe('/project/old.md');
      order.push('flush');
    });
    (commands.moveItem as any).mockImplementation(async () => {
      order.push('move');
      return {
        status: 'ok',
        data: {
          new_path: '/project/archive/old.md',
          migration: { status: 'full_success', migrated: 3, conflicts: 0, errors: [] },
        },
      };
    });

    const result = await moveItemAfterSidecarFlush(
      '/project',
      '/project/old.md',
      '/project/archive',
    );

    expect(result.status).toBe('ok');
    expect(order).toEqual(['flush', 'move']);
    expect(commands.moveItem).toHaveBeenCalledWith(
      '/project',
      '/project/old.md',
      '/project/archive',
    );
  });

  it('does not invoke move IPC when a sidecar flush fails', async () => {
    registerRenameFlushProvider(async () => {
      throw new Error('publish state still committing');
    });

    const result = await moveItemAfterSidecarFlush(
      '/project',
      '/project/old.md',
      '/project/archive',
    );

    expect(result.status).toBe('error');
    expect(commands.moveItem).not.toHaveBeenCalled();
  });
});
