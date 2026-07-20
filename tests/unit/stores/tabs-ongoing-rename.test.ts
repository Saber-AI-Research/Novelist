import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Path B coverage for `tabsStore.tryRenameAfterSave` — ongoing H1→filename
 * sync after a file has left the placeholder state. See spec
 * `docs/superpowers/specs/2026-05-12-h1-filename-ongoing-sync-design.md`.
 *
 * Path A (placeholder first-time rename) is covered by `tabs-auto-rename.test.ts`.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
    renameItem: vi.fn(),
    broadcastFileRenamed: vi.fn(),
    registerOpenFile: vi.fn(),
    unregisterOpenFile: vi.fn(),
    readManagedNameState: vi.fn(),
    writeManagedNameState: vi.fn(),
    computeDocumentKey: vi.fn(),
  },
}));

// `autoRenameFromH1: false` is deliberate: the rename gate is the `{title}`
// placeholder in the template, NOT the legacy checkbox (which has no UI since
// 1e0ab6e). A regression back to the checkbox gate makes every test here fail.
vi.mock('$lib/stores/new-file-settings.svelte', () => ({
  newFileSettings: { template: '第{N}章-{title}', autoRenameFromH1: false },
}));

vi.mock('$lib/i18n', () => ({
  t: (k: string) => k,
}));

import { tabsStore } from '$lib/stores/tabs.svelte';
import { projectStore } from '$lib/stores/project.svelte';
import { commands } from '$lib/ipc/commands';
import { clearManagedNameCache } from '$lib/services/managed-name-persistence';

const PROJECT = '/proj';

