import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * [contract] templatesStore — thin reactive mirror over the Rust
 * `template_files` IPC commands. Every mutation revalidates via `refresh()`,
 * increments `revision`, and throws on IPC error so callers can surface a
 * toast. `bundled()` / `project()` partition by source.
 */

vi.mock('$lib/ipc/commands', () => ({
  commands: {
    listTemplateFiles: vi.fn(),
    readTemplateFile: vi.fn(),
    writeTemplateFile: vi.fn(),
    renameTemplateFile: vi.fn(),
    deleteTemplateFile: vi.fn(),
    duplicateBundledTemplate: vi.fn(),
  },
}));

import { templatesStore } from '$lib/stores/templates.svelte';
import { commands } from '$lib/ipc/commands';

function mkSummary(id: string, source: 'bundled' | 'project'): any {
  return {
    id,
    name: id,
    description: null,
    source,
    mode: 'new-file',
    default_filename: null,
  };
}

function resetStore() {
  templatesStore.summaries = [];
  templatesStore.loading = false;
  templatesStore.error = null;
  templatesStore.revision = 0;
}

describe('[contract] templatesStore.refresh', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('populates summaries on success and clears any prior error', async () => {
    templatesStore.error = 'prior error';
    const rows = [mkSummary('greeting', 'bundled'), mkSummary('my-chapter', 'project')];
    (commands.listTemplateFiles as any).mockResolvedValue({ status: 'ok', data: rows });

    await templatesStore.refresh('/proj');

    expect(templatesStore.summaries).toEqual(rows);
    expect(templatesStore.error).toBeNull();
    expect(templatesStore.loading).toBe(false);
  });

  it('captures the IPC error into `error` without throwing', async () => {
    (commands.listTemplateFiles as any).mockResolvedValue({
      status: 'error',
      error: 'IO failure',
    });

    await templatesStore.refresh('/proj');

    expect(templatesStore.error).toBe('IO failure');
    expect(templatesStore.summaries).toEqual([]);
    expect(templatesStore.loading).toBe(false);
  });

  it('captures a thrown Error via its `.message` property', async () => {
    (commands.listTemplateFiles as any).mockRejectedValue(new Error('network down'));

    await templatesStore.refresh('/proj');

    expect(templatesStore.error).toBe('network down');
    expect(templatesStore.loading).toBe(false);
  });

  it('captures a non-Error throw via String() fallback', async () => {
    (commands.listTemplateFiles as any).mockRejectedValue('literal string');

    await templatesStore.refresh('/proj');

    expect(templatesStore.error).toBe('literal string');
    expect(templatesStore.loading).toBe(false);
  });

  it('passes through a null projectDir (global/scratch mode)', async () => {
    (commands.listTemplateFiles as any).mockResolvedValue({ status: 'ok', data: [] });

    await templatesStore.refresh(null);

    expect(commands.listTemplateFiles).toHaveBeenCalledWith(null);
  });
});

describe('[contract] templatesStore partitioning', () => {
  beforeEach(resetStore);

  it('bundled() filters to source === "bundled"', () => {
    templatesStore.summaries = [
      mkSummary('b1', 'bundled'),
      mkSummary('p1', 'project'),
      mkSummary('b2', 'bundled'),
    ];
    const bundled = templatesStore.bundled();
    expect(bundled.map(s => s.id)).toEqual(['b1', 'b2']);
  });

  it('project() filters to source === "project"', () => {
    templatesStore.summaries = [
      mkSummary('b1', 'bundled'),
      mkSummary('p1', 'project'),
      mkSummary('p2', 'project'),
    ];
    const project = templatesStore.project();
    expect(project.map(s => s.id)).toEqual(['p1', 'p2']);
  });

  it('both partitions are empty when the store has no summaries', () => {
    expect(templatesStore.bundled()).toEqual([]);
    expect(templatesStore.project()).toEqual([]);
  });
});

