import { describe, expect, it } from 'vitest';

import { runOwnedPathResidue } from '../e2e/native/native-run-support.mjs';

describe('native run support declarations', () => {
  it('preserves exact residue key types', () => {
    const residue: Record<'socket' | 'runRoot', boolean> = runOwnedPathResidue(
      { socket: '/tmp/run.sock', runRoot: '/tmp/run-root' },
      (ownedPath) => ownedPath.endsWith('.sock'),
    );

    expect(residue).toEqual({ socket: true, runRoot: false });
  });
});
