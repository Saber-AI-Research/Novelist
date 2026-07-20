import { afterEach, describe, expect, it, vi } from 'vitest';

import nativeSmokeSource from '../e2e/native/run-native-smoke.mjs?raw';
import * as nativeRunSupport from '../e2e/native/native-run-support.mjs';
import { NATIVE_FIXTURE_TIMEOUT_MS, NATIVE_WORKFLOW_TIMEOUT_MS } from '../e2e/native/native-timeouts';

type FakeChildListener = (...args: unknown[]) => void;

class FakeChild {
  readonly pid: number;
  readonly signals: string[] = [];
  private readonly listeners = new Map<string, Set<FakeChildListener>>();

  constructor(pid = 4_242) {
    this.pid = pid;
  }

  once(event: string, listener: FakeChildListener): this {
    const eventListeners = this.listeners.get(event) ?? new Set<FakeChildListener>();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  off(event: string, listener: FakeChildListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    const eventListeners = [...(this.listeners.get(event) ?? [])];
    this.listeners.delete(event);
    for (const listener of eventListeners) listener(...args);
  }

  kill(signal: string | number = 'SIGTERM'): boolean {
    this.signals.push(String(signal));
    return true;
  }
}

function waitForChild(
  child: FakeChild,
  options: {
    timeoutMs: number;
    termGraceMs: number;
    killGraceMs: number;
    signalProcessGroup?: (pid: number, signal: string | number) => boolean;
  },
) {
  expect(nativeRunSupport.waitForPlaywrightChild).toBeTypeOf('function');
  return nativeRunSupport.waitForPlaywrightChild(child, options);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('native Playwright child watchdog', () => {
  it('preserves a clean natural child exit when the detached group is absent', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    const resultPromise = waitForChild(child, {
      timeoutMs: 100,
      termGraceMs: 20,
      killGraceMs: 10,
      signalProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
        throw Object.assign(new Error('process group absent'), { code: 'ESRCH' });
      },
    });

    child.emit('exit', 0, null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      reason: 'exit code 0',
      timedOut: false,
    });
    expect(groupSignals).toEqual([{ pid: -4_242, signal: 0 }]);
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates surviving descendants after a natural leader exit and returns failure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    let probes = 0;
    const resultPromise = waitForChild(child, {
      timeoutMs: 100,
      termGraceMs: 20,
      killGraceMs: 10,
      signalProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
        if (signal === 0) {
          probes += 1;
          if (probes === 2) throw Object.assign(new Error('process group absent'), { code: 'ESRCH' });
        }
        return true;
      },
    });

    child.emit('exit', 0, null);
    expect(groupSignals).toEqual([
      { pid: -4_242, signal: 0 },
      { pid: -4_242, signal: 'SIGTERM' },
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(groupSignals.at(-1)).toEqual({ pid: -4_242, signal: 'SIGKILL' });
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({ exitCode: 1, timedOut: false });
    expect(groupSignals).toEqual([
      { pid: -4_242, signal: 0 },
      { pid: -4_242, signal: 'SIGTERM' },
      { pid: -4_242, signal: 'SIGKILL' },
      { pid: -4_242, signal: 0 },
    ]);
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the process group after the direct child exits during timeout cleanup', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    const resultPromise = waitForChild(child, {
      timeoutMs: 100,
      termGraceMs: 20,
      killGraceMs: 10,
      signalProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
        if (signal === 0)
          throw Object.assign(new Error('process group absent'), {
            code: 'ESRCH',
          });
        return true;
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(groupSignals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
    child.emit('exit', null, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(20);
    expect(groupSignals).toEqual([
      { pid: -4_242, signal: 'SIGTERM' },
      { pid: -4_242, signal: 'SIGKILL' },
    ]);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      timedOut: true,
    });
    expect(groupSignals).toEqual([
      { pid: -4_242, signal: 'SIGTERM' },
      { pid: -4_242, signal: 'SIGKILL' },
      { pid: -4_242, signal: 0 },
    ]);
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('escalates the process group to KILL and checks residue after bounded grace', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    const resultPromise = waitForChild(child, {
      timeoutMs: 100,
      termGraceMs: 20,
      killGraceMs: 10,
      signalProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
        if (signal === 0)
          throw Object.assign(new Error('process group absent'), {
            code: 'ESRCH',
          });
        return true;
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      timedOut: true,
    });
    expect(groupSignals).toEqual([
      { pid: -4_242, signal: 'SIGTERM' },
      { pid: -4_242, signal: 'SIGKILL' },
      { pid: -4_242, signal: 0 },
    ]);
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats ESRCH while signaling TERM as an already absent process group', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const groupSignals: Array<{ pid: number; signal: string | number }> = [];
    const resultPromise = waitForChild(child, {
      timeoutMs: 100,
      termGraceMs: 20,
      killGraceMs: 10,
      signalProcessGroup: (pid, signal) => {
        groupSignals.push({ pid, signal });
        throw Object.assign(new Error('process group absent'), {
          code: 'ESRCH',
        });
      },
    });

    await vi.advanceTimersByTimeAsync(130);

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 1,
      timedOut: true,
    });
    expect(groupSignals).toEqual([{ pid: -4_242, signal: 'SIGTERM' }]);
    expect(child.signals).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a non-positive Playwright process-group leader PID', () => {
    vi.useFakeTimers();
    const child = new FakeChild(0);

    expect(() =>
      waitForChild(child, {
        timeoutMs: 100,
        termGraceMs: 20,
        killGraceMs: 10,
        signalProcessGroup: () => true,
      }),
    ).toThrow('positive PID');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts lifecycle monitoring immediately and forwards wrapper signals to the process group', () => {
    const spawn = nativeSmokeSource.indexOf('const child = spawn(');
    const waitCreation = nativeSmokeSource.indexOf('const childResultPromise = waitForPlaywrightChild(child);', spawn);
    const interactiveSetup = nativeSmokeSource.indexOf('if (interactiveEnvironment)', spawn);
    const waitConsumption = nativeSmokeSource.indexOf('await childResultPromise;', waitCreation);

    expect(waitCreation).toBeGreaterThan(spawn);
    expect(waitCreation).toBeLessThan(interactiveSetup);
    expect(waitConsumption).toBeGreaterThan(interactiveSetup);
    expect(nativeSmokeSource).toContain("process.kill(-child.pid, 'SIGTERM')");
    expect(nativeSmokeSource).not.toContain("const forwardSignal = () => child.kill('SIGTERM')");
  });

