import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    renameItem: vi.fn(),
    broadcastFileRenamed: vi.fn(),
    registerWriteIgnore: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    registerOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    writeFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    unregisterOpenFile: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
  },
}));

vi.mock('$lib/stores/new-file-settings.svelte', () => ({
  newFileSettings: { template: '第{N}章', autoRenameFromH1: true },
}));

vi.mock('$lib/i18n', () => ({ t: (k: string) => k }));

import { commands } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import { tabsStore } from '$lib/stores/tabs.svelte';
import { PluginDocumentSessions } from '$lib/services/plugin-document-sessions';

/**
 * [regression] Split panes showing the same plugin document used to hold
 * independent snapshots, and reload-rotated tokens stayed writable. These
 * cover the host-side document sessions shared by every PluginFileEditor.
 */

const PROJECT = '/proj';
const FILE = `${PROJECT}/翻译内容/0001.novtrans`;

function chapter(first: string, second: string): string {
  return JSON.stringify({
    segments: [
      { id: 'segment-0001', translation: first },
      { id: 'segment-0002', translation: second },
    ],
  });
}

function fileTabs() {
  return tabsStore.findAllByPath(FILE).map((tab) => ({ content: tab.content, dirty: tab.isDirty }));
}

function writtenContents(): string[] {
  return vi.mocked(commands.writeFile).mock.calls.map(([, content]) => content);
}

function openSplit(content = chapter('', '')) {
  tabsStore.toggleSplit();
  tabsStore.openTabInPane('pane-1', FILE, content);
  tabsStore.openTabInPane('pane-2', FILE, content);
  const [left, right] = tabsStore.findAllByPath(FILE);
  return { left, right };
}

let sessions: PluginDocumentSessions;

beforeEach(() => {
  localStorage.clear();
  tabsStore.closeAll();
  vi.clearAllMocks();
  vi.mocked(commands.registerWriteIgnore).mockResolvedValue({ status: 'ok', data: null });
  vi.mocked(commands.writeFile).mockResolvedValue({ status: 'ok', data: null });
  vi.mocked(commands.unregisterOpenFile).mockResolvedValue({ status: 'ok', data: null });
  projectStore.dirPath = PROJECT;
  sessions = new PluginDocumentSessions();
});

afterEach(() => {
  projectStore.dirPath = null;
});

