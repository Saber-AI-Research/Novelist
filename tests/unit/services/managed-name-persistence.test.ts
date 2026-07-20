import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedNameState } from '$lib/utils/managed-name';

const { h } = vi.hoisted(() => {
  const commands = {
    computeDocumentKey: vi.fn(),
    readManagedNameState: vi.fn(),
    writeManagedNameState: vi.fn(),
    deleteManagedNameState: vi.fn(),
  };
  return { h: { commands } };
});

vi.mock('$lib/ipc/commands', () => ({ commands: h.commands }));

import {
  confirmManagedNameEnrollment,
  detachManagedName,
  deleteManagedName,
  enableManagedNameForCreatedFile,
  clearManagedNameCache,
  loadManagedName,
  migrateManagedNameCachePath,
  reEnableManagedName,
  writeManagedName,
} from '$lib/services/managed-name-persistence';

const PROJECT = '/proj';
const FILE = '/proj/chapter.md';

function state(overrides: Partial<ManagedNameState> = {}): ManagedNameState {
  return {
    version: 1,
    status: 'managed',
    templateRaw: '{title}',
    currentH1: '开篇',
    documentKey: 'chapter.md',
    ...overrides,
  };
}

describe('[contract] managed-name persistence service', () => {
  beforeEach(() => {
    clearManagedNameCache();
    vi.resetAllMocks();
    h.commands.computeDocumentKey.mockResolvedValue({ status: 'ok', data: 'chapter.md' });
    h.commands.readManagedNameState.mockResolvedValue({ status: 'ok', data: null });
    h.commands.writeManagedNameState.mockResolvedValue({ status: 'ok', data: null });
    h.commands.deleteManagedNameState.mockResolvedValue({ status: 'ok', data: null });
  });

  it('enrolls a created file only when the resolved template contains canonical {title}', async () => {
    const result = await enableManagedNameForCreatedFile(PROJECT, FILE, '第{N}章-{title}', '');

    expect(result?.status).toBe('managed');
    expect(result?.templateRaw).toBe('第{N}章-{title}');
    expect(result?.documentKey).toBe('chapter.md');
    expect(h.commands.writeManagedNameState).toHaveBeenCalledWith(PROJECT, FILE, result);
  });

  it('does not enroll ordinary files or typo title tokens', async () => {
    await expect(enableManagedNameForCreatedFile(PROJECT, FILE, 'Chapter {N}', '')).resolves.toBeNull();
    await expect(enableManagedNameForCreatedFile(PROJECT, FILE, 'Chapter {Title}', '')).resolves.toBeNull();
    expect(h.commands.computeDocumentKey).not.toHaveBeenCalled();
    expect(h.commands.writeManagedNameState).not.toHaveBeenCalled();
  });

  it('distinguishes missing state from read errors', async () => {
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'missing' });

    clearManagedNameCache();
    h.commands.readManagedNameState.mockResolvedValueOnce({ status: 'error', error: 'bad json' });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'invalid', error: 'bad json' });
  });

  it('retries after a transient read error and can recover to ready state', async () => {
    const ready = state({ templateRaw: '第{N}章-{title}' });
    h.commands.readManagedNameState
      .mockResolvedValueOnce({ status: 'error', error: 'temporary read failure' })
      .mockResolvedValueOnce({ status: 'ok', data: ready });

    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({
      kind: 'invalid',
      error: 'temporary read failure',
    });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: ready });
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('retries after a corrupt read shape so a repaired sidecar is visible without restart', async () => {
    const ready = state({ templateRaw: '第{N}章-{title}' });
    h.commands.readManagedNameState
      .mockResolvedValueOnce({ status: 'ok', data: { ...ready, status: 'broken' } })
      .mockResolvedValueOnce({ status: 'ok', data: ready });

    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({
      kind: 'invalid',
      error: 'Invalid managed-name state shape',
    });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: ready });
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('lets a missing read recover to ready after a later write', async () => {
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'missing' });

    const ready = state({ templateRaw: '第{N}章-{title}' });
    await expect(writeManagedName(PROJECT, FILE, ready)).resolves.toEqual(ready);
    h.commands.readManagedNameState.mockResolvedValueOnce({ status: 'ok', data: ready });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: ready });
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('invalidates rename cache entries and reloads authoritative destination state', async () => {
    const detached = state({ status: 'detached', templateRaw: '第{N}章-{title}' });
    h.commands.readManagedNameState.mockResolvedValueOnce({ status: 'ok', data: detached });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: detached });

    const destination = state({
      status: 'managed',
      currentH1: 'destination winner',
      documentKey: 'chapter-renamed.md',
    });
    h.commands.readManagedNameState.mockResolvedValueOnce({ status: 'ok', data: destination });
    await migrateManagedNameCachePath(PROJECT, FILE, '/proj/chapter-renamed.md');

    await expect(loadManagedName(PROJECT, '/proj/chapter-renamed.md')).resolves.toEqual({
      kind: 'ready',
      state: destination,
    });
    expect(h.commands.computeDocumentKey).not.toHaveBeenCalled();
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('does not migrate missing/invalid cache entries to a renamed path', async () => {
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'missing' });
    await migrateManagedNameCachePath(PROJECT, FILE, '/proj/chapter-renamed.md');

    h.commands.readManagedNameState.mockResolvedValueOnce({ status: 'ok', data: state({ documentKey: 'chapter-renamed.md' }) });
    await expect(loadManagedName(PROJECT, '/proj/chapter-renamed.md')).resolves.toEqual({
      kind: 'ready',
      state: state({ documentKey: 'chapter-renamed.md' }),
    });
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('reloads ready state so a cross-window detach is observable without restart', async () => {
    const managed = state({ templateRaw: '第{N}章-{title}' });
    const detached = state({ status: 'detached', templateRaw: '第{N}章-{title}' });
    h.commands.readManagedNameState
      .mockResolvedValueOnce({ status: 'ok', data: managed })
      .mockResolvedValueOnce({ status: 'ok', data: detached });

    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: managed });
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'ready', state: detached });
    expect(h.commands.readManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('does not authorize a failed enrollment through optimistic cache state', async () => {
    h.commands.writeManagedNameState.mockResolvedValueOnce({ status: 'error', error: 'disk full' });

    await expect(enableManagedNameForCreatedFile(PROJECT, FILE, '{title}', '')).resolves.toBeNull();
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'missing' });
  });

  it('invalidates optimistic state when authoritative enrollment read-back mismatches', async () => {
    const expected = await enableManagedNameForCreatedFile(PROJECT, FILE, '{title}', '开篇');
    expect(expected).not.toBeNull();
    h.commands.readManagedNameState
      .mockResolvedValueOnce({ status: 'ok', data: state({ status: 'detached' }) })
      .mockResolvedValueOnce({ status: 'ok', data: null });

    await expect(confirmManagedNameEnrollment(PROJECT, FILE, expected!)).resolves.toBe(false);
    await expect(loadManagedName(PROJECT, FILE)).resolves.toEqual({ kind: 'missing' });
  });

  it('persists explicit detach and re-enable without changing documentKey', async () => {
    const detached = await detachManagedName(PROJECT, FILE, state({ templateRaw: '第{N}章-{title}' }));
    expect(detached?.status).toBe('detached');
    expect(detached?.documentKey).toBe('chapter.md');
    expect(detached?.templateRaw).toBe('第{N}章-{title}');

    const managed = await reEnableManagedName(PROJECT, FILE, detached!);
    expect(managed?.status).toBe('managed');
    expect(managed?.documentKey).toBe('chapter.md');
    expect(h.commands.writeManagedNameState).toHaveBeenCalledTimes(2);
  });

  it('returns null when serialization/write validation fails', async () => {
    const invalid = state({ templateRaw: 'Chapter {N}' });
    await expect(writeManagedName(PROJECT, FILE, invalid)).resolves.toBeNull();
    expect(h.commands.writeManagedNameState).not.toHaveBeenCalled();
  });

  it('deletes managed-name state through the generated command', async () => {
    await expect(deleteManagedName(PROJECT, FILE)).resolves.toBe(true);
    expect(h.commands.deleteManagedNameState).toHaveBeenCalledWith(PROJECT, FILE);
  });
});
