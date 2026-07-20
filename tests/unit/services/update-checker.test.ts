import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/stores/updater-state.svelte', () => {
  const store = {
    phase: 'idle' as string,
    version: null as string | null,
    notes: null as string | null,
    setAvailable: vi.fn((v: string, n: string | null) => {
      store.phase = 'available';
      store.version = v;
      store.notes = n;
    }),
    reset: vi.fn(() => {
      store.phase = 'idle';
      store.version = null;
      store.notes = null;
    }),
  };
  return { updaterState: store };
});

import { updaterState } from '$lib/stores/updater-state.svelte';
import {
  runUpdateCheck,
  __setUpdateCheckerHooksForTests,
  __resetUpdateCheckerForTests,
  __currentUpdateCheckStateForTests,
  __currentInflightTokenForTests,
  takeLastAvailableHandle,
  SKIPPED_VERSION_KEY,
  type UpdaterPluginCheck,
} from '$lib/services/update-checker';

type StoreShape = {
  phase: string;
  version: string | null;
  notes: string | null;
  setAvailable: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
const store = updaterState as unknown as StoreShape;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetUpdateCheckerForTests();
  store.phase = 'idle';
  store.version = null;
  store.notes = null;
  store.setAvailable.mockClear();
  store.reset.mockClear();
});

describe('[contract] runUpdateCheck — startup available', () => {
  it('startup outcome available projects into updaterState exactly once and preserves handle', async () => {
    const handle = { downloadAndInstall: vi.fn() };
    const pluginCheck = vi.fn(async () => ({ version: '0.4.0', body: 'notes', handle })) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome).toEqual({ kind: 'available', version: '0.4.0', notes: 'notes', handle });
    expect(store.setAvailable).toHaveBeenCalledTimes(1);
    expect(store.setAvailable).toHaveBeenCalledWith('0.4.0', 'notes');
    expect(pluginCheck).toHaveBeenCalledTimes(1);
    // Reducer resets to idle after terminal completion so a manual retry
    // can allocate a fresh token.
    expect(__currentUpdateCheckStateForTests().phase).toBe('idle');
  });

  it('startup + manual overlap share one plugin call and one state transition', async () => {
    const gate = deferred<{ version: string; body: string | null; handle: unknown }>();
    const pluginCheck = vi.fn(() => gate.promise) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    // Yield so p1 has time to allocate token & register inflight.
    await Promise.resolve();
    await Promise.resolve();
    const p2 = runUpdateCheck({ startup: false });

    const inflightToken = __currentInflightTokenForTests();
    expect(inflightToken).not.toBeNull();

    gate.resolve({ version: '0.4.0', body: 'r', handle: { id: 'h1' } });

    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toEqual(o2);
    expect(o1.kind).toBe('available');
    expect(pluginCheck).toHaveBeenCalledTimes(1);
    expect(store.setAvailable).toHaveBeenCalledTimes(1);
  });
});

describe('[contract] runUpdateCheck — portable', () => {
  it('portable mode does NOT import the updater plugin and returns unsupported', async () => {
    const loadPluginCheck = vi.fn(async () => {
      throw new Error('plugin should never be loaded in portable mode');
    });
    __setUpdateCheckerHooksForTests({
      isPortable: async () => true,
      getSkippedVersion: () => null,
      loadPluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome).toEqual({ kind: 'unsupported' });
    expect(loadPluginCheck).not.toHaveBeenCalled();
    expect(store.setAvailable).not.toHaveBeenCalled();
    expect(__currentUpdateCheckStateForTests().phase).toBe('idle');
  });

  it('portable mode stays silent on the manual path as well', async () => {
    const loadPluginCheck = vi.fn();
    __setUpdateCheckerHooksForTests({
      isPortable: async () => true,
      getSkippedVersion: () => null,
      loadPluginCheck: loadPluginCheck as unknown as CheckerLoad,
    });
    const outcome = await runUpdateCheck({ startup: false });
    expect(outcome).toEqual({ kind: 'unsupported' });
    expect(loadPluginCheck).not.toHaveBeenCalled();
  });
});

type CheckerLoad = () => Promise<UpdaterPluginCheck>;

describe('[contract] runUpdateCheck — skipped', () => {
  it('exact skipped version returns silent skipped outcome and never populates banner', async () => {
    const pluginCheck = vi.fn(async () => ({ version: '0.4.0', body: 'x', handle: { id: 'h' } })) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => '0.4.0',
      loadPluginCheck: async () => pluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome).toEqual({ kind: 'skipped', version: '0.4.0' });
    expect(store.setAvailable).not.toHaveBeenCalled();
  });

  it('non-matching skipped version yields available', async () => {
    const pluginCheck = vi.fn(async () => ({ version: '0.4.1', body: null, handle: {} })) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => '0.4.0',
      loadPluginCheck: async () => pluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome.kind).toBe('available');
    expect(store.setAvailable).toHaveBeenCalledTimes(1);
  });
});