  it('removes wrapper signal listeners immediately after the child promise settles', () => {
    const settled = nativeSmokeSource.indexOf('await childResultPromise;');
    const removeSigint = nativeSmokeSource.indexOf("process.off('SIGINT', forwardSignal);", settled);
    const removeSigterm = nativeSmokeSource.indexOf("process.off('SIGTERM', forwardSignal);", settled);
    const cleanup = nativeSmokeSource.indexOf('const cleanupErrors = [];', settled);

    expect(settled).toBeGreaterThan(-1);
    expect(removeSigint).toBeGreaterThan(settled);
    expect(removeSigterm).toBeGreaterThan(removeSigint);
    expect(removeSigterm).toBeLessThan(cleanup);
  });

  it('spawns Playwright as a detached process-group leader', () => {
    expect(nativeSmokeSource).toMatch(/const child = spawn\([\s\S]*?detached: true,[\s\S]*?stdio: 'inherit'/);
  });

  it('adds every compliant child budget before starting the parent watchdog', () => {
    expect({
      fixture: NATIVE_FIXTURE_TIMEOUT_MS,
      workflow: NATIVE_WORKFLOW_TIMEOUT_MS,
      fixtureTeardown: nativeRunSupport.NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS,
      reportExitBuffer: nativeRunSupport.PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS,
      parent: nativeRunSupport.PLAYWRIGHT_CHILD_TIMEOUT_MS,
    }).toEqual({
      fixture: 480_000,
      workflow: 120_000,
      fixtureTeardown: 30_000,
      reportExitBuffer: 15_000,
      parent: 645_000,
    });
    expect(nativeRunSupport.PLAYWRIGHT_CHILD_TIMEOUT_MS).toBe(
      NATIVE_FIXTURE_TIMEOUT_MS +
        NATIVE_WORKFLOW_TIMEOUT_MS +
        nativeRunSupport.NATIVE_FIXTURE_TEARDOWN_TIMEOUT_MS +
        nativeRunSupport.PLAYWRIGHT_CHILD_REPORT_EXIT_BUFFER_MS,
    );
    expect(nativeRunSupport.PLAYWRIGHT_CHILD_TERM_GRACE_MS).toBe(10_000);
    expect(nativeRunSupport.PLAYWRIGHT_CHILD_KILL_GRACE_MS).toBe(5_000);
  });

  it('routes watchdog failure through the wrapper cleanup and evidence path', () => {
    const spawn = nativeSmokeSource.indexOf('const child = spawn(');
    const wait = nativeSmokeSource.indexOf('const childResultPromise = waitForPlaywrightChild(child);');
    const consume = nativeSmokeSource.indexOf('await childResultPromise;', wait);
    const cleanup = nativeSmokeSource.indexOf('const cleanupErrors = [];', consume);

    expect(wait).toBeGreaterThan(spawn);
    expect(consume).toBeGreaterThan(wait);
    expect(cleanup).toBeGreaterThan(consume);
    expect(nativeSmokeSource).toContain('childExitCode = childResult.exitCode;');
    expect(nativeSmokeSource).toContain('childExitReason = childResult.reason;');
    expect(nativeSmokeSource).toContain('`playwright_exit_reason=${JSON.stringify(childExitReason)}`');
  });
});