describe('[contract] templatesStore.read', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('returns the template body on success', async () => {
    (commands.readTemplateFile as any).mockResolvedValue({
      status: 'ok',
      data: { body: '# Hello', frontmatter: {} },
    });

    const body = await templatesStore.read('bundled', 'greeting', '/proj');

    expect(body).toEqual({ body: '# Hello', frontmatter: {} });
    expect(commands.readTemplateFile).toHaveBeenCalledWith('bundled', 'greeting', '/proj');
  });

  it('throws when IPC reports error', async () => {
    (commands.readTemplateFile as any).mockResolvedValue({
      status: 'error',
      error: 'not found',
    });

    await expect(templatesStore.read('bundled', 'ghost', '/proj')).rejects.toThrow('not found');
  });
});

describe('[contract] templatesStore mutations bump revision + trigger refresh', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    (commands.listTemplateFiles as any).mockResolvedValue({ status: 'ok', data: [] });
  });

  it('create() bumps revision, refreshes, and returns the new summary', async () => {
    const created = mkSummary('new-tpl', 'project');
    (commands.writeTemplateFile as any).mockResolvedValue({ status: 'ok', data: created });

    const result = await templatesStore.create(
      '/proj',
      'new-tpl',
      { name: 'New', mode: 'insert', description: null, defaultFilename: null },
      '# body',
    );

    expect(result).toEqual(created);
    expect(templatesStore.revision).toBe(1);
    expect(commands.listTemplateFiles).toHaveBeenCalledWith('/proj');
  });

  it('create() throws and does not bump revision on error', async () => {
    (commands.writeTemplateFile as any).mockResolvedValue({
      status: 'error',
      error: 'duplicate id',
    });

    await expect(
      templatesStore.create(
        '/proj',
        'dup',
        { name: 'X', mode: 'insert', description: null, defaultFilename: null },
        'body',
      ),
    ).rejects.toThrow('duplicate id');
    expect(templatesStore.revision).toBe(0);
    expect(commands.listTemplateFiles).not.toHaveBeenCalled();
  });

  it('rename() bumps revision, refreshes, and returns the renamed summary', async () => {
    const renamed = mkSummary('new-id', 'project');
    (commands.renameTemplateFile as any).mockResolvedValue({ status: 'ok', data: renamed });

    const result = await templatesStore.rename('/proj', 'old-id', 'new-id');

    expect(result).toEqual(renamed);
    expect(templatesStore.revision).toBe(1);
    expect(commands.listTemplateFiles).toHaveBeenCalledWith('/proj');
  });

  it('rename() throws on error without bumping revision', async () => {
    (commands.renameTemplateFile as any).mockResolvedValue({
      status: 'error',
      error: 'collision',
    });

    await expect(templatesStore.rename('/proj', 'a', 'b')).rejects.toThrow('collision');
    expect(templatesStore.revision).toBe(0);
  });

  it('remove() bumps revision and refreshes', async () => {
    (commands.deleteTemplateFile as any).mockResolvedValue({ status: 'ok', data: null });

    await templatesStore.remove('/proj', 'tpl-a');

    expect(templatesStore.revision).toBe(1);
    expect(commands.deleteTemplateFile).toHaveBeenCalledWith('/proj', 'tpl-a');
    expect(commands.listTemplateFiles).toHaveBeenCalledWith('/proj');
  });

  it('remove() throws on error without bumping revision', async () => {
    (commands.deleteTemplateFile as any).mockResolvedValue({
      status: 'error',
      error: 'locked',
    });

    await expect(templatesStore.remove('/proj', 'tpl-a')).rejects.toThrow('locked');
    expect(templatesStore.revision).toBe(0);
  });

  it('duplicateBundled() bumps revision, refreshes, and returns the new summary', async () => {
    const dup = mkSummary('chapter-copy', 'project');
    (commands.duplicateBundledTemplate as any).mockResolvedValue({ status: 'ok', data: dup });

    const result = await templatesStore.duplicateBundled('/proj', 'chapter', null);

    expect(result).toEqual(dup);
    expect(templatesStore.revision).toBe(1);
    expect(commands.duplicateBundledTemplate).toHaveBeenCalledWith('/proj', 'chapter', null);
  });

  it('duplicateBundled() throws on error without bumping revision', async () => {
    (commands.duplicateBundledTemplate as any).mockResolvedValue({
      status: 'error',
      error: 'unknown bundled id',
    });

    await expect(
      templatesStore.duplicateBundled('/proj', 'nope', 'copy'),
    ).rejects.toThrow('unknown bundled id');
    expect(templatesStore.revision).toBe(0);
  });
});