describe('[contract] runUpdateCheck — no-update', () => {
  it('null plugin result returns no-update and does not touch updaterState.setAvailable', async () => {
    const pluginCheck = vi.fn(async () => null) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome).toEqual({ kind: 'no-update' });
    expect(store.setAvailable).not.toHaveBeenCalled();
  });
});

describe('[contract] runUpdateCheck — failure and retry', () => {
  it('startup plugin load failure does not crash startup and resets to idle for later retry', async () => {
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => { throw new Error('load boom'); },
    });

    const outcome = await runUpdateCheck({ startup: true });
    expect(outcome).toEqual({ kind: 'failed', error: 'load boom' });
    expect(__currentUpdateCheckStateForTests().phase).toBe('idle');
  });

  it('transient plugin check failure then manual retry allocates a fresh token and calls plugin again', async () => {
    let attempt = 0;
    const pluginCheck = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('net down');
      return null;
    }) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const first = await runUpdateCheck({ startup: true });
    expect(first).toEqual({ kind: 'failed', error: 'net down' });

    const second = await runUpdateCheck({ startup: false });
    expect(second).toEqual({ kind: 'no-update' });
    expect(pluginCheck).toHaveBeenCalledTimes(2);
  });
});

describe('[contract] runUpdateCheck — dedupe and token discipline', () => {
  it('does not allocate a second request token while a check is in flight', async () => {
    const gate = deferred<null>();
    const pluginCheck = vi.fn(() => gate.promise) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    await Promise.resolve();
    await Promise.resolve();
    const tokenAfterFirst = __currentInflightTokenForTests();
    const p2 = runUpdateCheck({ startup: false });
    const tokenAfterSecond = __currentInflightTokenForTests();

    expect(tokenAfterFirst).not.toBeNull();
    expect(tokenAfterFirst?.id).toBe(tokenAfterSecond?.id);

    gate.resolve(null);
    await Promise.all([p1, p2]);
    expect(pluginCheck).toHaveBeenCalledTimes(1);
  });

  it('stale completion after a fresh token is a no-op — available fires exactly once', async () => {
    const first = deferred<null>();
    const second = deferred<{ version: string; body: string; handle: unknown }>();
    let call = 0;
    const pluginCheck = vi.fn(() => {
      call += 1;
      if (call === 1) return first.promise;
      return second.promise;
    }) as unknown as UpdaterPluginCheck;

    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    await Promise.resolve();
    await Promise.resolve();
    first.resolve(null);
    await p1;

    const p2 = runUpdateCheck({ startup: false });
    await Promise.resolve();
    await Promise.resolve();
    second.resolve({ version: '0.4.0', body: 'body', handle: { id: 'h2' } });
    const outcome2 = await p2;

    expect(outcome2.kind).toBe('available');
    expect(store.setAvailable).toHaveBeenCalledTimes(1);
  });

  it('an available update projects to the store exactly once even under overlap', async () => {
    const gate = deferred<{ version: string; body: string | null; handle: unknown }>();
    const pluginCheck = vi.fn(() => gate.promise) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    await Promise.resolve();
    const p2 = runUpdateCheck({ startup: false });
    const p3 = runUpdateCheck({ startup: false });
    gate.resolve({ version: '0.5.0', body: 'n', handle: { id: 'h3' } });
    await Promise.all([p1, p2, p3]);

    expect(store.setAvailable).toHaveBeenCalledTimes(1);
  });
});

describe('[contract] takeLastAvailableHandle', () => {
  it('returns the handle from the most recent available outcome and clears it after read', async () => {
    const handle = { downloadAndInstall: vi.fn() };
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => (async () => ({ version: '0.4.0', body: null, handle })) as unknown as UpdaterPluginCheck,
    });

    await runUpdateCheck({ startup: true });
    expect(takeLastAvailableHandle()).toBe(handle);
    expect(takeLastAvailableHandle()).toBeNull();
  });
});

describe('[contract] SKIPPED_VERSION_KEY constant', () => {
  it('matches the established localStorage key', () => {
    expect(SKIPPED_VERSION_KEY).toBe('novelist-skipped-update-version');
  });
});

describe('[contract] portable eligibility fails closed', () => {
  it('portable detection failure returns failed and never imports the plugin', async () => {
    const loadPluginCheck = vi.fn(async () => (async () => null) as unknown as UpdaterPluginCheck);
    __setUpdateCheckerHooksForTests({
      isPortable: async () => { throw new Error('ipc down'); },
      getSkippedVersion: () => null,
      loadPluginCheck,
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.error).toBe('ipc down');
    expect(loadPluginCheck).not.toHaveBeenCalled();
    expect(store.setAvailable).not.toHaveBeenCalled();
    expect(__currentUpdateCheckStateForTests().phase).toBe('idle');
    expect(__currentInflightTokenForTests()).toBeNull();
  });

  it('portable detection failure is followed by a successful manual retry that calls plugin once', async () => {
    let portableCalls = 0;
    const pluginCheck = vi.fn(async () => null) as unknown as UpdaterPluginCheck;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => {
        portableCalls += 1;
        if (portableCalls === 1) throw new Error('ipc temporarily unavailable');
        return false;
      },
      getSkippedVersion: () => null,
      loadPluginCheck: async () => pluginCheck,
    });

    const first = await runUpdateCheck({ startup: true });
    expect(first.kind).toBe('failed');

    const second = await runUpdateCheck({ startup: false });
    expect(second).toEqual({ kind: 'no-update' });
    expect(pluginCheck).toHaveBeenCalledTimes(1);
  });
});

