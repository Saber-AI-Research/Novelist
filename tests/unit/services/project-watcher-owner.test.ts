import { describe, expect, it } from 'vitest';
import { ProjectWatcherOwner } from '$lib/services/project-watcher-owner';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('ProjectWatcherOwner', () => {
  it('restores the latest watcher after a stale start completes', async () => {
    const bStart = deferred();
    const calls: string[] = [];
    let watchedProject: string | null = null;
    let currentProject = '/B';
    const owner = new ProjectWatcherOwner({
      async stop() {
        calls.push('stop');
        watchedProject = null;
        return { status: 'ok' as const, data: null };
      },
      async start(projectDir) {
        calls.push(`start:${projectDir}`);
        if (projectDir === '/B') await bStart.promise;
        watchedProject = projectDir;
        return { status: 'ok' as const, data: null };
      },
    });

    const staleB = owner.start('/B', () => currentProject === '/B');
    await Promise.resolve();
    currentProject = '/A';
    const stopForA = owner.stop(() => currentProject === '/A');
    const startA = owner.start('/A', () => currentProject === '/A');
    bStart.resolve();
    await Promise.all([staleB, stopForA, startA]);

    expect(calls).toEqual(['start:/B', 'stop', 'start:/A']);
    expect(watchedProject).toBe('/A');
  });

  it('skips a queued operation whose request is stale before it starts', async () => {
    const firstStop = deferred();
    const calls: string[] = [];
    let current = true;
    const owner = new ProjectWatcherOwner({
      async stop() {
        calls.push('stop');
        if (calls.length === 1) await firstStop.promise;
        return { status: 'ok' as const, data: null };
      },
      async start(projectDir) {
        calls.push(`start:${projectDir}`);
        return { status: 'ok' as const, data: null };
      },
    });

    const blocking = owner.stop(() => true);
    const staleStart = owner.start('/B', () => current);
    current = false;
    firstStop.resolve();
    await Promise.all([blocking, staleStart]);

    expect(calls).toEqual(['stop']);
  });
});
