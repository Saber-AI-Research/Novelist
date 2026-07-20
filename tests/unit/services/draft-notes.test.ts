import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    writeDraftNote: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';
import { handleDraftSaveFireAndForget, writeDraftNoteStrict } from '$lib/services/draft-notes';

describe('draft note writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves only for typed ok results', async () => {
    vi.mocked(commands.writeDraftNote).mockResolvedValue({ status: 'ok', data: null });

    await expect(writeDraftNoteStrict('/project', '/project/a.md', 'note')).resolves.toBeUndefined();
  });

  it('throws for typed error results so rename flush can block IPC', async () => {
    vi.mocked(commands.writeDraftNote).mockResolvedValue({ status: 'error', error: 'disk full' });

    await expect(writeDraftNoteStrict('/project', '/project/a.md', 'note')).rejects.toThrow('disk full');
  });

  it('handles fire-and-forget save rejection with a safe diagnostic callback', async () => {
    const onFailure = vi.fn();
    const save = Promise.reject(new Error('disk full: secret draft content'));

    handleDraftSaveFireAndForget(save, onFailure);
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0]).toContain('Draft note save failed');
    expect(onFailure.mock.calls[0][0]).toContain('disk full');
    expect(onFailure.mock.calls[0][0]).not.toContain('secret draft content');
  });
});