describe('[regression] plugin document sessions across split panes', () => {
  it('keeps both panes’ sequential segment edits and their saved state', async () => {
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    const rightOpen = sessions.open('right', right.id)!;

    expect(sessions.applyState('left', leftOpen.token, 0, chapter('左侧译文', '')))
      .toEqual({ accepted: true, conflict: null });
    // The inactive-for-editing right tab no longer holds the old snapshot.
    expect(fileTabs()).toEqual([
      { content: chapter('左侧译文', ''), dirty: true },
      { content: chapter('左侧译文', ''), dirty: true },
    ]);
    await expect(sessions.save('left', leftOpen.token, 0, chapter('左侧译文', '')))
      .resolves.toMatchObject({ ok: true, saved: true, filePath: FILE });
    expect(fileTabs().every((tab) => !tab.dirty)).toBe(true);

    expect(sessions.target('right', rightOpen.token)).toBeNull();
    const rightReopen = sessions.open('right', right.id)!;
    expect(rightReopen.token).not.toBe(rightOpen.token);
    expect(rightReopen.content).toBe(chapter('左侧译文', ''));
    expect(sessions.open('right', right.id)).toBeNull();

    expect(sessions.applyState('right', rightReopen.token, 0, chapter('左侧译文', '右侧译文')).accepted)
      .toBe(true);
    await expect(sessions.save('right', rightReopen.token, 0, chapter('左侧译文', '右侧译文')))
      .resolves.toMatchObject({ ok: true, saved: true });

    expect(writtenContents()).toEqual([chapter('左侧译文', ''), chapter('左侧译文', '右侧译文')]);
    expect(fileTabs()).toEqual([
      { content: chapter('左侧译文', '右侧译文'), dirty: false },
      { content: chapter('左侧译文', '右侧译文'), dirty: false },
    ]);
    expect(sessions.target('left', leftOpen.token)).toBeNull();
  });

  it('does not mark saved a write the other pane superseded while it ran', async () => {
    const pendingWrite = Promise.withResolvers<{ status: 'ok'; data: null } | { status: 'error'; error: string }>();
    vi.mocked(commands.writeFile).mockImplementationOnce(() => pendingWrite.promise);
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    sessions.applyState('left', leftOpen.token, 0, chapter('左', ''));
    const leftSave = sessions.save('left', leftOpen.token, 0, chapter('左', ''));
    await vi.waitFor(() => expect(commands.writeFile).toHaveBeenCalledTimes(1));

    const rightOpen = sessions.open('right', right.id)!;
    expect(rightOpen.content).toBe(chapter('左', ''));
    sessions.applyState('right', rightOpen.token, 0, chapter('左', '右'));
    const rightSave = sessions.save('right', rightOpen.token, 0, chapter('左', '右'));
    expect(commands.writeFile).toHaveBeenCalledTimes(1);

    pendingWrite.resolve({ status: 'ok', data: null });
    await expect(leftSave).resolves.toMatchObject({ ok: true, saved: false });
    await expect(rightSave).resolves.toMatchObject({ ok: true, saved: true });
    expect(writtenContents()).toEqual([chapter('左', ''), chapter('左', '右')]);
    expect(fileTabs().every((tab) => !tab.dirty && tab.content === chapter('左', '右'))).toBe(true);
  });

  it('rejects a racing stale edit as a conflict that only an explicit restore applies', async () => {
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    const rightOpen = sessions.open('right', right.id)!;
    sessions.applyState('left', leftOpen.token, 0, chapter('左', ''));

    const raced = sessions.applyState('right', rightOpen.token, 0, chapter('', '右'));
    expect(raced).toEqual({
      accepted: false,
      conflict: { tabId: right.id, filePath: FILE, projectPath: PROJECT, content: chapter('', '右') },
    });
    await expect(sessions.save('right', rightOpen.token, 0, chapter('', '右')))
      .resolves.toMatchObject({ ok: false, saved: false });
    expect(commands.writeFile).not.toHaveBeenCalled();
    expect(fileTabs().map((tab) => tab.content)).toEqual([chapter('左', ''), chapter('左', '')]);
    // A stale snapshot without local edits (e.g. a flushed save) is no conflict.
    expect(sessions.applyState('right', rightOpen.token, 0, chapter('', '')).conflict).toBeNull();

    await expect(sessions.restore(raced.conflict!)).resolves.toMatchObject({ ok: true, saved: true });
    expect(writtenContents()).toEqual([chapter('', '右')]);
    expect(fileTabs()).toEqual([
      { content: chapter('', '右'), dirty: false },
      { content: chapter('', '右'), dirty: false },
    ]);
    expect(sessions.target('left', leftOpen.token)).toBeNull();
  });

  it('gives a disk-opened sibling the unsaved content and revokes inactive snapshots', () => {
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-1', FILE, chapter('', ''));
    const left = tabsStore.findByPath(FILE)!;
    const leftOpen = sessions.open('left', left.id)!;
    sessions.applyState('left', leftOpen.token, 0, chapter('未保存', ''));

    tabsStore.openTabInPane('pane-2', FILE, chapter('', ''));
    const right = tabsStore.findAllByPath(FILE)[1];
    const rightOpen = sessions.open('right', right.id)!;
    expect(rightOpen.content).toBe(chapter('未保存', ''));
    expect(fileTabs()[1]).toEqual({ content: chapter('未保存', ''), dirty: true });

    // Right switches to another tab; its same-file tab is now inactive.
    tabsStore.openTabInPane('pane-2', `${PROJECT}/notes.novtrans`, chapter('', ''));
    const other = tabsStore.findByPath(`${PROJECT}/notes.novtrans`)!;
    expect(sessions.open('right', other.id)).not.toBeNull();
    sessions.applyState('left', leftOpen.token, 0, chapter('未保存', '更新'));

    expect(fileTabs()[1].content).toBe(chapter('未保存', '更新'));
    expect(sessions.target('right', rightOpen.token)).toBeNull();
    const back = sessions.open('right', right.id)!;
    expect(back.token).not.toBe(rightOpen.token);
    expect(back.content).toBe(chapter('未保存', '更新'));
  });

  it('[regression] marks a sibling-pane edit of the shown tab as an in-place sync', () => {
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    const rightOpen = sessions.open('right', right.id)!;
    expect(leftOpen.sync).toBe(false);
    expect(rightOpen.sync).toBe(false);

    sessions.applyState('left', leftOpen.token, 1, chapter('左', ''));
    const synced = sessions.open('right', right.id)!;
    // New token and content, but the right iframe must not reset its editor.
    expect(synced).toMatchObject({ sync: true, content: chapter('左', ''), revision: 0 });
    expect(synced.token).not.toBe(rightOpen.token);
    expect(sessions.target('right', synced.token)).toEqual({ tabId: right.id, filePath: FILE, projectPath: PROJECT });
    // The editing pane keeps its own live snapshot: nothing to resend.
    expect(sessions.open('left', left.id)).toBeNull();

    // A reload from disk is a new document, not a sync.
    tabsStore.reloadContent(right.id, chapter('磁盘', ''));
    expect(sessions.open('right', right.id)!.sync).toBe(false);

    // So is showing a different tab, and coming back to this one.
    tabsStore.openTabInPane('pane-2', `${PROJECT}/notes.novtrans`, chapter('', ''));
    const other = tabsStore.findByPath(`${PROJECT}/notes.novtrans`)!;
    expect(sessions.open('right', other.id)!.sync).toBe(false);
    tabsStore.activateTab(right.id);
    expect(sessions.open('right', right.id)!.sync).toBe(false);
  });

  it('follows in-place syncs when delivering late results to the shown document', () => {
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    const rightOpen = sessions.open('right', right.id)!;
    const requestTarget = sessions.target('right', rightOpen.token)!;
    expect(sessions.displayedToken('right', requestTarget)).toBe(rightOpen.token);

    sessions.applyState('left', leftOpen.token, 1, chapter('左', ''));
    const synced = sessions.open('right', right.id)!;
    expect(sessions.displayedToken('right', requestTarget)).toBe(synced.token);

    tabsStore.openTabInPane('pane-2', `${PROJECT}/notes.novtrans`, chapter('', ''));
    sessions.open('right', tabsStore.findByPath(`${PROJECT}/notes.novtrans`)!.id);
    expect(sessions.displayedToken('right', requestTarget)).toBeNull();
    expect(sessions.displayedToken('left', requestTarget)).toBeNull();
  });
});

