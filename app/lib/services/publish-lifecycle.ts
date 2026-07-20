import type {
  PlatformConfig,
  ProviderRevision,
  RemoteIdentity,
  UpdateTarget,
} from '$lib/ipc/commands';

export type PublishIntent =
  | { kind: 'default' }
  | { kind: 'new_copy'; confirmed: boolean }
  | { kind: 'overwrite'; confirmed: boolean; revision?: ProviderRevision | null };

export type PublishPlan =
  | { state: 'new'; request: 'create' }
  | { state: 'updating'; request: 'update'; updateTarget: UpdateTarget }
  | { state: 'unknown' | 'conflict' | 'unsupported' | 'corrupt'; request: 'blocked' };

export type UnknownPublishRemoteState = {
  kind: 'unknown';
  phase: 'loading' | 'failed';
  previous?: { remote: RemoteIdentity | null };
};

export type PublishRemoteState = RemoteIdentity | null | UnknownPublishRemoteState;

export type PublishFailure =
  | { state: 'conflict'; remoteId: string; actualRevision?: ProviderRevision }
  | { state: 'not_found'; remoteId: string }
  | { state: 'unsupported' }
  | { state: 'corrupt' }
  | { state: 'error'; message: string };

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPublishRemoteStateUnknown(
  state: PublishRemoteState,
): state is UnknownPublishRemoteState {
  return state !== null && 'kind' in state && state.kind === 'unknown';
}

export function beginPublishRemoteRead(
  current: PublishRemoteState,
  sameOwner: boolean,
): UnknownPublishRemoteState {
  if (!sameOwner) return { kind: 'unknown', phase: 'loading' };
  if (isPublishRemoteStateUnknown(current)) {
    return {
      kind: 'unknown',
      phase: 'loading',
      ...(current.previous ? { previous: current.previous } : {}),
    };
  }
  return {
    kind: 'unknown',
    phase: 'loading',
    previous: { remote: current },
  };
}

export function failPublishRemoteRead(
  current: PublishRemoteState,
): UnknownPublishRemoteState {
  if (isPublishRemoteStateUnknown(current)) return { ...current, phase: 'failed' };
  return {
    kind: 'unknown',
    phase: 'failed',
    previous: { remote: current },
  };
}

function isProviderRevision(value: unknown): value is ProviderRevision {
  if (!value || typeof value !== 'object') return false;
  const revision = value as Record<string, unknown>;
  if (revision.provider === 'ghost') return isNonEmpty(revision.updated_at);
  if (revision.provider !== 'wordpress') return false;
  return isNonEmpty(revision.modified) || isNonEmpty(revision.modified_gmt);
}

function revisionForPlatform(
  platform: PlatformConfig['platform'],
  remote: RemoteIdentity,
): ProviderRevision | null {
  const typed = remote.provider_revision;
  if (typed) {
    if (platform === 'ghost' && typed.provider === 'ghost' && isProviderRevision(typed)) {
      return typed;
    }
    if (
      (platform === 'wordpress_self_hosted' || platform === 'wordpress_com')
      && typed.provider === 'wordpress'
      && isProviderRevision(typed)
    ) {
      return typed;
    }
    return null;
  }
  if (!isNonEmpty(remote.revision)) return null;
  if (platform === 'ghost') {
    return { provider: 'ghost', updated_at: remote.revision };
  }
  if (platform === 'wordpress_self_hosted' || platform === 'wordpress_com') {
    return {
      provider: 'wordpress',
      modified: remote.revision,
      modified_gmt: null,
    };
  }
  return null;
}

export function planPublishAttempt(
  platform: PlatformConfig['platform'],
  remoteState: PublishRemoteState,
  intent: PublishIntent,
): PublishPlan {
  if (isPublishRemoteStateUnknown(remoteState)) {
    return { state: 'unknown', request: 'blocked' };
  }
  const remote = remoteState;
  if (!remote) return { state: 'new', request: 'create' };

  if (intent.kind === 'new_copy') {
    return intent.confirmed
      ? { state: 'new', request: 'create' }
      : {
          state: remote.capability?.kind === 'unsupported_update' ? 'unsupported' : 'corrupt',
          request: 'blocked',
        };
  }

  if (remote.capability?.kind === 'unsupported_update' || platform === 'medium') {
    return { state: 'unsupported', request: 'blocked' };
  }
  if (remote.capability?.kind !== 'updatable') {
    return { state: 'corrupt', request: 'blocked' };
  }

  if (intent.kind === 'overwrite' && !intent.confirmed) {
    return { state: 'conflict', request: 'blocked' };
  }
  const revision = intent.kind === 'overwrite' && intent.revision
    ? intent.revision
    : revisionForPlatform(platform, remote);
  if (!revision || !isProviderRevision(revision)) {
    return { state: 'corrupt', request: 'blocked' };
  }

  return {
    state: 'updating',
    request: 'update',
    updateTarget: {
      remote_id: remote.post_id,
      expected_revision: revision,
    },
  };
}

export function classifyPublishError(error: unknown): PublishFailure {
  const payload = error instanceof Error ? error.message : String(error);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { state: 'error', message: 'Publish failed.' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { state: 'error', message: 'Publish failed.' };
  }
  const typed = parsed as { kind?: unknown; data?: unknown };
  const data = typed.data && typeof typed.data === 'object'
    ? typed.data as Record<string, unknown>
    : null;
  if (typed.kind === 'update_conflict' && data && isNonEmpty(data.remote_id)) {
    const actualRevision = isProviderRevision(data.actual) ? data.actual : undefined;
    return {
      state: 'conflict',
      remoteId: data.remote_id,
      ...(actualRevision ? { actualRevision } : {}),
    };
  }
  if (typed.kind === 'remote_not_found' && data && isNonEmpty(data.remote_id)) {
    return { state: 'not_found', remoteId: data.remote_id };
  }
  if (typed.kind === 'unsupported_update') {
    return { state: 'unsupported' };
  }
  return { state: 'error', message: 'Publish failed.' };
}
