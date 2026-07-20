import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  saveAiChat: vi.fn<(
    projectDir: string,
    filename: string,
    body: string,
  ) => Promise<
    | { status: 'ok'; data: string }
    | { status: 'error'; error: string }
  >>(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: { saveAiChat: ipc.saveAiChat },
}));

import { aiChatBasename, saveAiChat } from '$lib/services/ai-chat';

describe('saveAiChat', () => {
  beforeEach(() => {
    ipc.saveAiChat.mockReset();
  });

  it('forwards the project, filename, and exact CJK markdown', async () => {
    ipc.saveAiChat.mockResolvedValue({
      status: 'ok',
      data: '/项目/.novelist/chats/第一章.md',
    });

    await saveAiChat('/项目', '第一章.md', '# 第一章\n\n正文。\n');

    expect(ipc.saveAiChat).toHaveBeenCalledWith(
      '/项目',
      '第一章.md',
      '# 第一章\n\n正文。\n',
    );
  });

  it('returns the resolved collision-bumped path and handles both basename separators', async () => {
    ipc.saveAiChat.mockResolvedValue({
      status: 'ok',
      data: 'C:\\项目\\.novelist\\chats\\第一章 2.md',
    });

    const path = await saveAiChat('C:\\项目', '第一章.md', '正文');

    expect(path).toBe('C:\\项目\\.novelist\\chats\\第一章 2.md');
    expect(aiChatBasename(path)).toBe('第一章 2.md');
    expect(aiChatBasename('/项目/.novelist/chats/第一章 3.md')).toBe('第一章 3.md');
  });

  it('throws the outer IPC error unchanged', async () => {
    ipc.saveAiChat.mockResolvedValue({ status: 'error', error: 'chat save failed' });

    await expect(saveAiChat('/project', 'chat.md', 'body')).rejects.toBe('chat save failed');
  });
});
