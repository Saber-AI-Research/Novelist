import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    readPublishFormDrafts: vi.fn(),
    writePublishFormDraft: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';
import {
  __resetPublishFormPersistenceForTests,
  createPublishFormPersistence,
  publishFormPersistence,
  type PublishFormDraft,
} from '$lib/services/publish-form-persistence';

const OK = { status: 'ok' as const, data: null };

function draft(overrides: Partial<PublishFormDraft> = {}): PublishFormDraft {
  return {
    title: 't',
    tags: [],
    excerpt: undefined,
    slug: undefined,
    status: undefined,
    destination: undefined,
    ...overrides,
  };
}

describe('publish form persistence — load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPublishFormPersistenceForTests();
  });

  it('returns empty snapshot when the sidecar is missing', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'ok',
      data: { forms: {}, invalid_channel_ids: [] },
    });

    const loaded = await publishFormPersistence.loadDrafts('/project', '/project/ch1.md');

    expect(loaded.readError).toBeNull();
    expect(loaded.invalidChannelIds).toEqual([]);
    expect(loaded.forms.size).toBe(0);
  });

  it('restores per-channel forms exactly, preserving CJK values and destination', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'ok',
      data: {
        forms: {
          'ghost-1': {
            title: '第一章',
            tags: ['长篇', '开篇'],
            excerpt: '摘要',
            slug: 'xu-mu',
            status: 'draft',
            destination: '专栏 A',
          },
          'wp-2': {
            title: 'First',
            tags: ['fiction'],
          },
        },
        invalid_channel_ids: [],
      },
    });

    const loaded = await publishFormPersistence.loadDrafts('/project', '/project/ch1.md');

    expect(loaded.forms.get('ghost-1')).toEqual({
      title: '第一章',
      tags: ['长篇', '开篇'],
      excerpt: '摘要',
      slug: 'xu-mu',
      status: 'draft',
      destination: '专栏 A',
    });
    const wp = loaded.forms.get('wp-2');
    expect(wp?.title).toBe('First');
    expect(wp?.tags).toEqual(['fiction']);
    expect(loaded.invalidChannelIds).toEqual([]);
  });

  it('distinguishes a legacy omitted slug from an explicitly empty slug', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'ok',
      data: {
        forms: {
          legacy: { title: '旧草稿', tags: [] },
          cleared: { title: '已清空', tags: [], slug: '' },
        },
        invalid_channel_ids: [],
      },
    });

    const loaded = await publishFormPersistence.loadDrafts('/project', '/project/ch1.md');

    expect(loaded.forms.get('legacy')?.slug).toBeUndefined();
    expect(loaded.forms.get('cleared')?.slug).toBe('');
  });

  it('surfaces invalid channel ids without hiding sibling drafts', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'ok',
      data: {
        forms: { 'ghost-1': { title: 'good', tags: [] } },
        invalid_channel_ids: ['wp-2'],
      },
    });

    const loaded = await publishFormPersistence.loadDrafts('/project', '/project/ch1.md');

    expect(loaded.forms.has('ghost-1')).toBe(true);
    expect(loaded.forms.has('wp-2')).toBe(false);
    expect(loaded.invalidChannelIds).toEqual(['wp-2']);
    expect(loaded.readError).toBeNull();
  });

  it('surfaces a recoverable readError when the sidecar is corrupt', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'error',
      error: 'invalid JSON at line 1',
    });

    const loaded = await publishFormPersistence.loadDrafts('/project', '/project/ch1.md');

    expect(loaded.forms.size).toBe(0);
    expect(loaded.invalidChannelIds).toEqual([]);
    expect(loaded.readError).toContain('invalid JSON');
  });
});

