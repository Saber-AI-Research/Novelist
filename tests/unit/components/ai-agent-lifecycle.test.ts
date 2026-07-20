import { describe, expect, it, vi } from 'vitest';
import {
  AiAgentProjectLifecycle,
  AiSessionPersistenceQueueClosedError,
  acquireAiAgentMountLease,
  applyFileIfCurrent,
  attachListenerIfCurrent,
  createAiAgentAttemptOwner,
  createAiSessionPersistenceQueue,
  isProjectScopedPath,
  mutateAndPersistForToken,
  startLiveSessionIfCurrent,
  type AiAgentProjectToken,
} from '$lib/components/ai-agent/lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('[contract] AI Agent project lifecycle owner', () => {
  it('uses monotonic generations so stale attempts cannot release newer retries', () => {
    const owner = createAiAgentAttemptOwner();
    const first = owner.claim('session-1', 'turn-1');
    expect(first).toMatchObject({ turnId: 'turn-1', generation: 1 });
    expect(owner.claim('session-1', 'turn-1')).toBeNull();

    expect(first && owner.release('session-1', first)).toBe(true);
    const retry = owner.claim('session-1', 'turn-1');
    expect(retry).toMatchObject({ turnId: 'turn-1', generation: 2 });
    expect(first && owner.release('session-1', first)).toBe(false);
    expect(retry && owner.owns('session-1', retry)).toBe(true);
  });

  it('keeps generations monotonic after clearing volatile ownership', () => {
    const owner = createAiAgentAttemptOwner();
    const first = owner.claim('session-1', 'turn-1');
    expect(first).not.toBeNull();
    owner.clear();

    const second = owner.claim('session-1', 'turn-2');
    expect(second).toMatchObject({ generation: 2, turnId: 'turn-2' });
  });

  it('binds a provisional send reservation to its durable turn without changing generation', () => {
    const owner = createAiAgentAttemptOwner();
    const provisional = owner.claim('session-1', '');
    expect(provisional).not.toBeNull();

    const bound = provisional && owner.bindTurn('session-1', provisional, 'turn-1');

    expect(bound).toMatchObject({ generation: 1, turnId: 'turn-1', phase: 'reserved' });
    expect(bound && owner.owns('session-1', bound)).toBe(true);
    expect(owner.current('session-1')).toEqual(bound);
  });

  it('keeps cancelling attempts claimed but prevents them from becoming running', () => {
    const owner = createAiAgentAttemptOwner();
    const attempt = owner.claim('session-1', 'turn-1');
    expect(attempt).not.toBeNull();

    const cancelling = attempt && owner.markCancelling('session-1', attempt);

    expect(cancelling).toMatchObject({ phase: 'cancelling', generation: 1 });
    expect(attempt && owner.markRunning('session-1', attempt)).toBeNull();
    expect(cancelling && owner.owns('session-1', cancelling)).toBe(true);
    expect(owner.claim('session-1', 'turn-2')).toBeNull();
  });

  it('tears down project A before loading project B and makes A tokens stale immediately', async () => {
    const events: string[] = [];
    let tokenA!: AiAgentProjectToken;
    const teardownGate = deferred();
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject(ctx) {
        events.push(`teardown:${ctx.projectDir}`);
        expect(lifecycle.isCurrent(tokenA)).toBe(false);
        await teardownGate.promise;
        events.push(`teardown-done:${ctx.projectDir}`);
      },
      clearVolatileContext: (ctx) => events.push(`clear:${ctx.projectDir}`),
      async loadProject(ctx) {
        events.push(`load:${ctx.projectDir}`);
        if (ctx.projectDir === '/A') tokenA = ctx;
      },
    });

    await lifecycle.switchTo('/A');
    const switching = lifecycle.switchTo('/B');
    await Promise.resolve();
    expect(events).toEqual(['clear:/A', 'load:/A', 'teardown:/A']);
    teardownGate.resolve();
    await switching;

    expect(events).toEqual([
      'clear:/A',
      'load:/A',
      'teardown:/A',
      'teardown-done:/A',
      'clear:/B',
      'load:/B',
    ]);
    expect(lifecycle.status.kind).toBe('ready');
    expect(lifecycle.currentProjectDir).toBe('/B');
  });

  it('invalidates A immediately when B is requested while A load is still pending', async () => {
    const loadGate = deferred();
    let tokenA!: AiAgentProjectToken;
    const events: string[] = [];
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: (ctx) => events.push(`clear:${ctx.projectDir}`),
      async loadProject(ctx) {
        events.push(`load-start:${ctx.projectDir}`);
        if (ctx.projectDir === '/A') {
          tokenA = ctx;
          await loadGate.promise;
        }
        events.push(`load-end:${ctx.projectDir}`);
      },
    });

    const loadingA = lifecycle.switchTo('/A');
    await Promise.resolve();
    expect(lifecycle.isCurrent(tokenA)).toBe(true);

    const loadingB = lifecycle.switchTo('/B');
    expect(lifecycle.isCurrent(tokenA)).toBe(false);
    expect(lifecycle.currentProjectDir).toBe('/B');
    expect(lifecycle.status).toMatchObject({ kind: 'loading', projectDir: '/B' });

    loadGate.resolve();
    await Promise.all([loadingA, loadingB]);

    expect(events).toEqual([
      'clear:/A',
      'load-start:/A',
      'load-end:/A',
      'clear:/B',
      'load-start:/B',
      'load-end:/B',
    ]);
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/B' });
  });

  it('serializes accepted A to B to A switches without duplicate loads', async () => {
    const loads: Array<string | null> = [];
    const teardowns: Array<string | null> = [];
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject(ctx) { teardowns.push(ctx.projectDir); },
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) { loads.push(ctx.projectDir); },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo('/B');
    await lifecycle.switchTo('/A');

    expect(loads).toEqual(['/A', '/B', '/A']);
    expect(teardowns).toEqual(['/A', '/B']);
    expect(lifecycle.currentProjectDir).toBe('/A');
  });

  it('reloads a ready same-path project only for a new project generation', async () => {
    const loads: Array<string | null> = [];
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) { loads.push(ctx.projectDir); },
    });

    await lifecycle.switchTo('/A');
    expect(loads).toEqual(['/A']);
    await lifecycle.switchTo('/A');
    expect(loads).toEqual(['/A']);
    await lifecycle.switchTo('/A', true);

    expect(loads).toEqual(['/A', '/A']);
  });

  it('does not load a superseded queued destination after rapid A to B to A requests', async () => {
    const loadGate = deferred();
    const loads: Array<string | null> = [];
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        loads.push(ctx.projectDir);
        if (ctx.projectDir === '/A' && loads.length === 1) await loadGate.promise;
      },
    });

    const firstA = lifecycle.switchTo('/A');
    await Promise.resolve();
    const b = lifecycle.switchTo('/B');
    const secondA = lifecycle.switchTo('/A');
    loadGate.resolve();
    await Promise.all([firstA, b, secondA]);

    expect(loads).toEqual(['/A', '/A']);
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/A' });
  });

  it('exposes requested and loaded projects separately for destroy-time teardown', async () => {
    const loadGate = deferred();
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        if (ctx.projectDir === '/B') await loadGate.promise;
      },
    });

    await lifecycle.switchTo('/A');
    const loadingB = lifecycle.switchTo('/B');

    expect(lifecycle.currentProjectDir).toBe('/B');
    expect(lifecycle.loadedProjectDir).toBe('/A');

    loadGate.resolve();
    await loadingB;
    expect(lifecycle.loadedProjectDir).toBe('/B');
  });

  it('lets destroy claim the loaded source before queued destination load runs', async () => {
    const loadGate = deferred();
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        if (ctx.projectDir === '/B') await loadGate.promise;
      },
    });

    await lifecycle.switchTo('/A');
    const loadingB = lifecycle.switchTo('/B');

    lifecycle.invalidate();
    expect(lifecycle.takeLoadedProjectForTeardown()).toBe('/A');
    expect(lifecycle.takeLoadedProjectForTeardown()).toBeNull();

    loadGate.resolve();
    await loadingB;
    expect(lifecycle.loadedProjectDir).toBeNull();
  });

  it('keeps destination load failures scoped to the destination and retryable', async () => {
    const failures: string[] = [];
    let failB = true;
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        if (ctx.projectDir === '/B' && failB) throw new Error('B sessions unavailable');
      },
      onLoadFailure(ctx, error) {
        failures.push(`${ctx.projectDir}:${error instanceof Error ? error.message : String(error)}`);
      },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo('/B');

    expect(lifecycle.status).toMatchObject({ kind: 'error', projectDir: '/B', message: 'B sessions unavailable' });
    expect(lifecycle.currentProjectDir).toBe('/B');
    expect(failures).toEqual(['/B:B sessions unavailable']);

    failB = false;
    await lifecycle.switchTo('/B');
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/B' });
  });

  it('clears loaded project ownership when the project closes', async () => {
    const events: string[] = [];
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject(ctx) { events.push(`teardown:${ctx.projectDir}`); },
      clearVolatileContext: (ctx) => events.push(`clear:${ctx.projectDir}`),
      async loadProject(ctx) { events.push(`load:${ctx.projectDir}`); },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo(null);

    expect(events).toEqual(['clear:/A', 'load:/A', 'teardown:/A', 'clear:null', 'load:null']);
    expect(lifecycle.currentProjectDir).toBeNull();
    expect(lifecycle.loadedProjectDir).toBeNull();
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: null });
  });

  it('tears down a runtime loaded without a project before opening project A', async () => {
    const teardowns: Array<string | null> = [];
    const loads: Array<string | null> = [];
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject(ctx) { teardowns.push(ctx.projectDir); },
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) { loads.push(ctx.projectDir); },
    });

    await lifecycle.switchTo(null);
    await lifecycle.switchTo('/A');

    expect(loads).toEqual([null, '/A']);
    expect(teardowns).toEqual([null]);
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/A' });
  });

  it('preserves teardown rejection for its caller without poisoning later switches', async () => {
    const loaded: Array<string | null> = [];
    let rejectTeardown = true;
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject() {
        if (rejectTeardown) throw new Error('source persistence failed');
      },
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        loaded.push(ctx.projectDir);
      },
    });

    await lifecycle.switchTo('/A');
    const failedSwitch = lifecycle.switchTo('/B');
    await expect(failedSwitch).rejects.toThrow('source persistence failed');

    rejectTeardown = false;
    await lifecycle.switchTo('/C');

    expect(loaded).toEqual(['/A', '/C']);
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/C' });
    await expect(failedSwitch).rejects.toThrow('source persistence failed');
  });

  it('guards late stream events and Apply Changes paths by current project', async () => {
    const lifecycle = new AiAgentProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      loadProject: vi.fn().mockResolvedValue(undefined),
    });
    await lifecycle.switchTo('/A');
    const tokenA = lifecycle.capture();
    await lifecycle.switchTo('/B');

    expect(lifecycle.isCurrent(tokenA)).toBe(false);
    expect(isProjectScopedPath('/B', '/B/chapter.md')).toBe(true);
    expect(isProjectScopedPath('/B', '/A/chapter.md')).toBe(false);
  });

  it('accepts project-root equality and Unix/Windows child paths after separator normalization', () => {
    const winProject = ['C:', 'proj'].join('\\');
    const winProjectTrailing = `${winProject}\\`;
    const winChapter = ['C:', 'proj', 'chapter.md'].join('\\');

    expect(isProjectScopedPath('/proj', '/proj')).toBe(true);
    expect(isProjectScopedPath('/proj/', '/proj/chapter.md')).toBe(true);
    expect(isProjectScopedPath('/proj', ['/proj', 'chapter.md'].join('\\'))).toBe(true);

    expect(isProjectScopedPath(winProject, winProject)).toBe(true);
    expect(isProjectScopedPath(winProject, winChapter)).toBe(true);
    expect(isProjectScopedPath(winProjectTrailing, 'C:/proj/chapter.md')).toBe(true);
    expect(isProjectScopedPath('C:/Project', 'c:/project/Chapter.md')).toBe(true);
  });

  it('rejects sibling-prefix escapes and traversal-normalized escapes', () => {
    const winProject = ['C:', 'proj'].join('\\');
    const winSibling = ['C:', 'proj2', 'chapter.md'].join('\\');
    const winTraversalEscape = ['C:', 'proj', '..', 'proj2', 'chapter.md'].join('\\');
    const winTraversalInside = ['C:', 'proj', 'sub', '..', 'chapter.md'].join('\\');

    expect(isProjectScopedPath('/proj', '/proj2/chapter.md')).toBe(false);
    expect(isProjectScopedPath('/proj', '/proj/../proj2/chapter.md')).toBe(false);
    expect(isProjectScopedPath('/proj', '/proj/sub/../chapter.md')).toBe(true);

    expect(isProjectScopedPath(winProject, winSibling)).toBe(false);
    expect(isProjectScopedPath(winProject, winTraversalEscape)).toBe(false);
    expect(isProjectScopedPath(winProject, winTraversalInside)).toBe(true);
  });

  it('keeps Apply Changes fail-closed for stale or missing source project identity', () => {
    const canApply = (sourceProjectDir: string | null | undefined, currentProjectDir: string | null, filePath: string) =>
      sourceProjectDir === currentProjectDir && isProjectScopedPath(currentProjectDir, filePath);

    expect(canApply('/proj', '/proj', '/proj/chapter.md')).toBe(true);
    expect(canApply(undefined, '/proj', '/proj/chapter.md')).toBe(false);
    expect(canApply(null, '/proj', '/proj/chapter.md')).toBe(false);
    expect(canApply('/old', '/proj', '/old/chapter.md')).toBe(false);
    expect(canApply('/proj', '/proj', '/proj2/chapter.md')).toBe(false);
  });

  it('loads destination after a caught cancel failure without leaking source state', async () => {
    const events: string[] = [];
    const listeners = new Set(['listener:A']);
    const sourceState = { interrupted: false, persistedTo: null as string | null };
    const lifecycle = new AiAgentProjectLifecycle({
      async teardownProject(ctx) {
        listeners.clear();
        sourceState.interrupted = true;
        try {
          events.push(`cancel:${ctx.projectDir}`);
          throw new Error('already closed');
        } catch {
          events.push(`cancel-caught:${ctx.projectDir}`);
        }
        sourceState.persistedTo = ctx.projectDir;
        events.push(`persist:${ctx.projectDir}`);
      },
      clearVolatileContext(ctx) {
        events.push(`clear:${ctx.projectDir}`);
      },
      async loadProject(ctx) {
        events.push(`load:${ctx.projectDir}`);
        if (ctx.projectDir === '/B') {
          expect(listeners.size).toBe(0);
          expect(sourceState).toEqual({ interrupted: true, persistedTo: '/A' });
        }
      },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo('/B');

    expect(events).toEqual([
      'clear:/A',
      'load:/A',
      'cancel:/A',
      'cancel-caught:/A',
      'persist:/A',
      'clear:/B',
      'load:/B',
    ]);
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/B' });
  });

  it('kills a spawned session when the token goes stale before listener attachment', async () => {
    const staleToken: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const kill = vi.fn().mockResolvedValue(undefined);
    const listen = vi.fn().mockResolvedValue(vi.fn());
    const register = vi.fn();

    const result = await startLiveSessionIfCurrent({
      token: staleToken,
      sessionUuid: 'uuid-a',
      isCurrent: () => false,
      spawn: vi.fn().mockResolvedValue('uuid-a'),
      listen,
      kill,
      register,
    });

    expect(result).toBeNull();
    expect(kill).toHaveBeenCalledWith('uuid-a');
    expect(listen).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('unlistens and kills when listener attachment resolves after token invalidation', async () => {
    const token: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const unlisten = vi.fn();
    const kill = vi.fn().mockResolvedValue(undefined);
    let current = true;
    const register = vi.fn();

    const result = await startLiveSessionIfCurrent({
      token,
      sessionUuid: 'uuid-a',
      isCurrent: () => current,
      spawn: vi.fn().mockResolvedValue('uuid-a'),
      async listen() {
        current = false;
        return unlisten;
      },
      kill,
      register,
    });

    expect(result).toBeNull();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('uuid-a');
    expect(register).not.toHaveBeenCalled();
  });

  it('kills a spawned session and preserves the original listener rejection', async () => {
    const token: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const listenerError = new Error('listener registration failed');
    const kill = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();

    const started = startLiveSessionIfCurrent({
      token,
      sessionUuid: 'uuid-a',
      isCurrent: () => true,
      spawn: vi.fn().mockResolvedValue('uuid-a'),
      listen: vi.fn().mockRejectedValue(listenerError),
      kill,
      register,
    });

    await expect(started).rejects.toBe(listenerError);
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('uuid-a');
    expect(register).not.toHaveBeenCalled();
  });

  it('unlistens and kills stale one-shot listener completions', async () => {
    const token: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const unlisten = vi.fn();
    const kill = vi.fn().mockResolvedValue(undefined);
    const register = vi.fn();

    const attached = await attachListenerIfCurrent({
      token,
      sessionUuid: 'uuid-codex',
      isCurrent: () => false,
      listen: vi.fn().mockResolvedValue(unlisten),
      kill,
      register,
    });

    expect(attached).toBe(false);
    expect(unlisten).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith('uuid-codex');
    expect(register).not.toHaveBeenCalled();
  });

  it('does not mutate or persist send work after token becomes stale', async () => {
    const token: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const mutate = vi.fn();
    const persist = vi.fn().mockResolvedValue(undefined);

    const applied = await mutateAndPersistForToken({
      token,
      isCurrent: () => false,
      mutate,
      persist,
    });

    expect(applied).toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists send mutations to the token project, not the later requested project', async () => {
    const token: AiAgentProjectToken = { id: 1, projectDir: '/A' };
    const persisted: Array<string | null> = [];

    const applied = await mutateAndPersistForToken({
      token,
      isCurrent: () => true,
      mutate: vi.fn(),
      async persist(projectDir) { persisted.push(projectDir); },
    });

    expect(applied).toBe(true);
    expect(persisted).toEqual(['/A']);
  });

  it('does not write or mutate Apply Changes when its source token is stale', async () => {
    const compareAndWrite = vi.fn().mockResolvedValue('written');
    const markConflict = vi.fn();
    const markAccepted = vi.fn();

    const result = await applyFileIfCurrent({
      token: { id: 1, projectDir: '/A' },
      sourceProjectDir: '/A',
      filePath: '/A/chapter.md',
      expectedText: 'old',
      proposedText: 'new',
      isCurrent: () => false,
      compareAndWrite,
      markConflict,
      markAccepted,
    });

    expect(result).toBe('stale');
    expect(compareAndWrite).not.toHaveBeenCalled();
    expect(markConflict).not.toHaveBeenCalled();
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('suppresses card mutation when token becomes stale after write was invoked', async () => {
    let current = true;
    const writeGate = deferred();
    const markAccepted = vi.fn();

    const applying = applyFileIfCurrent({
      token: { id: 1, projectDir: '/A' },
      sourceProjectDir: '/A',
      filePath: '/A/chapter.md',
      expectedText: 'old',
      proposedText: 'new',
      isCurrent: () => current,
      async compareAndWrite(expectedText, proposedText) {
        expect(expectedText).toBe('old');
        expect(proposedText).toBe('new');
        current = false;
        await writeGate.promise;
        return 'written' as const;
      },
      markConflict: vi.fn(),
      markAccepted,
    });

    writeGate.resolve();

    await expect(applying).resolves.toBe('stale');
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('conditionally writes the captured original value before marking Apply accepted', async () => {
    const compareAndWrite = vi.fn(async () => 'written' as const);
    const markAccepted = vi.fn();

    const result = await applyFileIfCurrent({
      token: { id: 1, projectDir: '/A' },
      sourceProjectDir: '/A',
      filePath: '/A/chapter.md',
      expectedText: 'captured original',
      proposedText: 'new',
      isCurrent: () => true,
      compareAndWrite,
      markConflict: vi.fn(),
      markAccepted,
    });

    expect(result).toBe('accepted');
    expect(compareAndWrite).toHaveBeenCalledWith('captured original', 'new');
    expect(markAccepted).toHaveBeenCalledTimes(1);
  });

  it('marks backend compare-and-write conflict and never accepts the Apply card', async () => {
    const markConflict = vi.fn();
    const markAccepted = vi.fn();

    const result = await applyFileIfCurrent({
      token: { id: 1, projectDir: '/A' },
      sourceProjectDir: '/A',
      filePath: '/A/chapter.md',
      expectedText: 'captured original',
      proposedText: 'new',
      isCurrent: () => true,
      compareAndWrite: async () => 'conflict',
      markConflict,
      markAccepted,
    });

    expect(result).toBe('conflict');
    expect(markConflict).toHaveBeenCalledWith('File changed since proposal was generated.');
    expect(markAccepted).not.toHaveBeenCalled();
  });

  it('stops Apply All before the next file when its source token is stale', async () => {
    let current = true;
    const writes: string[] = [];
    const token = { id: 1, projectDir: '/A' };
    const files = ['/A/one.md', '/A/two.md'];

    for (const filePath of files) {
      if (!current) break;
      const result = await applyFileIfCurrent({
        token,
        sourceProjectDir: '/A',
        filePath,
        expectedText: 'old',
        proposedText: filePath,
        isCurrent: () => current,
        async compareAndWrite(_expectedLatest, text) {
          writes.push(text);
          current = false;
          return 'written' as const;
        },
        markConflict: vi.fn(),
        markAccepted: vi.fn(),
      });
      if (result === 'stale') break;
    }

    expect(writes).toEqual(['/A/one.md']);
  });

  it('serializes persistence operations for the same project session', async () => {
    const queue = createAiSessionPersistenceQueue();
    const firstGate = deferred();
    const firstStarted = deferred();
    const events: string[] = [];

    const first = queue.enqueue('/A', 'session-1', async () => {
      events.push('first-start');
      firstStarted.resolve();
      await firstGate.promise;
      events.push('first-end');
    });
    const second = queue.enqueue('/A', 'session-1', async () => {
      events.push('second');
    });

    await firstStarted.promise;
    expect(events).toEqual(['first-start']);
    firstGate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('continues queued persistence after failure without hiding the failed caller error', async () => {
    const queue = createAiSessionPersistenceQueue();
    const events: string[] = [];

    const failed = queue.enqueue('/A', 'session-1', async () => {
      events.push('failed');
      throw new Error('disk full');
    });
    const next = queue.enqueue('/A', 'session-1', async () => {
      events.push('next');
    });

    await expect(failed).rejects.toThrow('disk full');
    await expect(next).resolves.toBeUndefined();
    expect(events).toEqual(['failed', 'next']);
  });

  it('does not block persistence for a different project session', async () => {
    const queue = createAiSessionPersistenceQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const blocked = queue.enqueue('/A', 'session-1', async () => {
      events.push('blocked');
      await firstGate.promise;
    });
    const independent = queue.enqueue('/B', 'session-1', async () => {
      events.push('independent');
    });

    await independent;
    expect(events).toEqual(['blocked', 'independent']);
    firstGate.resolve();
    await blocked;
  });

  it('closes persistence fail-closed while draining every accepted operation', async () => {
    const queue = createAiSessionPersistenceQueue();
    const operationGate = deferred();
    const operationStarted = deferred();
    const lateOperation = vi.fn().mockResolvedValue(undefined);
    const accepted = queue.enqueue('/A', 'session-1', async () => {
      operationStarted.resolve();
      await operationGate.promise;
    });
    await operationStarted.promise;

    const drained = queue.closeAndDrain();
    const rejected = queue.enqueue('/A', 'session-2', lateOperation);

    await expect(rejected).rejects.toBeInstanceOf(AiSessionPersistenceQueueClosedError);
    expect(lateOperation).not.toHaveBeenCalled();
    operationGate.resolve();
    await expect(accepted).resolves.toBeUndefined();
    await expect(drained).resolves.toBeUndefined();
  });

  it('settles persistence drain even when an accepted operation rejects', async () => {
    const queue = createAiSessionPersistenceQueue();
    const failed = queue.enqueue('/A', 'session-1', async () => {
      throw new Error('accepted write failed');
    });
    void failed.catch(() => undefined);

    await expect(queue.closeAndDrain()).resolves.toBeUndefined();
    await expect(failed).rejects.toThrow('accepted write failed');
  });

  it('serializes mount leases and settles a rejected retirement for successors', async () => {
    const first = acquireAiAgentMountLease();
    const second = acquireAiAgentMountLease();
    let predecessorSettled = false;
    void second.predecessor.then(() => { predecessorSettled = true; });
    await Promise.resolve();

    expect(second.id).toBeGreaterThan(first.id);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);
    expect(predecessorSettled).toBe(false);

    expect(first.retire(Promise.reject(new Error('old teardown failed')))).toBe(true);
    await expect(second.predecessor).resolves.toBeUndefined();
    expect(second.isCurrent()).toBe(true);
    expect(first.retire(Promise.resolve())).toBe(false);

    const third = acquireAiAgentMountLease();
    const secondRetirement = deferred();
    expect(second.retire(secondRetirement.promise)).toBe(true);
    let thirdReady = false;
    void third.predecessor.then(() => { thirdReady = true; });
    await Promise.resolve();
    expect(thirdReady).toBe(false);
    secondRetirement.resolve();
    await third.predecessor;
    expect(third.isCurrent()).toBe(true);
    expect(third.retire(Promise.resolve())).toBe(true);
  });
});
