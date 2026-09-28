import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * [contract] fileMetaStore — sidebar word counts + relative "last edited"
 * labels. Word counts come from `get_writing_stats` (Rust, CJK-aware).
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    getWritingStats: vi.fn(),
  },
}));

import { fileMetaStore, formatRelativeTime } from '$lib/stores/file-meta.svelte';
import { commands } from '$lib/ipc/commands';

const getWritingStats = vi.mocked(commands.getWritingStats);

function stats(chapters: Array<[string, number]>) {
  return {
    status: 'ok' as const,
    data: {
      daily: [],
      total_words: chapters.reduce((n, [, c]) => n + c, 0),
      chapters: chapters.map(([file_path, word_count]) => ({
        file_name: file_path.split('/').pop() ?? file_path,
        file_path,
        word_count,
      })),
      streak_days: 0,
      today_words: 0,
      today_minutes: 0,
    },
  };
}

describe('[contract] formatRelativeTime', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0, 0);

  it('returns the just-now label under 45 seconds', () => {
    expect(formatRelativeTime(now - 20_000, 'zh-CN', now, '刚刚')).toBe('刚刚');
  });

  it('formats minutes, hours and days in Chinese', () => {
    expect(formatRelativeTime(now - 8 * 60_000, 'zh-CN', now)).toBe('8分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, 'zh-CN', now)).toBe('3小时前');
    expect(formatRelativeTime(now - 2 * 86_400_000, 'zh-CN', now)).toBe('前天');
  });

  it('formats minutes in English', () => {
    expect(formatRelativeTime(now - 8 * 60_000, 'en', now)).toBe('8 minutes ago');
  });

  it('falls back to a calendar date after ~30 days', () => {
    const old = now - 90 * 86_400_000;
    expect(formatRelativeTime(old, 'en', now)).toBe(new Date(old).toLocaleDateString('en'));
  });
});

describe('[contract] fileMetaStore refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getWritingStats.mockReset();
    localStorage.clear();
    fileMetaStore.setShowFileMeta(true);
    fileMetaStore.scheduleRefresh(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces refreshes and maps word counts by path', async () => {
    getWritingStats.mockResolvedValue(stats([['/p/第一章.md', 2233], ['/p/notes/设定.md', 12]]));
    fileMetaStore.scheduleRefresh('/p');
    fileMetaStore.scheduleRefresh('/p');
    fileMetaStore.scheduleRefresh('/p');
    await vi.advanceTimersByTimeAsync(700);
    expect(getWritingStats).toHaveBeenCalledTimes(1);
    expect(getWritingStats).toHaveBeenCalledWith('/p');
    expect(fileMetaStore.wordCounts).toEqual({ '/p/第一章.md': 2233, '/p/notes/设定.md': 12 });
  });

  it('drops a response that lands after a project switch', async () => {
    let resolveA!: (v: ReturnType<typeof stats>) => void;
    getWritingStats.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
    fileMetaStore.scheduleRefresh('/a');
    await vi.advanceTimersByTimeAsync(700);
    fileMetaStore.scheduleRefresh('/b');
    resolveA(stats([['/a/x.md', 99]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(fileMetaStore.wordCounts).toEqual({});
  });

  it('does not walk the project while the meta line is hidden, and persists the toggle', async () => {
    fileMetaStore.setShowFileMeta(false);
    expect(localStorage.getItem('novelist:sidebar:show-file-meta')).toBe('false');
    fileMetaStore.scheduleRefresh('/p');
    await vi.advanceTimersByTimeAsync(700);
    expect(getWritingStats).not.toHaveBeenCalled();
  });

  it('touch() records an in-app save time per path', () => {
    fileMetaStore.touch('/p/第一章.md', 1234);
    expect(fileMetaStore.savedAt['/p/第一章.md']).toBe(1234);
  });

  it('clears counts and save times when the project closes', async () => {
    getWritingStats.mockResolvedValue(stats([['/p/a.md', 5]]));
    fileMetaStore.scheduleRefresh('/p');
    await vi.advanceTimersByTimeAsync(700);
    fileMetaStore.touch('/p/a.md', 1);
    fileMetaStore.scheduleRefresh(null);
    expect(fileMetaStore.wordCounts).toEqual({});
    expect(fileMetaStore.savedAt).toEqual({});
  });
});