describe('tabsStore.tryRenameAfterSave — Path B (ongoing H1 sync)', () => {
  beforeEach(() => {
    localStorage.clear();
    clearManagedNameCache();
    tabsStore.closeAll();
    projectStore.dirPath = PROJECT;
    vi.clearAllMocks();
    (commands.listDirectory as any).mockResolvedValue({ status: 'ok', data: [] });
    (commands.renameItem as any).mockImplementation((_project: string, _old: string, name: string) =>
      Promise.resolve({ status: 'ok', data: { new_path: `${PROJECT}/${name}`, migration: { status: 'full_success', migrated: 0, conflicts: 0, errors: [] } } }),
    );
    (commands.broadcastFileRenamed as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.registerOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.unregisterOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.computeDocumentKey as any).mockImplementation((_project: string, path: string) => Promise.resolve({ status: 'ok', data: path.slice(PROJECT.length + 1) }));
    (commands.writeManagedNameState as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.readManagedNameState as any).mockImplementation((_project: string, path: string) => Promise.resolve({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '第{N}章-{title}',
        currentH1: path.includes('终结') ? '终结' : '开篇',
        documentKey: path.slice(PROJECT.length + 1),
      },
    }));
  });

  it('renames when H1 changes on a non-placeholder file whose name still contains the old H1', async () => {
    // File was already renamed once via Path A: name reflects H1 "开篇".
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 序幕\n\nbody',
    );

    expect(newPath).toBe(`${PROJECT}/第1章-序幕.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      PROJECT,
      `${PROJECT}/第1章-开篇.md`,
      '第1章-序幕.md',
      true,
    );
  });

  it('updates lastSyncedH1 after a successful Path B rename so the next change has the right anchor', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');

    await tabsStore.tryRenameAfterSave(`${PROJECT}/第1章-开篇.md`, '# 序幕');
    (commands.renameItem as any).mockClear();

    // Second change "序幕" → "终章" should chain off the just-renamed file.
    const finalPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-序幕.md`,
      '# 终章',
    );
    expect(finalPath).toBe(`${PROJECT}/第1章-终章.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      PROJECT,
      `${PROJECT}/第1章-序幕.md`,
      '第1章-终章.md',
      true,
    );
  });

  it('falls back to the sanitized H1 basename when manual rename removed the old anchor', async () => {
    // Open a file whose name does NOT contain the H1 — simulates a manual rename
    // performed earlier (or a file opened from disk with mismatched H1).
    tabsStore.openTab(`${PROJECT}/chapter1.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/chapter1.md`,
      '# 序幕',
    );

    expect(newPath).toBe(`${PROJECT}/序幕.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(PROJECT, `${PROJECT}/chapter1.md`, '序幕.md', true);
  });

  it('keeps the filename when the H1 is emptied (does not revert to Untitled)', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      'just body, no heading anymore',
    );

    expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('does not persist punctuation-only H1 as an anchor', async () => {
    (commands.readManagedNameState as any).mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '第{N}章-{title}',
        currentH1: '',
        documentKey: 'chapter.md',
      },
    });
    tabsStore.openTab(`${PROJECT}/chapter.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/chapter.md`, '# !!!');

    expect(newPath).toBe(`${PROJECT}/chapter.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();
    expect(commands.writeManagedNameState).not.toHaveBeenCalled();
  });

  it('after clearing the H1 then retyping the SAME H1, no rename fires', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');

    await tabsStore.tryRenameAfterSave(`${PROJECT}/第1章-开篇.md`, 'no heading');
    (commands.renameItem as any).mockClear();

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 开篇',
    );
    expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('no-ops when H1 is unchanged (extra Cmd+S on a stable file)', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 开篇\n\nbody edited',
    );
    expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('preserves the .markdown extension during ongoing H1 sync', async () => {
    const filePath = `${PROJECT}/chapter-开篇.markdown`;
    (commands.readManagedNameState as any).mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '{title}',
        currentH1: '开篇',
        documentKey: 'chapter-开篇.markdown',
      },
    });
    tabsStore.openTab(filePath, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(filePath, '# 序幕\n\nbody');

    expect(newPath).toBe(`${PROJECT}/chapter-序幕.markdown`);
    expect(commands.renameItem).toHaveBeenCalledWith(PROJECT, filePath, 'chapter-序幕.markdown', true);
  });

  it('keeps the collision suffix before the .markdown extension', async () => {
    const filePath = `${PROJECT}/chapter-开篇.markdown`;
    (commands.readManagedNameState as any).mockResolvedValueOnce({
      status: 'ok',
      data: {
        version: 1,
        status: 'managed',
        templateRaw: '{title}',
        currentH1: '开篇',
        documentKey: 'chapter-开篇.markdown',
      },
    });
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [
        { name: 'chapter-开篇.markdown' },
        { name: 'chapter-序幕.markdown' },
      ],
    });
    tabsStore.openTab(filePath, '# 开篇');

    const newPath = await tabsStore.tryRenameAfterSave(filePath, '# 序幕');

    expect(newPath).toBe(`${PROJECT}/chapter-序幕 2.markdown`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      PROJECT,
      filePath,
      'chapter-序幕 2.markdown',
      true,
    );
  });

  it('reconciles the current inferred name after explicit re-enable even when H1 is unchanged', async () => {
    tabsStore.openTab(`${PROJECT}/chapter.md`, '# 开篇\n\nbody');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/chapter.md`,
      '# 开篇\n\nbody',
      { reconcileCurrentH1: true },
    );

    expect(newPath).toBe(`${PROJECT}/开篇.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(PROJECT, `${PROJECT}/chapter.md`, '开篇.md', true);
  });

  it('does not rename when the template has no {title} (gate honored)', async () => {
    // The gate is the template placeholder, not the legacy autoRenameFromH1
    // checkbox (no UI since 1e0ab6e). Strip {title} for this case.
    const settingsMod = await import('$lib/stores/new-file-settings.svelte');
    const original = settingsMod.newFileSettings.template;
    (settingsMod.newFileSettings as { template: string }).template = '第{N}章';
    try {
      (commands.readManagedNameState as any).mockResolvedValueOnce({ status: 'ok', data: null });
      tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇');
      const newPath = await tabsStore.tryRenameAfterSave(
        `${PROJECT}/第1章-开篇.md`,
        '# 序幕',
      );
      expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
      expect(commands.renameItem).not.toHaveBeenCalled();
    } finally {
      (settingsMod.newFileSettings as { template: string }).template = original;
    }
  });

  it('bumps with " 2" when the new H1 collides with a sibling', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇');
    (commands.listDirectory as any).mockResolvedValue({
      status: 'ok',
      data: [
        { name: '第1章-开篇.md' },
        { name: '第1章-序幕.md' }, // collision
      ],
    });

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 序幕',
    );
    expect(newPath).toBe(`${PROJECT}/第1章-序幕 2.md`);
  });

  it('watcher reload silently refreshes lastSyncedH1 (no rename on external edit)', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');
    const id = tabsStore.activeTabId!;

    // Simulate external edit landing via the file watcher.
    tabsStore.reloadContent(id, '# 终结\n\nbody from another editor');
    expect(commands.renameItem).not.toHaveBeenCalled();

    // A subsequent in-app save with the SAME H1 should also be a no-op.
    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 终结',
    );
    expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();

    // But if the user now changes the H1 again, sync wakes up using "终结"
    // as the anchor. It is absent from the filename, so managed naming falls
    // back to the new sanitized H1 basename.
    const next = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 别的标题',
    );
    expect(next).toBe(`${PROJECT}/别的标题.md`);
  });

  it('keeps the old anchor when renameItem fails so the next save can retry', async () => {
    tabsStore.openTab(`${PROJECT}/第1章-开篇.md`, '# 开篇\n\nbody');
    const id = tabsStore.activeTabId!;

    // First save: filesystem rename fails (e.g. permission denied).
    (commands.renameItem as any).mockResolvedValueOnce({ status: 'error', error: 'EACCES' });
    const failPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 序幕',
    );
    expect(failPath).toBe(`${PROJECT}/第1章-开篇.md`);

    // Anchor is unchanged — still "开篇" — so the next save with the same H1
    // attempts the rename again rather than silently giving up.
    expect(tabsStore.tabs.find(t => t.id === id)?.lastSyncedH1).toBe('开篇');

    const retryPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/第1章-开篇.md`,
      '# 序幕',
    );
    expect(retryPath).toBe(`${PROJECT}/第1章-序幕.md`);
  });

  it('retries anchor persistence after a successful rename when the first anchor write fails', async () => {
    tabsStore.openTab(`${PROJECT}/chapter.md`, '# 开篇\n\nbody');
    (commands.writeManagedNameState as any)
      .mockResolvedValueOnce({ status: 'error', error: 'sidecar write failed' })
      .mockResolvedValueOnce({ status: 'ok', data: null });

    const renamedPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/chapter.md`, '# 序幕');
    expect(renamedPath).toBe(`${PROJECT}/序幕.md`);
    expect(commands.renameItem).toHaveBeenCalledTimes(1);

    const healedPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/序幕.md`, '# 序幕');
    expect(healedPath).toBe(`${PROJECT}/序幕.md`);
    expect(commands.renameItem).toHaveBeenCalledTimes(1);
    expect(commands.writeManagedNameState).toHaveBeenCalledTimes(2);
    expect(commands.writeManagedNameState).toHaveBeenLastCalledWith(
      PROJECT,
      `${PROJECT}/序幕.md`,
      expect.objectContaining({ currentH1: '序幕', documentKey: '序幕.md' }),
    );
  });
});