describe('publish form persistence — debounce, flush, and rename', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __resetPublishFormPersistenceForTests();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces frequent field edits into one IPC write per identity', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };

    publishFormPersistence.queueWrite(id, draft({ title: 'v1' }));
    publishFormPersistence.queueWrite(id, draft({ title: 'v2' }));
    publishFormPersistence.queueWrite(id, draft({ title: 'v3' }));
    expect(commands.writePublishFormDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(1);
    expect(commands.writePublishFormDraft).toHaveBeenLastCalledWith(
      '/p',
      '/p/a.md',
      'ghost-1',
      expect.objectContaining({ title: 'v3' }),
    );
  });

  it('writes an explicit empty slug while omitting an uninitialized slug for another document', async () => {
    publishFormPersistence.queueWrite(
      { projectDir: '/p', filePath: '/p/第一章.md', channelId: 'ghost-1' },
      draft({ title: '第一章', slug: '' }),
    );
    publishFormPersistence.queueWrite(
      { projectDir: '/p', filePath: '/p/第二章.md', channelId: 'ghost-1' },
      draft({ title: '第二章', slug: undefined }),
    );

    await publishFormPersistence.flushAll();

    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    const firstChapter = calls.find((call) => call[1] === '/p/第一章.md');
    const secondChapter = calls.find((call) => call[1] === '/p/第二章.md');
    expect(firstChapter?.[3]).toHaveProperty('slug', '');
    expect(secondChapter?.[3]).not.toHaveProperty('slug');
  });

  it('idempotent flush drains pending writes without duplicating', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    publishFormPersistence.queueWrite(id, draft({ title: 'to flush' }));

    await publishFormPersistence.flush(id);
    await publishFormPersistence.flush(id);
    await vi.advanceTimersByTimeAsync(1000);

    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(1);
    expect(commands.writePublishFormDraft).toHaveBeenCalledWith(
      '/p',
      '/p/a.md',
      'ghost-1',
      expect.objectContaining({ title: 'to flush' }),
    );
  });

  it('flush is a no-op when there are no pending writes', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    await publishFormPersistence.flush(id);
    expect(commands.writePublishFormDraft).not.toHaveBeenCalled();
  });

  it('does NOT strip or serialize credentials, cover blobs, errors, success URLs, or flags', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    publishFormPersistence.queueWrite(id, draft({ title: 't', tags: ['ok'] }));
    await publishFormPersistence.flush(id);

    const [, , , wire] = vi.mocked(commands.writePublishFormDraft).mock.calls[0];
    const serialized = JSON.stringify(wire);
    for (const banned of [
      'token',
      'password',
      'api_key',
      'apiKey',
      'access_token',
      'secret',
      'credential',
      'error',
      'in_flight',
      'inFlight',
      'success_url',
      'successUrl',
      'object_url',
      'objectUrl',
      'blob:',
      'data:image',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it('flushForRename flushes writes for the renamed file and every descendant of a renamed folder', async () => {
    const idA = { projectDir: '/p', filePath: '/p/old.md', channelId: 'ghost-1' };
    const idAOther = { projectDir: '/p', filePath: '/p/old.md', channelId: 'wp-2' };
    const idOtherDoc = { projectDir: '/p', filePath: '/p/other.md', channelId: 'ghost-1' };
    const idOtherProject = { projectDir: '/q', filePath: '/p/old.md', channelId: 'ghost-1' };

    publishFormPersistence.queueWrite(idA, draft({ title: 'a' }));
    publishFormPersistence.queueWrite(idAOther, draft({ title: 'a-other' }));
    publishFormPersistence.queueWrite(idOtherDoc, draft({ title: 'other' }));
    publishFormPersistence.queueWrite(idOtherProject, draft({ title: 'other-project' }));

    await publishFormPersistence.flushForRename('/p', '/p/old.md');

    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    const flushedIdentities = calls
      .map((c) => `${c[0]}::${c[1]}::${c[2]}`)
      .sort();
    expect(flushedIdentities).toEqual([
      '/p::/p/old.md::ghost-1',
      '/p::/p/old.md::wp-2',
    ]);

    const folderIdNested = { projectDir: '/p', filePath: '/p/chapters/one.md', channelId: 'ghost-1' };
    const folderIdSibling = { projectDir: '/p', filePath: '/p/chapters-2/one.md', channelId: 'ghost-1' };
    publishFormPersistence.queueWrite(folderIdNested, draft({ title: 'nested' }));
    publishFormPersistence.queueWrite(folderIdSibling, draft({ title: 'sibling' }));

    await publishFormPersistence.flushForRename('/p', '/p/chapters');

    const finalCalls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    const flushedForFolder = finalCalls
      .slice(2)
      .map((c) => c[1])
      .sort();
    expect(flushedForFolder).toEqual(['/p/chapters/one.md']);

    await vi.advanceTimersByTimeAsync(1000);
    const totalCalls = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(5);
  });

  it('later queueWrite supersedes the earlier snapshot for the same identity', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };

    publishFormPersistence.queueWrite(id, draft({ title: 'first' }));
    await vi.advanceTimersByTimeAsync(200);
    publishFormPersistence.queueWrite(id, draft({ title: 'second' }));
    await vi.advanceTimersByTimeAsync(500);

    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(1);
    expect(commands.writePublishFormDraft).toHaveBeenLastCalledWith(
      '/p',
      '/p/a.md',
      'ghost-1',
      expect.objectContaining({ title: 'second' }),
    );
  });

  it('cancel drops a pending debounce without persisting', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    publishFormPersistence.queueWrite(id, draft({ title: 'nope' }));
    publishFormPersistence.cancel(id);

    await vi.advanceTimersByTimeAsync(1000);
    expect(commands.writePublishFormDraft).not.toHaveBeenCalled();
  });

  it('flushAll drains every pending identity', async () => {
    publishFormPersistence.queueWrite(
      { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' },
      draft({ title: 'a-ghost' }),
    );
    publishFormPersistence.queueWrite(
      { projectDir: '/p', filePath: '/p/b.md', channelId: 'wp-2' },
      draft({ title: 'b-wp' }),
    );
    publishFormPersistence.queueWrite(
      { projectDir: '/q', filePath: '/q/c.md', channelId: 'ghost-1' },
      draft({ title: 'q-ghost' }),
    );

    await publishFormPersistence.flushAll();

    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(3);
  });

  it('later queueWrite lands strictly after an in-flight older write even if the older resolves late', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };

    const firstDone = { resolve: (() => {}) as () => void };
    let firstCallStarted = false;
    vi.mocked(commands.writePublishFormDraft).mockImplementationOnce(async () => {
      firstCallStarted = true;
      await new Promise<void>((r) => {
        firstDone.resolve = r;
      });
      return OK;
    });

    publishFormPersistence.queueWrite(id, draft({ title: 'first' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(firstCallStarted).toBe(true);
    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(1);

    publishFormPersistence.queueWrite(id, draft({ title: 'second' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(commands.writePublishFormDraft).toHaveBeenCalledTimes(1);

    firstDone.resolve();
    await publishFormPersistence.flush(id);

    const titles = vi
      .mocked(commands.writePublishFormDraft)
      .mock.calls.map((c) => (c[3] as PublishFormDraft).title);
    expect(titles).toEqual(['first', 'second']);
  });

  it('a fire-and-forget IPC failure is preserved and surfaced by the next awaited flush', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    vi.mocked(commands.writePublishFormDraft).mockResolvedValueOnce({
      status: 'error',
      error: 'disk full',
    } as never);

    publishFormPersistence.queueWrite(id, draft({ title: 'lost?' }));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    await expect(publishFormPersistence.flush(id)).rejects.toThrow(/disk full/);
    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
    await publishFormPersistence.flush(id);
  });

  it('a later successful write clears a stale deferred error so close does not throw', async () => {
    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };

    vi.mocked(commands.writePublishFormDraft).mockResolvedValueOnce({
      status: 'error',
      error: 'transient disk full',
    } as never);

    publishFormPersistence.queueWrite(id, draft({ title: 'v1' }));
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
    publishFormPersistence.queueWrite(id, draft({ title: 'v2-retry-durable' }));

    await expect(publishFormPersistence.flush(id)).resolves.toBeUndefined();
    await expect(publishFormPersistence.flush(id)).resolves.toBeUndefined();

    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    expect(calls.at(-1)?.[3]).toMatchObject({ title: 'v2-retry-durable' });
  });
});

describe('publish form persistence — instance isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('createPublishFormPersistence returns an independent instance', async () => {
    const p1 = createPublishFormPersistence();
    const p2 = createPublishFormPersistence();

    const id = { projectDir: '/p', filePath: '/p/a.md', channelId: 'ghost-1' };
    p1.queueWrite(id, draft({ title: 'from p1' }));
    p2.queueWrite(id, draft({ title: 'from p2' }));

    await p1.flush(id);
    expect(vi.mocked(commands.writePublishFormDraft).mock.calls.length).toBe(1);
    expect(
      (vi.mocked(commands.writePublishFormDraft).mock.calls[0][3] as PublishFormDraft).title,
    ).toBe('from p1');

    await p2.flush(id);
    expect(vi.mocked(commands.writePublishFormDraft).mock.calls.length).toBe(2);
    expect(
      (vi.mocked(commands.writePublishFormDraft).mock.calls[1][3] as PublishFormDraft).title,
    ).toBe('from p2');
  });
});