describe('[contract] deferred eligibility dedupes overlapping callers', () => {
  it('two concurrent runUpdateCheck calls await the same portable detection and issue one plugin check', async () => {
    const portableGate = deferred<boolean>();
    const pluginCheck = vi.fn(async () => null) as unknown as UpdaterPluginCheck;
    const loadPluginCheck = vi.fn(async () => pluginCheck);

    __setUpdateCheckerHooksForTests({
      isPortable: () => portableGate.promise,
      getSkippedVersion: () => null,
      loadPluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    await Promise.resolve();
    const p2 = runUpdateCheck({ startup: false });
    const p3 = runUpdateCheck({ startup: false });

    portableGate.resolve(false);
    const results = await Promise.all([p1, p2, p3]);

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(pluginCheck).toHaveBeenCalledTimes(1);
    expect(loadPluginCheck).toHaveBeenCalledTimes(1);
  });

  it('overlap during portable=true still issues zero plugin calls and returns unsupported to all', async () => {
    const portableGate = deferred<boolean>();
    const loadPluginCheck = vi.fn(async () => (async () => null) as unknown as UpdaterPluginCheck);

    __setUpdateCheckerHooksForTests({
      isPortable: () => portableGate.promise,
      getSkippedVersion: () => null,
      loadPluginCheck,
    });

    const p1 = runUpdateCheck({ startup: true });
    await Promise.resolve();
    const p2 = runUpdateCheck({ startup: false });
    portableGate.resolve(true);
    const [o1, o2] = await Promise.all([p1, p2]);

    expect(o1).toEqual({ kind: 'unsupported' });
    expect(o2).toEqual({ kind: 'unsupported' });
    expect(loadPluginCheck).not.toHaveBeenCalled();
  });
});

describe('[contract] lastAvailableHandle hygiene', () => {
  it('is cleared when a subsequent no-update outcome follows an available outcome', async () => {
    const handle = { downloadAndInstall: vi.fn() };
    let call = 0;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => (async () => {
        call += 1;
        if (call === 1) return { version: '0.4.0', body: null, handle };
        return null;
      }) as unknown as UpdaterPluginCheck,
    });

    await runUpdateCheck({ startup: true });
    await runUpdateCheck({ startup: false });

    expect(takeLastAvailableHandle()).toBeNull();
  });

  it('is cleared when a subsequent skipped outcome follows an available outcome', async () => {
    let call = 0;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => call === 1 ? null : '0.4.1',
      loadPluginCheck: async () => (async () => {
        call += 1;
        if (call === 1) return { version: '0.4.0', body: null, handle: { id: 'h1' } };
        return { version: '0.4.1', body: null, handle: { id: 'h2' } };
      }) as unknown as UpdaterPluginCheck,
    });

    await runUpdateCheck({ startup: true });
    await runUpdateCheck({ startup: false });

    expect(takeLastAvailableHandle()).toBeNull();
  });

  it('is cleared when a subsequent failure follows an available outcome', async () => {
    let call = 0;
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => (async () => {
        call += 1;
        if (call === 1) return { version: '0.4.0', body: null, handle: { id: 'h1' } };
        throw new Error('boom');
      }) as unknown as UpdaterPluginCheck,
    });

    await runUpdateCheck({ startup: true });
    await runUpdateCheck({ startup: false });

    expect(takeLastAvailableHandle()).toBeNull();
  });

  it('is cleared on portable outcome', async () => {
    __setUpdateCheckerHooksForTests({
      isPortable: async () => true,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => (async () => null) as unknown as UpdaterPluginCheck,
    });
    await runUpdateCheck({ startup: true });
    expect(takeLastAvailableHandle()).toBeNull();
  });
});

describe('[contract] bounded error logging', () => {
  it('truncates a very long error message before dispatch', async () => {
    const huge = 'x'.repeat(5000);
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => { throw new Error(huge); },
    });

    const outcome = await runUpdateCheck({ startup: true });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.length).toBeLessThanOrEqual(201);
      expect(outcome.error.endsWith('…')).toBe(true);
    }
  });

  it('redacts query-style secrets from the logged error', async () => {
    __setUpdateCheckerHooksForTests({
      isPortable: async () => false,
      getSkippedVersion: () => null,
      loadPluginCheck: async () => { throw new Error('GET https://api.example.com/x?token=abc123secret&other=z 500'); },
    });
    const outcome = await runUpdateCheck({ startup: true });
    if (outcome.kind === 'failed') {
      expect(outcome.error).toContain('<redacted>');
      expect(outcome.error).not.toContain('abc123secret');
    }
  });
});
