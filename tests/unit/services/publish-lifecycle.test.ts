import { describe, expect, it } from 'vitest';
import type { RemoteIdentity } from '$lib/ipc/commands';

const ghostRemote: RemoteIdentity = {
  post_id: 'g1',
  url: 'https://ghost.example.com/g1/',
  revision: '2026-07-17T00:00:00.000Z',
  provider_revision: {
    provider: 'ghost',
    updated_at: '2026-07-17T00:00:00.000Z',
  },
  capability: { kind: 'updatable' },
};

describe('[contract] publish lifecycle planning', () => {
  it('creates only when no durable identity exists', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    expect(planPublishAttempt('ghost', null, { kind: 'default' })).toEqual({
      state: 'new',
      request: 'create',
    });
  });

  it('blocks every publish intent while remote identity is unknown', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    const unknown = { kind: 'unknown', phase: 'failed' } as const;

    expect(planPublishAttempt('ghost', unknown, { kind: 'default' })).toEqual({
      state: 'unknown',
      request: 'blocked',
    });
    expect(
      planPublishAttempt('ghost', unknown, { kind: 'new_copy', confirmed: true }),
    ).toEqual({ state: 'unknown', request: 'blocked' });
  });

  it('preserves prior knowledge only when retrying the same remote-state owner', async () => {
    const { beginPublishRemoteRead } = await import('$lib/services/publish-lifecycle');

    expect(beginPublishRemoteRead(ghostRemote, true)).toEqual({
      kind: 'unknown',
      phase: 'loading',
      previous: { remote: ghostRemote },
    });
    expect(beginPublishRemoteRead(null, true)).toEqual({
      kind: 'unknown',
      phase: 'loading',
      previous: { remote: null },
    });
    expect(beginPublishRemoteRead(ghostRemote, false)).toEqual({
      kind: 'unknown',
      phase: 'loading',
    });
  });

  it('preserves the same prior identity across repeated failed retries', async () => {
    const {
      beginPublishRemoteRead,
      failPublishRemoteRead,
    } = await import('$lib/services/publish-lifecycle');

    const firstFailure = failPublishRemoteRead(beginPublishRemoteRead(ghostRemote, true));
    expect(firstFailure).toEqual({
      kind: 'unknown',
      phase: 'failed',
      previous: { remote: ghostRemote },
    });
    expect(failPublishRemoteRead(beginPublishRemoteRead(firstFailure, true))).toEqual(
      firstFailure,
    );
  });

  it('updates only when durable capability is updatable and preserves typed revision', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    expect(planPublishAttempt('ghost', ghostRemote, { kind: 'default' })).toEqual({
      state: 'updating',
      request: 'update',
      updateTarget: {
        remote_id: 'g1',
        expected_revision: {
          provider: 'ghost',
          updated_at: '2026-07-17T00:00:00.000Z',
        },
      },
    });
  });

  it('uses legacy flat revision only when typed revision is absent', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    const legacy: RemoteIdentity = {
      post_id: '42',
      revision: '2026-07-17T09:00:00',
      capability: { kind: 'updatable' },
    };
    const plan = planPublishAttempt('wordpress_self_hosted', legacy, { kind: 'default' });
    expect(plan.request).toBe('update');
    if (plan.request !== 'update') throw new Error('expected update plan');
    expect(plan.updateTarget).toEqual({
      remote_id: '42',
      expected_revision: {
        provider: 'wordpress',
        modified: '2026-07-17T09:00:00',
        modified_gmt: null,
      },
    });
  });

  it('treats revision without capability as corrupt instead of updateable', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    const corrupt: RemoteIdentity = {
      post_id: 'g1',
      revision: '2026-07-17T00:00:00.000Z',
    };
    expect(planPublishAttempt('ghost', corrupt, { kind: 'default' })).toEqual({
      state: 'corrupt',
      request: 'blocked',
    });
  });

  it('blocks tracked Medium by default and creates only after confirmed New Copy', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    const medium: RemoteIdentity = {
      post_id: 'm1',
      url: 'https://medium.com/@author/m1',
      capability: {
        kind: 'unsupported_update',
        data: { reason: 'create_only_api' },
      },
    };
    expect(planPublishAttempt('medium', medium, { kind: 'default' })).toEqual({
      state: 'unsupported',
      request: 'blocked',
    });
    expect(
      planPublishAttempt('medium', medium, { kind: 'new_copy', confirmed: false }),
    ).toEqual({ state: 'unsupported', request: 'blocked' });
    expect(
      planPublishAttempt('medium', medium, { kind: 'new_copy', confirmed: true }),
    ).toEqual({ state: 'new', request: 'create' });
  });

  it('requires explicit overwrite confirmation and uses authoritative conflict revision', async () => {
    const { planPublishAttempt } = await import('$lib/services/publish-lifecycle');
    const actual = { provider: 'ghost' as const, updated_at: 'server-revision' };
    expect(
      planPublishAttempt('ghost', ghostRemote, {
        kind: 'overwrite',
        confirmed: false,
        revision: actual,
      }),
    ).toEqual({ state: 'conflict', request: 'blocked' });
    const plan = planPublishAttempt('ghost', ghostRemote, {
      kind: 'overwrite',
      confirmed: true,
      revision: actual,
    });
    expect(plan.request).toBe('update');
    if (plan.request !== 'update') throw new Error('expected update plan');
    expect(plan.updateTarget).toEqual({ remote_id: 'g1', expected_revision: actual });
  });
});

describe('[contract] publish typed error classification', () => {
  it('classifies conflict and not-found JSON without exposing raw provider data', async () => {
    const { classifyPublishError } = await import('$lib/services/publish-lifecycle');
    expect(
      classifyPublishError(
        JSON.stringify({
          kind: 'update_conflict',
          data: {
            provider: 'ghost',
            remote_id: 'g1',
            expected: { provider: 'ghost', updated_at: 'old' },
            actual: { provider: 'ghost', updated_at: 'new' },
          },
        }),
      ),
    ).toEqual({
      state: 'conflict',
      remoteId: 'g1',
      actualRevision: { provider: 'ghost', updated_at: 'new' },
    });
    expect(
      classifyPublishError(
        JSON.stringify({
          kind: 'remote_not_found',
          data: { provider: 'ghost', remote_id: 'g1' },
        }),
      ),
    ).toEqual({ state: 'not_found', remoteId: 'g1' });
  });

  it('falls back to a generic safe message for malformed command errors', async () => {
    const { classifyPublishError } = await import('$lib/services/publish-lifecycle');
    expect(classifyPublishError('not-json')).toEqual({
      state: 'error',
      message: 'Publish failed.',
    });
  });
});