describe('[regression] plugin document write queue', () => {
  it('skips a queued save whose snapshot was superseded before it ran', async () => {
    const pendingWrite = Promise.withResolvers<{ status: 'ok'; data: null }>();
    vi.mocked(commands.writeFile).mockImplementationOnce(() => pendingWrite.promise);
    tabsStore.openTab(FILE, chapter('', ''));
    const tabId = tabsStore.findByPath(FILE)!.id;
    const opened = sessions.open('pane', tabId)!;

    const first = sessions.save('pane', opened.token, 1, chapter('一', ''));
    await vi.waitFor(() => expect(commands.writeFile).toHaveBeenCalledTimes(1));
    const queued = sessions.save('pane', opened.token, 2, chapter('一二', ''));
    expect(sessions.applyState('pane', opened.token, 3, chapter('一二三', '')).accepted).toBe(true);

    pendingWrite.resolve({ status: 'ok', data: null });
    await expect(first).resolves.toMatchObject({ ok: true, saved: false });
    await expect(queued).resolves.toMatchObject({ ok: true, saved: false });
    // The queued snapshot never reached the disk; only the in-flight one did.
    expect(writtenContents()).toEqual([chapter('一', '')]);
    expect(tabsStore.findByPath(FILE)).toMatchObject({ content: chapter('一二三', ''), isDirty: true });
  });
});

