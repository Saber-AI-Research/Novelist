import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    readPublishFormDrafts: vi.fn(),
    writePublishFormDraft: vi.fn(),
  },
}));

import { commands } from '$lib/ipc/commands';
import {
  createPublishFormPersistence,
  type PublishFormDraft,
} from '$lib/services/publish-form-persistence';
import {
  createPublishDialogPersistenceController,
  type PublishDialogFormFields,
} from '$lib/services/publish-dialog-persistence-controller';

interface FakeState {
  title: string;
  tags: string[];
  excerpt: string;
  slug: string;
  status: string;
  destination?: string;
}

function makeHarness(initial: Partial<FakeState> = {}) {
  const state: FakeState = {
    title: '',
    tags: [],
    excerpt: '',
    slug: '',
    status: 'draft',
    destination: undefined,
    ...initial,
  };
  const identity = {
    projectDir: '/proj',
    filePath: '/proj/chapter.md',
    channelId: 'ghost-1',
  };
  const persistence = createPublishFormPersistence(50);
  let corruptCount = 0;
  let restoreDoneCount = 0;
  const controller = createPublishDialogPersistenceController({
    identity,
    persistence,
    readFields(): PublishDialogFormFields {
      return {
        title: state.title,
        tags: [...state.tags],
        excerpt: state.excerpt.trim() === '' ? undefined : state.excerpt,
        slug: state.slug.trim() === '' ? undefined : state.slug,
        status: state.status,
        destination: state.destination,
      };
    },
    applyFields(fields) {
      state.title = fields.title;
      state.tags = [...fields.tags];
      state.excerpt = fields.excerpt ?? '';
      state.slug = fields.slug ?? state.slug;
      state.status = fields.status ?? state.status;
      state.destination = fields.destination ?? state.destination;
    },
    onCorruptDraft() {
      corruptCount += 1;
    },
    onRestoreComplete() {
      restoreDoneCount += 1;
    },
  });
  return {
    state,
    identity,
    controller,
    persistence,
    getCorruptCount: () => corruptCount,
    getRestoreDoneCount: () => restoreDoneCount,
  };
}

const OK = { status: 'ok' as const, data: null };

function setLoadResult(forms: Record<string, Partial<PublishFormDraft>> = {}, extras: {
  invalidChannelIds?: string[];
  readError?: string;
} = {}) {
  if (extras.readError) {
    vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
      status: 'error',
      error: extras.readError,
    });
    return;
  }
  vi.mocked(commands.readPublishFormDrafts).mockResolvedValue({
    status: 'ok',
    data: {
      forms: Object.fromEntries(
        Object.entries(forms).map(([id, form]) => [
          id,
          {
            title: form.title ?? '',
            tags: form.tags ?? [],
            excerpt: form.excerpt,
            slug: form.slug,
            status: form.status,
            destination: form.destination,
          },
        ]),
      ),
      invalid_channel_ids: extras.invalidChannelIds ?? [],
    },
  });
}

