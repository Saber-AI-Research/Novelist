import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  writeFileIfUnchanged: vi.fn<(
    projectDir: string,
    path: string,
    expectedContent: string | null,
    content: string,
  ) => Promise<
    | { status: 'ok'; data: 'written' | 'conflict' }
    | { status: 'error'; error: string }
  >>(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: { writeFileIfUnchanged: ipc.writeFileIfUnchanged },
}));

import { conditionalFileWrite } from '$lib/services/conditional-file-write';

describe('conditionalFileWrite', () => {
  beforeEach(() => {
    ipc.writeFileIfUnchanged.mockReset();
  });

  it('forwards null expected content and returns written', async () => {
    ipc.writeFileIfUnchanged.mockResolvedValue({ status: 'ok', data: 'written' });

    await expect(conditionalFileWrite('/project', '/project/new.md', null, '新内容')).resolves.toBe('written');
    expect(ipc.writeFileIfUnchanged).toHaveBeenCalledWith('/project', '/project/new.md', null, '新内容');
  });

  it('forwards exact string expected content and returns conflict', async () => {
    ipc.writeFileIfUnchanged.mockResolvedValue({ status: 'ok', data: 'conflict' });

    await expect(conditionalFileWrite('/project', '/project/chapter.md', '', '正文')).resolves.toBe('conflict');
    expect(ipc.writeFileIfUnchanged).toHaveBeenCalledWith('/project', '/project/chapter.md', '', '正文');
  });

  it('throws the outer IPC string error unchanged', async () => {
    ipc.writeFileIfUnchanged.mockResolvedValue({ status: 'error', error: 'atomic write failed' });

    await expect(conditionalFileWrite('/project', '/project/chapter.md', 'old', 'new'))
      .rejects.toBe('atomic write failed');
  });
});
