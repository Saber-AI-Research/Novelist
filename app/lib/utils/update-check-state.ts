/**
 * Pure state machine for the app's update-check eligibility and outcome
 * tracking. Consumed later by both the automatic startup check and the
 * manual "Check for updates" command (Task 22 wires this in).
 *
 * Design goals:
 *   - Zero coupling to `@tauri-apps/plugin-updater`, `localStorage`, or the
 *     visible `updaterState` store — the reducer is a pure function of
 *     state + event, so it can be unit-tested against every branch.
 *   - Explicit request tokens so an older completion cannot overwrite a
 *     newer request's result. `startCheck` itself dedupes: calling it while
 *     `phase === 'checking'` returns the SAME token/state, so a manual click
 *     while startup's request is still in flight cannot orphan the original.
 *   - Silent outcomes (`unsupported`, `skipped`, `no-update`) are terminal
 *     but distinct from `failed` — UI consumers ignore them without losing
 *     diagnostic detail.
 *   - `completeFromResult` is the sole pure mapper from a plugin result to a
 *     completion event; it forces every caller to consult `skippedVersion`
 *     before dispatching, so the "silent skip" gate cannot be forgotten.
 *   - Manual retry is a first-class event that re-arms `idle` from any
 *     terminal phase so eligibility can be re-evaluated.
 */

export type UpdateCheckPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'no-update'
  | 'skipped'
  | 'unsupported'
  | 'failed';

export type UpdateRequestToken = { readonly id: number };

export type UpdateCheckState = Readonly<{
  phase: UpdateCheckPhase;
  token: UpdateRequestToken | null;
  version: string | null;
  notes: string | null;
  error: string | null;
  nextTokenId: number;
}>;

export type EligibilityContext = Readonly<{
  portable: boolean;
}>;

export type EligibilityDecision =
  | { kind: 'proceed' }
  | { kind: 'unsupported' }
  | { kind: 'in-flight'; token: UpdateRequestToken };

export type UpdaterResult =
  | { available: false }
  | { available: true; version: string; notes: string | null };

export type UpdateCheckEvent =
  | { type: 'completeAvailable'; token: UpdateRequestToken; version: string; notes: string | null }
  | { type: 'completeNoUpdate'; token: UpdateRequestToken }
  | { type: 'completeSkipped'; token: UpdateRequestToken; version: string }
  | { type: 'markUnsupported' }
  | { type: 'fail'; token: UpdateRequestToken; error: string }
  | { type: 'retry' };

export function initialUpdateCheckState(): UpdateCheckState {
  return Object.freeze({
    phase: 'idle',
    token: null,
    version: null,
    notes: null,
    error: null,
    nextTokenId: 1,
  });
}

export function evaluateEligibility(
  state: UpdateCheckState,
  ctx: EligibilityContext,
): EligibilityDecision {
  if (state.phase === 'checking' && state.token) {
    return { kind: 'in-flight', token: state.token };
  }
  if (ctx.portable) return { kind: 'unsupported' };
  return { kind: 'proceed' };
}

export function startCheck(
  state: UpdateCheckState,
): { state: UpdateCheckState; token: UpdateRequestToken } {
  if (state.phase === 'checking' && state.token) {
    return { state, token: state.token };
  }
  const token: UpdateRequestToken = Object.freeze({ id: state.nextTokenId });
  const next: UpdateCheckState = Object.freeze({
    phase: 'checking' as const,
    token,
    version: null,
    notes: null,
    error: null,
    nextTokenId: state.nextTokenId + 1,
  });
  return { state: next, token };
}

export function completeFromResult(
  result: UpdaterResult,
  skippedVersion: string | null,
  token: UpdateRequestToken,
): UpdateCheckEvent {
  if (!result.available) {
    return { type: 'completeNoUpdate', token };
  }
  if (skippedVersion !== null && skippedVersion === result.version) {
    return { type: 'completeSkipped', token, version: result.version };
  }
  return { type: 'completeAvailable', token, version: result.version, notes: result.notes };
}

export function applyEvent(state: UpdateCheckState, event: UpdateCheckEvent): UpdateCheckState {
  switch (event.type) {
    case 'markUnsupported': {
      if (state.phase === 'checking') return state;
      if (state.phase === 'unsupported') return state;
      return Object.freeze({
        phase: 'unsupported' as const,
        token: null,
        version: null,
        notes: null,
        error: null,
        nextTokenId: state.nextTokenId,
      });
    }
    case 'completeAvailable': {
      if (!isFreshToken(state, event.token)) return state;
      return Object.freeze({
        phase: 'available' as const,
        token: null,
        version: event.version,
        notes: event.notes,
        error: null,
        nextTokenId: state.nextTokenId,
      });
    }
    case 'completeNoUpdate': {
      if (!isFreshToken(state, event.token)) return state;
      return Object.freeze({
        phase: 'no-update' as const,
        token: null,
        version: null,
        notes: null,
        error: null,
        nextTokenId: state.nextTokenId,
      });
    }
    case 'completeSkipped': {
      if (!isFreshToken(state, event.token)) return state;
      return Object.freeze({
        phase: 'skipped' as const,
        token: null,
        version: event.version,
        notes: null,
        error: null,
        nextTokenId: state.nextTokenId,
      });
    }
    case 'fail': {
      if (!isFreshToken(state, event.token)) return state;
      return Object.freeze({
        phase: 'failed' as const,
        token: null,
        version: null,
        notes: null,
        error: event.error,
        nextTokenId: state.nextTokenId,
      });
    }
    case 'retry': {
      if (state.phase === 'checking' || state.phase === 'idle') return state;
      return Object.freeze({
        phase: 'idle' as const,
        token: null,
        version: null,
        notes: null,
        error: null,
        nextTokenId: state.nextTokenId,
      });
    }
  }
}

function isFreshToken(state: UpdateCheckState, token: UpdateRequestToken): boolean {
  return state.phase === 'checking' && state.token !== null && state.token.id === token.id;
}

export function isSilentPhase(phase: UpdateCheckPhase): boolean {
  return phase === 'idle' || phase === 'no-update' || phase === 'skipped' || phase === 'unsupported';
}