describe('publish dialog persistence controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores persisted fields into the dialog state on mount', async () => {
    setLoadResult({
      'ghost-1': {
        title: '第一章',
        tags: ['长篇'],
        excerpt: '摘要',
        slug: 'xu-mu',
        status: 'draft',
        destination: '专栏 A',
      },
    });
    const h = makeHarness({ title: 'default', slug: 'default-slug' });

    await h.controller.loadInitialDraft();

    expect(h.state.title).toBe('第一章');
    expect(h.state.tags).toEqual(['长篇']);
    expect(h.state.excerpt).toBe('摘要');
    expect(h.state.slug).toBe('xu-mu');
    expect(h.state.status).toBe('draft');
    expect(h.state.destination).toBe('专栏 A');
    expect(h.controller.restoreReady).toBe(true);
    expect(h.getRestoreDoneCount()).toBe(1);
  });

  it('close during pending restore flushes user edits made before load resolved', async () => {
    const readDone = { resolve: (() => {}) as () => void };
    vi.mocked(commands.readPublishFormDrafts).mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        readDone.resolve = r;
      });
      return {
        status: 'ok',
        data: {
          forms: { 'ghost-1': { title: 'persisted', tags: [] } },
          invalid_channel_ids: [],
        },
      };
    });
    const h = makeHarness();

    const loadingPromise = h.controller.loadInitialDraft();
    h.state.title = 'user typed before load';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    const closingPromise = h.controller.handleClose();
    await vi.advanceTimersByTimeAsync(100);
    readDone.resolve();
    await loadingPromise;
    await closingPromise;

    expect(h.state.title).toBe('user typed before load');
    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1];
    expect(last[3]).toMatchObject({ title: 'user typed before load' });
  });

  it('a late restore never overwrites a user edit made before the read resolves', async () => {
    const readDone = { resolve: (() => {}) as () => void };
    vi.mocked(commands.readPublishFormDrafts).mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        readDone.resolve = r;
      });
      return {
        status: 'ok',
        data: {
          forms: { 'ghost-1': { title: 'persisted-should-not-apply', tags: ['persisted'] } },
          invalid_channel_ids: [],
        },
      };
    });
    const h = makeHarness({ title: 'default' });

    const loading = h.controller.loadInitialDraft();
    h.state.title = 'user wins';
    h.state.tags = ['user'];
    h.controller.handleUserInput();

    readDone.resolve();
    await loading;

    expect(h.state.title).toBe('user wins');
    expect(h.state.tags).toEqual(['user']);
  });

  it('does NOT overwrite user edits with defaults when restore returns nothing for this channel', async () => {
    setLoadResult({ 'other-channel': { title: 'someone else' } });
    const h = makeHarness({ title: 'user typed' });
    h.controller.handleUserInput();

    await h.controller.loadInitialDraft();

    expect(h.state.title).toBe('user typed');
  });

  it('project switch triggers an awaitable flush of the owning identity', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'switching-context-edit';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleProjectSwitch('/proj-B');
    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls;
    expect(calls.at(-1)).toBeDefined();
    expect(calls.at(-1)?.[3]).toMatchObject({ title: 'switching-context-edit' });
  });

  it('project switch to same project does not force a redundant flush', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    const before = vi.mocked(commands.writePublishFormDraft).mock.calls.length;

    await h.controller.handleProjectSwitch(h.identity.projectDir);
    const after = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(after).toBe(before);
  });

  it('publish success does not reset field state', async () => {
    setLoadResult({ 'ghost-1': { title: 'persisted-x', tags: ['t'] } });
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'edited-then-published';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleBeforePublish();
    await h.controller.handleAfterPublishSuccess();

    expect(h.state.title).toBe('edited-then-published');
    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[3]).toMatchObject({ title: 'edited-then-published' });
  });

  it('close/reopen round-trips restored draft including destination', async () => {
    setLoadResult({
      'ghost-1': {
        title: 't',
        tags: ['x'],
        destination: 'medium-pub-1',
      },
    });
    const first = makeHarness();
    await first.controller.loadInitialDraft();
    expect(first.state.destination).toBe('medium-pub-1');
    first.state.title = 'user renamed';
    first.controller.handleUserInput();
    first.controller.handleFieldChange();
    await first.controller.handleClose();

    const writeArgs = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    setLoadResult({
      'ghost-1': {
        title: writeArgs?.[3].title ?? '',
        tags: writeArgs?.[3].tags ?? [],
        destination: writeArgs?.[3].destination ?? undefined,
      },
    });
    const second = makeHarness();
    await second.controller.loadInitialDraft();
    expect(second.state.title).toBe('user renamed');
    expect(second.state.destination).toBe('medium-pub-1');
  });

  it('rename flush persists the current form under the old identity before rename IPC runs', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'pending-rename';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleRenameFlush(h.identity.filePath);

    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[1]).toBe(h.identity.filePath);
    expect(last?.[3]).toMatchObject({ title: 'pending-rename' });
  });

  it('retires the old identity after a successful relevant rename flush', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'before-rename';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleRenameFlush(h.identity.filePath);
    expect(h.controller.isRetired).toBe(true);
    const writesAfterRename = vi.mocked(commands.writePublishFormDraft).mock.calls.length;

    h.state.title = 'stale-old-identity';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();
    await h.controller.handleDestroy();

    expect(vi.mocked(commands.writePublishFormDraft)).toHaveBeenCalledTimes(writesAfterRename);
  });

  it('marks corrupt draft when the sidecar read errored', async () => {
    setLoadResult({}, { readError: 'invalid JSON at line 1' });
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    expect(h.getCorruptCount()).toBe(1);
  });

  it('marks corrupt draft when this channel is in invalid_channel_ids and does not overwrite fields', async () => {
    setLoadResult({}, { invalidChannelIds: ['ghost-1'] });
    const h = makeHarness({ title: 'kept' });
    await h.controller.loadInitialDraft();
    expect(h.getCorruptCount()).toBe(1);
    expect(h.state.title).toBe('kept');
  });

  it('destroy always flushes even if restore never completed', async () => {
    vi.mocked(commands.readPublishFormDrafts).mockImplementation(() => new Promise(() => {}));
    const h = makeHarness();
    void h.controller.loadInitialDraft();
    h.state.title = 'unflushed-on-destroy';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleDestroy();
    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[3]).toMatchObject({ title: 'unflushed-on-destroy' });
  });

  it('a tag Backspace before restore is marked as user input and cannot be overwritten by a late restore', async () => {
    const readDone = { resolve: (() => {}) as () => void };
    vi.mocked(commands.readPublishFormDrafts).mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        readDone.resolve = r;
      });
      return {
        status: 'ok',
        data: {
          forms: {
            'ghost-1': {
              title: 'persisted-not-applied',
              tags: ['persisted-tag'],
            },
          },
          invalid_channel_ids: [],
        },
      };
    });
    const h = makeHarness({ tags: ['persisted-tag'] });

    const loading = h.controller.loadInitialDraft();
    h.state.tags = [];
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    readDone.resolve();
    await loading;

    expect(h.state.tags).toEqual([]);
    await h.controller.handleClose();
    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[3]).toMatchObject({ tags: [] });
  });

  it('close returns a rejection when persistence throws so callers can surface it', async () => {
    setLoadResult();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValue({
      status: 'error',
      error: 'disk full during close',
    } as never);
    const h = makeHarness({ title: 'about-to-fail' });
    await h.controller.loadInitialDraft();
    h.state.title = 'about-to-fail-edited';
    h.controller.handleUserInput();

    await expect(h.controller.handleClose()).rejects.toThrow(/disk full during close/);
  });

  it('a background failure followed by a successful close retry closes normally on the first retry', async () => {
    setLoadResult();
    vi.mocked(commands.writePublishFormDraft)
      .mockResolvedValueOnce({ status: 'error', error: 'transient-failure' } as never)
      .mockResolvedValue(OK);
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'v1-will-fail-in-background';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    h.state.title = 'v2-flushed-on-close';
    h.controller.handleFieldChange();

    await expect(h.controller.handleClose()).resolves.toBeUndefined();
    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[3]).toMatchObject({ title: 'v2-flushed-on-close' });
  });

  it('project switch away from the owning identity (A -> null) flushes A before retiring', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'A-content-to-flush';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    expect(h.controller.isRetired).toBe(false);
    await h.controller.handleProjectSwitch(null);

    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[0]).toBe(h.identity.projectDir);
    expect(last?.[3]).toMatchObject({ title: 'A-content-to-flush' });
    expect(h.controller.isRetired).toBe(true);
  });

  it('after successful close, handleDestroy does not enqueue a duplicate old-project write', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'about-to-close';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleClose();
    const callsAfterClose = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(h.controller.isRetired).toBe(true);

    await h.controller.handleDestroy();
    const callsAfterDestroy = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(callsAfterDestroy).toBe(callsAfterClose);
  });

  it('after successful project switch, subsequent field mutations do not queue writes to the old identity', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'v-before-switch';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();

    await h.controller.handleProjectSwitch('/proj-B');
    const callsAtSwitch = vi.mocked(commands.writePublishFormDraft).mock.calls.length;

    h.state.title = 'v-after-switch-should-not-persist';
    h.controller.handleFieldChange();
    await vi.advanceTimersByTimeAsync(1000);

    const callsAfterMutations = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(callsAfterMutations).toBe(callsAtSwitch);
  });

  it('failed close keeps the controller active for retry (not retired)', async () => {
    setLoadResult();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValueOnce({
      status: 'error',
      error: 'disk full',
    } as never);
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'retry-me';
    h.controller.handleUserInput();

    await expect(h.controller.handleClose()).rejects.toThrow(/disk full/);
    expect(h.controller.isRetired).toBe(false);

    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
    await expect(h.controller.handleClose()).resolves.toBeUndefined();
    expect(h.controller.isRetired).toBe(true);
  });

  it('failed project-switch keeps the controller active for retry', async () => {
    setLoadResult();
    vi.mocked(commands.writePublishFormDraft).mockResolvedValueOnce({
      status: 'error',
      error: 'disk full',
    } as never);
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'switch-should-fail';
    h.controller.handleUserInput();

    await expect(h.controller.handleProjectSwitch(null)).rejects.toThrow(/disk full/);
    expect(h.controller.isRetired).toBe(false);

    vi.mocked(commands.writePublishFormDraft).mockResolvedValue(OK);
    h.state.title = 'still-writable-after-failed-retire';
    h.controller.handleFieldChange();
    await h.controller.handleProjectSwitch(null);
    const last = vi.mocked(commands.writePublishFormDraft).mock.calls.at(-1);
    expect(last?.[3]).toMatchObject({ title: 'still-writable-after-failed-retire' });
    expect(h.controller.isRetired).toBe(true);
  });

  it('handleClose after retirement is a no-op with no additional IPC', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'one-write';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();
    await h.controller.handleClose();
    const calls = vi.mocked(commands.writePublishFormDraft).mock.calls.length;

    await expect(h.controller.handleClose()).resolves.toBeUndefined();
    expect(vi.mocked(commands.writePublishFormDraft).mock.calls.length).toBe(calls);
  });

  it('project-switch to the same project stays open and active', async () => {
    setLoadResult();
    const h = makeHarness();
    await h.controller.loadInitialDraft();
    h.state.title = 'kept';
    h.controller.handleUserInput();
    h.controller.handleFieldChange();
    const before = vi.mocked(commands.writePublishFormDraft).mock.calls.length;

    await h.controller.handleProjectSwitch(h.identity.projectDir);
    expect(h.controller.isRetired).toBe(false);
    const after = vi.mocked(commands.writePublishFormDraft).mock.calls.length;
    expect(after).toBe(before);
  });
});
