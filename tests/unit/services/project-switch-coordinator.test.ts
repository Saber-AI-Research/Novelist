import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetProjectSwitchFlushProvidersForTests,
  flushProjectSwitch,
  registerProjectSwitchFlushProvider,
} from '$lib/services/project-switch-coordinator';

describe('project-switch flush coordinator', () => {
  beforeEach(() => {
    vi.useRealTimers();
    __resetProjectSwitchFlushProvidersForTests();
  });
  afterEach(() => {
    __resetProjectSwitchFlushProvidersForTests();
  });

  it('awaits every registered provider before resolving', async () => {
    const order: string[] = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      order.push(`p1:${previous ?? 'null'}->${next ?? 'null'}:start`);
      await Promise.resolve();
      order.push('p1:end');
    });
    registerProjectSwitchFlushProvider(async () => {
      order.push('p2:start');
      await Promise.resolve();
      order.push('p2:end');
    });

    await flushProjectSwitch('/A', '/B');
    order.push('done');

    expect(order).toContain('p1:/A->/B:start');
    expect(order.indexOf('p1:end')).toBeLessThan(order.indexOf('done'));
    expect(order.indexOf('p2:end')).toBeLessThan(order.indexOf('done'));
  });

  it('unregistering removes the provider', async () => {
    const called = vi.fn();
    const off = registerProjectSwitchFlushProvider(called);
    off();
    await flushProjectSwitch('/A', '/B');
    expect(called).not.toHaveBeenCalled();
  });

  it('one provider rejection surfaces as a thrown error but does not block others', async () => {
    const later = vi.fn().mockResolvedValue(undefined);
    registerProjectSwitchFlushProvider(async () => {
      throw new Error('boom');
    });
    registerProjectSwitchFlushProvider(later);

    await expect(flushProjectSwitch('/A', '/B')).rejects.toThrow('boom');
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('a provider that never resolves is timed out and reported', async () => {
    registerProjectSwitchFlushProvider(() => new Promise(() => {}));

    await expect(flushProjectSwitch('/A', '/B', 5)).rejects.toThrow(/timed out/i);
  });

  it('passes an intentional null destination to providers without substituting previous', async () => {
    const calls: Array<{ previous: string | null; next: string | null }> = [];
    registerProjectSwitchFlushProvider(async (previous, next) => {
      calls.push({ previous, next });
    });

    await flushProjectSwitch('/A', null);
    expect(calls).toEqual([{ previous: '/A', next: null }]);
  });
});
