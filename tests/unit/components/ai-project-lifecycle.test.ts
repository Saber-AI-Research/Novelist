import { describe, expect, it, vi } from 'vitest';
import {
  AiProjectLifecycle,
  type AiProjectToken,
} from '$lib/components/ai-shared/project-lifecycle';

describe('[contract] AI project lifecycle', () => {
  it('tears down project A before loading project B and makes A tokens stale immediately', async () => {
    const events: string[] = [];
    let tokenA!: AiProjectToken;
    const teardownGate = Promise.withResolvers<void>();
    const lifecycle = new AiProjectLifecycle({
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
    expect(lifecycle.status.projectDir).toBe('/B');
  });

  it('invalidates A immediately when B is requested while A load is still pending', async () => {
    const loadGate = Promise.withResolvers<void>();
    let tokenA!: AiProjectToken;
    const events: string[] = [];
    const lifecycle = new AiProjectLifecycle({
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
    const lifecycle = new AiProjectLifecycle({
      async teardownProject(ctx) { teardowns.push(ctx.projectDir); },
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) { loads.push(ctx.projectDir); },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo('/B');
    await lifecycle.switchTo('/A');

    expect(loads).toEqual(['/A', '/B', '/A']);
    expect(teardowns).toEqual(['/A', '/B']);
    expect(lifecycle.status.projectDir).toBe('/A');
  });

  it('reloads a ready same-path project only for a new project generation', async () => {
    const loads: Array<string | null> = [];
    const lifecycle = new AiProjectLifecycle({
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
    const loadGate = Promise.withResolvers<void>();
    const loads: Array<string | null> = [];
    const lifecycle = new AiProjectLifecycle({
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

  it('exposes requested and loaded projects separately while a switch is pending', async () => {
    const loadGate = Promise.withResolvers<void>();
    const lifecycle = new AiProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      async loadProject(ctx) {
        if (ctx.projectDir === '/B') await loadGate.promise;
      },
    });

    await lifecycle.switchTo('/A');
    const loadingB = lifecycle.switchTo('/B');

    expect(lifecycle.status.projectDir).toBe('/B');
    expect(lifecycle.loadedProjectDir).toBe('/A');

    loadGate.resolve();
    await loadingB;
    expect(lifecycle.loadedProjectDir).toBe('/B');
  });

  it('keeps destination load failures scoped to the destination and retryable', async () => {
    const failures: string[] = [];
    let failB = true;
    const lifecycle = new AiProjectLifecycle({
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
    expect(failures).toEqual(['/B:B sessions unavailable']);

    failB = false;
    await lifecycle.switchTo('/B');
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: '/B' });
  });

  it('clears loaded project ownership when the project closes', async () => {
    const events: string[] = [];
    const lifecycle = new AiProjectLifecycle({
      async teardownProject(ctx) { events.push(`teardown:${ctx.projectDir}`); },
      clearVolatileContext: (ctx) => events.push(`clear:${ctx.projectDir}`),
      async loadProject(ctx) { events.push(`load:${ctx.projectDir}`); },
    });

    await lifecycle.switchTo('/A');
    await lifecycle.switchTo(null);

    expect(events).toEqual(['clear:/A', 'load:/A', 'teardown:/A', 'clear:null', 'load:null']);
    expect(lifecycle.loadedProjectDir).toBeNull();
    expect(lifecycle.status).toMatchObject({ kind: 'ready', projectDir: null });
  });

  it('tears down a runtime loaded without a project before opening project A', async () => {
    const teardowns: Array<string | null> = [];
    const loads: Array<string | null> = [];
    const lifecycle = new AiProjectLifecycle({
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
    const lifecycle = new AiProjectLifecycle({
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

  it('marks the token observed before a project switch as stale', async () => {
    const lifecycle = new AiProjectLifecycle({
      teardownProject: vi.fn().mockResolvedValue(undefined),
      clearVolatileContext: vi.fn(),
      loadProject: vi.fn().mockResolvedValue(undefined),
    });
    await lifecycle.switchTo('/A');
    const tokenA = lifecycle.status.token;
    expect(lifecycle.isCurrent(tokenA)).toBe(true);

    await lifecycle.switchTo('/B');

    expect(lifecycle.isCurrent(tokenA)).toBe(false);
    expect(lifecycle.isCurrent(lifecycle.status.token)).toBe(true);
  });

  it('loads destination after a caught cancel failure without leaking source state', async () => {
    const events: string[] = [];
    const listeners = new Set(['listener:A']);
    const sourceState = { interrupted: false, persistedTo: null as string | null };
    const lifecycle = new AiProjectLifecycle({
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
});