describe('[regression] plugin document session validation', () => {
  it('invalidates tokens rotated by a reload so old messages cannot restore old content', async () => {
    tabsStore.openTab(FILE, 'OLD');
    const tabId = tabsStore.findByPath(FILE)!.id;
    const first = sessions.open('pane', tabId)!;

    tabsStore.reloadContent(tabId, 'NEW DISK CONTENT');
    expect(sessions.applyState('pane', first.token, 0, 'OLD')).toEqual({ accepted: false, conflict: null });
    await expect(sessions.save('pane', first.token, 0, 'OLD'))
      .resolves.toMatchObject({ ok: false, saved: false });
    expect(tabsStore.findByPath(FILE)).toMatchObject({ content: 'NEW DISK CONTENT', isDirty: false });
    expect(commands.writeFile).not.toHaveBeenCalled();

    const second = sessions.open('pane', tabId)!;
    expect(second.token).not.toBe(first.token);
    expect(second.content).toBe('NEW DISK CONTENT');
    expect(sessions.target('pane', first.token)).toBeNull();
  });

  it('requires the current token and revision of the same iframe for every mutation', async () => {
    tabsStore.openTab(FILE, 'content');
    const tabId = tabsStore.findByPath(FILE)!.id;
    const opened = sessions.open('a', tabId)!;

    expect(sessions.applyState('a', undefined, 0, 'x').accepted).toBe(false);
    expect(sessions.applyState('a', opened.token, undefined, 'x').accepted).toBe(false);
    expect(sessions.applyState('b', opened.token, 0, 'x').accepted).toBe(false);
    expect(sessions.markDirty('a', undefined)).toBe(false);
    expect(sessions.target('a', undefined)).toBeNull();
    expect(sessions.target('b', opened.token)).toBeNull();
    await expect(sessions.save('a', undefined, 0, 'x')).resolves.toMatchObject({ ok: false, saved: false });
    expect(tabsStore.findByPath(FILE)).toMatchObject({ content: 'content', isDirty: false });
    expect(commands.writeFile).not.toHaveBeenCalled();

    expect(sessions.applyState('a', opened.token, 0, 'x').accepted).toBe(true);
    sessions.release('a');
    expect(sessions.target('a', opened.token)).toBeNull();
  });

  it('binds sessions and conflict restores to an open tab of the same project', async () => {
    const { left, right } = openSplit();
    const leftOpen = sessions.open('left', left.id)!;
    const rightOpen = sessions.open('right', right.id)!;
    sessions.applyState('left', leftOpen.token, 0, chapter('左', ''));
    const { conflict } = sessions.applyState('right', rightOpen.token, 0, chapter('', '右'));
    expect(conflict).not.toBeNull();

    projectStore.dirPath = '/other-project';
    expect(sessions.target('left', leftOpen.token)).toBeNull();
    await expect(sessions.restore(conflict!)).resolves.toMatchObject({ ok: false, saved: false });
    expect(commands.writeFile).not.toHaveBeenCalled();
    expect(fileTabs().map((tab) => tab.content)).toEqual([chapter('左', ''), chapter('左', '')]);

    projectStore.dirPath = PROJECT;
    const reopened = sessions.open('left', left.id)!;
    expect(reopened.token).not.toBe(leftOpen.token);
    const leftId = left.id;
    tabsStore.markSaved(leftId);
    await tabsStore.closeTab(leftId);
    expect(sessions.target('left', reopened.token)).toBeNull();
  });
});
