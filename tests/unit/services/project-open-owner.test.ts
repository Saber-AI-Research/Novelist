import { describe, expect, it } from 'vitest';
import { ProjectOpenOwner } from '$lib/services/project-open-owner';

describe('ProjectOpenOwner', () => {
  it('makes a same-path return authoritative while another project request is pending', () => {
    const owner = new ProjectOpenOwner();

    const b = owner.begin('/B', '/A');
    const a = owner.begin('/A', '/A');

    expect(b).not.toBeNull();
    expect(a).not.toBeNull();
    expect(owner.isCurrent(b!)).toBe(false);
    expect(owner.isCurrent(a!)).toBe(true);

    owner.settle(a!);
    expect(owner.begin('/A', '/A')).toBeNull();
  });

  it('deduplicates an identical in-flight request', () => {
    const owner = new ProjectOpenOwner();
    const first = owner.begin('/B', '/A');

    expect(first).not.toBeNull();
    expect(owner.begin('/B', '/A')).toBeNull();
    expect(owner.isCurrent(first!)).toBe(true);
  });

  it('invalidates a pending project request for a newer non-project intent', async () => {
    const owner = new ProjectOpenOwner();
    const pending = owner.begin('/B', '/A');

    await owner.cancel();

    expect(owner.isCurrent(pending!)).toBe(false);
  });
});
