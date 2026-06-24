import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression coverage for `tabsStore.tryRenameAfterSave`.
 *
 * Gating:
 *  - The auto-rename setting must be enabled
 *  - Filename must match `isPlaceholder()` (Untitled N / 第N章 / Chapter N / …)
 *  - The save content must contain a non-empty H1
 *
 * Notably, the legacy `tab.justCreated` gate was removed in v0.2.4 — users
 * who reopen a placeholder file in a later session and finally type an H1
 * should still get the auto-rename. See spec
 * `docs/product-specs/2026-05-07-v0.2.4-rename-and-macros.md`.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listDirectory: vi.fn(),
    renameItem: vi.fn(),
    broadcastFileRenamed: vi.fn(),
    registerOpenFile: vi.fn(),
    unregisterOpenFile: vi.fn(),
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
import { commands } from '$lib/ipc/commands';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';

const PROJECT = '/proj';

describe('tabsStore.tryRenameAfterSave — placeholder + H1 gating', () => {
  beforeEach(() => {
    localStorage.clear();
    tabsStore.closeAll();
    vi.clearAllMocks();
    (commands.listDirectory as any).mockResolvedValue({ status: 'ok', data: [] });
    (commands.renameItem as any).mockImplementation((_old: string, name: string) =>
      Promise.resolve({ status: 'ok', data: `${PROJECT}/${name}` }),
    );
    (commands.broadcastFileRenamed as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.registerOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
    (commands.unregisterOpenFile as any).mockResolvedValue({ status: 'ok', data: null });
  });

  it('does NOT rename when the template has no {title} (the designed opt-out)', async () => {
    const original = newFileSettings.template;
    (newFileSettings as { template: string }).template = '第{N}章';
    try {
      tabsStore.openTab(`${PROJECT}/Untitled 1.md`, '', { justCreated: true });
      const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/Untitled 1.md`, '# 开篇');
      expect(newPath).toBe(`${PROJECT}/Untitled 1.md`);
      expect(commands.renameItem).not.toHaveBeenCalled();
    } finally {
      (newFileSettings as { template: string }).template = original;
    }
  });

  it('renames the default template placeholder (第1章-Untitled.md → 第1章-开篇.md)', async () => {
    // The default 第{N}章-{title} renders placeholders the static pattern
    // list can't know; the template-derived matcher must catch them.
    tabsStore.openTab(`${PROJECT}/第1章-Untitled.md`, '', { justCreated: true });

    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/第1章-Untitled.md`, '# 开篇');

    expect(newPath).toBe(`${PROJECT}/第1章-开篇.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/第1章-Untitled.md`,
      '第1章-开篇.md',
      true,
    );
  });

  it('renames a placeholder-named tab that was just created (Cmd+N flow)', async () => {
    tabsStore.openTab(`${PROJECT}/Untitled 1.md`, '', { justCreated: true });
    const body = '# 开篇\n\nsome body';

    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/Untitled 1.md`, body);

    expect(newPath).toBe(`${PROJECT}/开篇.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/Untitled 1.md`,
      '开篇.md',
      true,
    );
  });

  it('renames a placeholder-named tab opened from disk (no justCreated flag)', async () => {
    // User created `第1章.md` manually (e.g. via Finder) or in a previous
    // session. Opening it from the sidebar yields justCreated=false. Once
    // the user finally types an H1 and saves, we still want the rename.
    tabsStore.openTab(`${PROJECT}/第1章.md`, 'existing body');
    const body = '# 开篇\n\nmore body';

    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/第1章.md`, body);

    expect(newPath).toBe(`${PROJECT}/第1章 开篇.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/第1章.md`,
      '第1章 开篇.md',
      true,
    );
  });

  it('renames a placeholder file whose H1 was already present when opened from disk', async () => {
    tabsStore.openTab(`${PROJECT}/Untitled 5.md`, '# 第二章\n\n正文');

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/Untitled 5.md`,
      '# 第二章\n\n正文',
    );

    expect(newPath).toBe(`${PROJECT}/第二章.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/Untitled 5.md`,
      '第二章.md',
      true,
    );
  });

  it('chains renames: after first Path A rename, subsequent H1 changes flow through Path B', async () => {
    tabsStore.openTab(`${PROJECT}/Untitled 1.md`, '', { justCreated: true });
    const id = tabsStore.activeTabId!;

    await tabsStore.tryRenameAfterSave(`${PROJECT}/Untitled 1.md`, '# Title A');

    const renamedTab = tabsStore.tabs.find(t => t.id === id);
    expect(renamedTab?.filePath).toBe(`${PROJECT}/Title A.md`);

    // With ongoing H1 sync (v0.2.5+) a subsequent H1 change continues to
    // drive the filename via Path B. v0.2.4 stopped after the first rename;
    // see spec 2026-05-12-h1-filename-ongoing-sync-design.md.
    (commands.renameItem as any).mockClear();
    const finalPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/Title A.md`, '# Different Title');
    expect(finalPath).toBe(`${PROJECT}/Different Title.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/Title A.md`,
      'Different Title.md',
      true,
    );
  });

  it('no-ops when the save contains no H1 yet (rename deferred until the user titles it)', async () => {
    tabsStore.openTab(`${PROJECT}/Untitled 1.md`, '', { justCreated: true });

    const newPath = await tabsStore.tryRenameAfterSave(
      `${PROJECT}/Untitled 1.md`,
      'body with no heading',
    );
    expect(newPath).toBe(`${PROJECT}/Untitled 1.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();

    // Later save WITH an H1 still triggers the rename.
    await tabsStore.tryRenameAfterSave(`${PROJECT}/Untitled 1.md`, '# 终于有标题了');
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/Untitled 1.md`,
      '终于有标题了.md',
      true,
    );
  });

  it('does nothing for non-placeholder filenames regardless of H1 content', async () => {
    tabsStore.openTab(`${PROJECT}/my-novel.md`, '');
    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/my-novel.md`, '# A Heading');
    expect(newPath).toBe(`${PROJECT}/my-novel.md`);
    expect(commands.renameItem).not.toHaveBeenCalled();
  });

  it('runs even when the tab is clean — Editor.saveCurrentFile relies on this for Cmd+S on clean tabs', async () => {
    // Open a placeholder tab with no content yet (no H1 seeded into anchor),
    // then mark it saved. This simulates a file that's been autosaved already
    // (with no H1), where the user then types a title, and Cmd+S fires on a
    // clean tab — the filename should still update.
    tabsStore.openTab(`${PROJECT}/Untitled 1.md`, '');
    const id = tabsStore.activeTabId!;
    tabsStore.markSaved(id);
    const tab = tabsStore.tabs.find(t => t.id === id);
    expect(tab?.isDirty).toBe(false);

    const newPath = await tabsStore.tryRenameAfterSave(`${PROJECT}/Untitled 1.md`, '# 开篇');
    expect(newPath).toBe(`${PROJECT}/开篇.md`);
    expect(commands.renameItem).toHaveBeenCalledWith(
      `${PROJECT}/Untitled 1.md`,
      '开篇.md',
      true,
    );
  });
});
