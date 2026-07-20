import { describe, it, expect } from 'vitest';
import {
  initialUpdateCheckState,
  evaluateEligibility,
  startCheck,
  applyEvent,
  isSilentPhase,
  completeFromResult,
  type UpdateCheckState,
  type EligibilityContext,
  type UpdateRequestToken,
} from '$lib/utils/update-check-state';

/**
 * Pure update-check state machine tests. Task 22 will wire this reducer
 * into both App.svelte's startup task and the palette's "Check for
 * updates" command; every branch is exercised here because the reducer
 * is pure (no localStorage, no Tauri plugin, no updaterState store).
 */

const CTX_ELIGIBLE: EligibilityContext = { portable: false };
const CTX_PORTABLE: EligibilityContext = { portable: true };

function driveAvailable(
  start: UpdateCheckState,
  version = '0.4.0',
  notes: string | null = 'release notes',
): { state: UpdateCheckState; token: UpdateRequestToken } {
  const { state: s1, token } = startCheck(start);
  const s2 = applyEvent(s1, { type: 'completeAvailable', token, version, notes });
  return { state: s2, token };
}

describe('[precision] initialUpdateCheckState', () => {
  it('starts idle with no token, no version, no error', () => {
    const s = initialUpdateCheckState();
    expect(s).toEqual({
      phase: 'idle',
      token: null,
      version: null,
      notes: null,
      error: null,
      nextTokenId: 1,
    });
  });

  it('is frozen so reducer callers cannot mutate it', () => {
    expect(Object.isFrozen(initialUpdateCheckState())).toBe(true);
  });

  it('produces independent snapshots on repeated calls', () => {
    expect(initialUpdateCheckState()).not.toBe(initialUpdateCheckState());
  });
});

describe('[precision] evaluateEligibility', () => {
  it('returns proceed for a fresh idle state in non-portable mode', () => {
    expect(evaluateEligibility(initialUpdateCheckState(), CTX_ELIGIBLE))
      .toEqual({ kind: 'proceed' });
  });

  it('returns unsupported in portable mode from idle', () => {
    expect(evaluateEligibility(initialUpdateCheckState(), CTX_PORTABLE))
      .toEqual({ kind: 'unsupported' });
  });

  it('returns in-flight with the current token while a check is running', () => {
    const { state, token } = startCheck(initialUpdateCheckState());
    expect(evaluateEligibility(state, CTX_ELIGIBLE)).toEqual({ kind: 'in-flight', token });
  });

  it('collapses concurrent checks by returning the same active token both times', () => {
    const { state, token } = startCheck(initialUpdateCheckState());
    const first = evaluateEligibility(state, CTX_ELIGIBLE);
    const second = evaluateEligibility(state, CTX_ELIGIBLE);
    expect(first).toEqual({ kind: 'in-flight', token });
    expect(second).toEqual({ kind: 'in-flight', token });
    if (first.kind === 'in-flight' && second.kind === 'in-flight') {
      expect(first.token.id).toBe(second.token.id);
    }
  });

  it('portable takes precedence over any TERMINAL phase', () => {
    const failed = applyEvent(startCheck(initialUpdateCheckState()).state, {
      type: 'fail',
      token: { id: 1 },
      error: 'network',
    });
    expect(evaluateEligibility(failed, CTX_PORTABLE)).toEqual({ kind: 'unsupported' });
  });

  it('in-flight takes precedence over portable (never orphans an already-started request)', () => {
    const { state, token } = startCheck(initialUpdateCheckState());
    expect(evaluateEligibility(state, CTX_PORTABLE)).toEqual({ kind: 'in-flight', token });
  });

  it('returns proceed after a failed check once reset', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const failed = applyEvent(checking, { type: 'fail', token, error: 'nope' });
    const idle = applyEvent(failed, { type: 'retry' });
    expect(evaluateEligibility(idle, CTX_ELIGIBLE)).toEqual({ kind: 'proceed' });
  });

  it('returns proceed after a no-update outcome', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const noUpdate = applyEvent(checking, { type: 'completeNoUpdate', token });
    expect(evaluateEligibility(noUpdate, CTX_ELIGIBLE)).toEqual({ kind: 'proceed' });
  });

  it('returns proceed after an available outcome', () => {
    const { state: available } = driveAvailable(initialUpdateCheckState());
    expect(evaluateEligibility(available, CTX_ELIGIBLE)).toEqual({ kind: 'proceed' });
  });
});

describe('[precision] startCheck', () => {
  it('allocates a monotonic token starting at id=1', () => {
    const { state, token } = startCheck(initialUpdateCheckState());
    expect(token).toEqual({ id: 1 });
    expect(state.phase).toBe('checking');
    expect(state.token).toEqual({ id: 1 });
    expect(state.nextTokenId).toBe(2);
  });

  it('increments the token counter on successive starts', () => {
    const { state: s1, token: t1 } = startCheck(initialUpdateCheckState());
    const done = applyEvent(s1, { type: 'completeNoUpdate', token: t1 });
    const { state: s2, token: t2 } = startCheck(done);
    expect(t1.id).toBe(1);
    expect(t2.id).toBe(2);
    expect(s2.nextTokenId).toBe(3);
  });

  it('clears any prior error, version, and notes when a new check begins', () => {
    const failed = applyEvent(startCheck(initialUpdateCheckState()).state, {
      type: 'fail',
      token: { id: 1 },
      error: 'oops',
    });
    const idle = applyEvent(failed, { type: 'retry' });
    const { state } = startCheck(idle);
    expect(state.phase).toBe('checking');
    expect(state.error).toBeNull();
    expect(state.version).toBeNull();
    expect(state.notes).toBeNull();
  });

  it('returns a frozen state', () => {
    expect(Object.isFrozen(startCheck(initialUpdateCheckState()).state)).toBe(true);
  });

  it('is idempotent while a check is already in flight — same token, same state, no counter bump', () => {
    const { state: s1, token: t1 } = startCheck(initialUpdateCheckState());
    const { state: s2, token: t2 } = startCheck(s1);
    expect(s2).toBe(s1);
    expect(t2).toBe(t1);
    expect(s2.nextTokenId).toBe(s1.nextTokenId);
  });

  it('collapses N concurrent startCheck calls to one logical request', () => {
    const initial = initialUpdateCheckState();
    const { state: s1, token: t1 } = startCheck(initial);
    const { state: s2, token: t2 } = startCheck(s1);
    const { state: s3, token: t3 } = startCheck(s2);
    expect(t1.id).toBe(1);
    expect(t2.id).toBe(1);
    expect(t3.id).toBe(1);
    expect(s3).toBe(s1);
    expect(s3.nextTokenId).toBe(2);
  });

  it('a completion using the original token still resolves cleanly after repeated startCheck calls', () => {
    const { state: s1, token: t1 } = startCheck(initialUpdateCheckState());
    const { state: s2 } = startCheck(s1);
    const done = applyEvent(s2, {
      type: 'completeAvailable',
      token: t1,
      version: '0.4.0',
      notes: null,
    });
    expect(done.phase).toBe('available');
    expect(done.version).toBe('0.4.0');
  });

  it('after terminal → retry → startCheck allocates the NEXT id (dedupe does not survive a real reset)', () => {
    const { state: s1, token: t1 } = startCheck(initialUpdateCheckState());
    const done = applyEvent(s1, { type: 'completeNoUpdate', token: t1 });
    const idle = applyEvent(done, { type: 'retry' });
    const { token: t2 } = startCheck(idle);
    expect(t2.id).toBe(2);
    expect(t2.id).not.toBe(t1.id);
  });
});

describe('[precision] applyEvent — completeAvailable', () => {
  it('transitions checking → available with fresh token', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, {
      type: 'completeAvailable',
      token,
      version: '0.4.0',
      notes: '- fix crash',
    });
    expect(s.phase).toBe('available');
    expect(s.version).toBe('0.4.0');
    expect(s.notes).toBe('- fix crash');
    expect(s.token).toBeNull();
    expect(s.error).toBeNull();
  });

  it('preserves notes=null (release notes are optional)', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, {
      type: 'completeAvailable',
      token,
      version: '0.4.0',
      notes: null,
    });
    expect(s.notes).toBeNull();
  });

  it('ignores a stale token completion so an older request cannot overwrite newer state', () => {
    const { state: s1, token: staleToken } = startCheck(initialUpdateCheckState());
    const noUpdate = applyEvent(s1, { type: 'completeNoUpdate', token: staleToken });
    const { state: s2, token: freshToken } = startCheck(noUpdate);
    const s3 = applyEvent(s2, {
      type: 'completeAvailable',
      token: staleToken,
      version: '0.9.9',
      notes: null,
    });
    expect(s3).toBe(s2);
    const s4 = applyEvent(s3, {
      type: 'completeAvailable',
      token: freshToken,
      version: '0.4.1',
      notes: null,
    });
    expect(s4.phase).toBe('available');
    expect(s4.version).toBe('0.4.1');
  });

  it('is a no-op when phase is not checking', () => {
    const idle = initialUpdateCheckState();
    const s = applyEvent(idle, {
      type: 'completeAvailable',
      token: { id: 42 },
      version: '9.9.9',
      notes: null,
    });
    expect(s).toBe(idle);
  });
});

describe('[precision] applyEvent — completeNoUpdate', () => {
  it('transitions checking → no-update with fresh token', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'completeNoUpdate', token });
    expect(s.phase).toBe('no-update');
    expect(s.version).toBeNull();
    expect(s.notes).toBeNull();
    expect(s.error).toBeNull();
  });

  it('ignores stale token', () => {
    const { state: s1, token: staleToken } = startCheck(initialUpdateCheckState());
    const done = applyEvent(s1, { type: 'completeNoUpdate', token: staleToken });
    const { state: s2 } = startCheck(done);
    const s3 = applyEvent(s2, { type: 'completeNoUpdate', token: staleToken });
    expect(s3).toBe(s2);
  });

  it('is a no-op when phase is idle', () => {
    const idle = initialUpdateCheckState();
    expect(applyEvent(idle, { type: 'completeNoUpdate', token: { id: 1 } })).toBe(idle);
  });
});

describe('[precision] applyEvent — completeSkipped', () => {
  it('transitions checking → skipped retaining version but never notes', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'completeSkipped', token, version: '0.4.0' });
    expect(s.phase).toBe('skipped');
    expect(s.version).toBe('0.4.0');
    expect(s.notes).toBeNull();
    expect(s.error).toBeNull();
  });

  it('ignores stale token', () => {
    const { state: s1, token: staleToken } = startCheck(initialUpdateCheckState());
    const done = applyEvent(s1, { type: 'completeNoUpdate', token: staleToken });
    const { state: s2 } = startCheck(done);
    const s3 = applyEvent(s2, { type: 'completeSkipped', token: staleToken, version: '9.9.9' });
    expect(s3).toBe(s2);
  });
});

describe('[precision] applyEvent — markUnsupported', () => {
  it('transitions idle → unsupported', () => {
    const s = applyEvent(initialUpdateCheckState(), { type: 'markUnsupported' });
    expect(s.phase).toBe('unsupported');
    expect(s.token).toBeNull();
    expect(s.version).toBeNull();
    expect(s.error).toBeNull();
  });

  it('transitions failed → unsupported', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const failed = applyEvent(checking, { type: 'fail', token, error: 'x' });
    const s = applyEvent(failed, { type: 'markUnsupported' });
    expect(s.phase).toBe('unsupported');
    expect(s.error).toBeNull();
  });

  it('is a no-op when phase is checking so it never orphans an in-flight request', () => {
    const { state: checking } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'markUnsupported' });
    expect(s).toBe(checking);
  });
});

describe('[precision] applyEvent — fail', () => {
  it('transitions checking → failed with the exact error message', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'fail', token, error: 'network timeout' });
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('network timeout');
    expect(s.token).toBeNull();
    expect(s.version).toBeNull();
    expect(s.notes).toBeNull();
  });

  it('preserves an empty-string error rather than collapsing to null', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'fail', token, error: '' });
    expect(s.error).toBe('');
  });

  it('ignores stale token', () => {
    const { state: s1, token: staleToken } = startCheck(initialUpdateCheckState());
    const noUpdate = applyEvent(s1, { type: 'completeNoUpdate', token: staleToken });
    const { state: s2 } = startCheck(noUpdate);
    const s3 = applyEvent(s2, { type: 'fail', token: staleToken, error: 'ghost error' });
    expect(s3).toBe(s2);
  });
});

describe('[precision] applyEvent — retry', () => {
  it('resets failed → idle so a new check can proceed', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const failed = applyEvent(checking, { type: 'fail', token, error: 'boom' });
    const idle = applyEvent(failed, { type: 'retry' });
    expect(idle.phase).toBe('idle');
    expect(idle.error).toBeNull();
    expect(idle.token).toBeNull();
    expect(idle.nextTokenId).toBe(failed.nextTokenId);
  });

  it('resets no-update → idle', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const noUpdate = applyEvent(checking, { type: 'completeNoUpdate', token });
    const idle = applyEvent(noUpdate, { type: 'retry' });
    expect(idle.phase).toBe('idle');
  });

  it('resets skipped → idle', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const skipped = applyEvent(checking, { type: 'completeSkipped', token, version: '0.4.0' });
    const idle = applyEvent(skipped, { type: 'retry' });
    expect(idle.phase).toBe('idle');
    expect(idle.version).toBeNull();
  });

  it('resets available → idle', () => {
    const { state: available } = driveAvailable(initialUpdateCheckState());
    const idle = applyEvent(available, { type: 'retry' });
    expect(idle.phase).toBe('idle');
    expect(idle.version).toBeNull();
    expect(idle.notes).toBeNull();
  });

  it('resets unsupported → idle', () => {
    const unsupported = applyEvent(initialUpdateCheckState(), { type: 'markUnsupported' });
    const idle = applyEvent(unsupported, { type: 'retry' });
    expect(idle.phase).toBe('idle');
  });

  it('is a no-op when already idle (returns identity)', () => {
    const idle = initialUpdateCheckState();
    const s = applyEvent(idle, { type: 'retry' });
    expect(s.phase).toBe('idle');
    expect(s).toBe(idle);
  });

  it('is a no-op when a check is currently in flight', () => {
    const { state: checking } = startCheck(initialUpdateCheckState());
    const s = applyEvent(checking, { type: 'retry' });
    expect(s).toBe(checking);
  });
});

describe('[precision] concurrent checks collapse to one logical token/result', () => {
  it('startup + manual overlap sees the same in-flight token; only one completion', () => {
    const initial = initialUpdateCheckState();
    const startupDecision = evaluateEligibility(initial, CTX_ELIGIBLE);
    expect(startupDecision).toEqual({ kind: 'proceed' });
    const { state: checking, token: startupToken } = startCheck(initial);
    expect(startupToken.id).toBe(1);
    const manualDecision = evaluateEligibility(checking, CTX_ELIGIBLE);
    expect(manualDecision).toEqual({ kind: 'in-flight', token: startupToken });
    const done = applyEvent(checking, {
      type: 'completeAvailable',
      token: startupToken,
      version: '0.4.0',
      notes: null,
    });
    expect(done.phase).toBe('available');
    expect(done.version).toBe('0.4.0');
  });

  it('a forged token that never came from startCheck cannot pollute state', () => {
    const { state: checking, token: t1 } = startCheck(initialUpdateCheckState());
    const forged: UpdateRequestToken = { id: t1.id + 100 };
    const s = applyEvent(checking, {
      type: 'completeAvailable',
      token: forged,
      version: '9.9.9',
      notes: null,
    });
    expect(s).toBe(checking);
  });
});

describe('[precision] silent outcomes never produce banner-eligible state', () => {
  it('portable path never enters available or failed', () => {
    const initial = initialUpdateCheckState();
    const decision = evaluateEligibility(initial, CTX_PORTABLE);
    expect(decision).toEqual({ kind: 'unsupported' });
    const unsupported = applyEvent(initial, { type: 'markUnsupported' });
    expect(unsupported.phase).toBe('unsupported');
    const idle = applyEvent(unsupported, { type: 'retry' });
    expect(evaluateEligibility(idle, CTX_PORTABLE)).toEqual({ kind: 'unsupported' });
  });

  it('skipped-version outcome stays quiet', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const skipped = applyEvent(checking, { type: 'completeSkipped', token, version: '0.4.0' });
    expect(skipped.phase).toBe('skipped');
    expect(isSilentPhase(skipped.phase)).toBe(true);
  });

  it('no-update outcome stays quiet', () => {
    const { state: checking, token } = startCheck(initialUpdateCheckState());
    const done = applyEvent(checking, { type: 'completeNoUpdate', token });
    expect(isSilentPhase(done.phase)).toBe(true);
  });
});

describe('[precision] isSilentPhase', () => {
  it('classifies each phase', () => {
    expect(isSilentPhase('idle')).toBe(true);
    expect(isSilentPhase('no-update')).toBe(true);
    expect(isSilentPhase('skipped')).toBe(true);
    expect(isSilentPhase('unsupported')).toBe(true);
    expect(isSilentPhase('available')).toBe(false);
    expect(isSilentPhase('failed')).toBe(false);
    expect(isSilentPhase('checking')).toBe(false);
  });
});

describe('[precision] completeFromResult', () => {
  const token: UpdateRequestToken = { id: 7 };

  it('maps no-update result → completeNoUpdate carrying the token verbatim', () => {
    expect(completeFromResult({ available: false }, null, token))
      .toEqual({ type: 'completeNoUpdate', token });
  });

  it('maps no-update result and ignores skippedVersion', () => {
    expect(completeFromResult({ available: false }, '0.4.0', token))
      .toEqual({ type: 'completeNoUpdate', token });
  });

  it('maps available result with matching skipped version → completeSkipped', () => {
    expect(completeFromResult(
      { available: true, version: '0.4.0', notes: 'stuff' },
      '0.4.0',
      token,
    )).toEqual({ type: 'completeSkipped', token, version: '0.4.0' });
  });

  it('maps available result with different skipped version → completeAvailable', () => {
    expect(completeFromResult(
      { available: true, version: '0.4.1', notes: 'stuff' },
      '0.4.0',
      token,
    )).toEqual({ type: 'completeAvailable', token, version: '0.4.1', notes: 'stuff' });
  });

  it('maps available result with skippedVersion=null → completeAvailable', () => {
    expect(completeFromResult(
      { available: true, version: '0.4.0', notes: null },
      null,
      token,
    )).toEqual({ type: 'completeAvailable', token, version: '0.4.0', notes: null });
  });

  it('preserves notes verbatim including empty string vs null', () => {
    const emptyNotes = completeFromResult(
      { available: true, version: '0.4.0', notes: '' },
      null,
      token,
    );
    expect(emptyNotes).toEqual({ type: 'completeAvailable', token, version: '0.4.0', notes: '' });
    const nullNotes = completeFromResult(
      { available: true, version: '0.4.0', notes: null },
      null,
      token,
    );
    if (nullNotes.type === 'completeAvailable') expect(nullNotes.notes).toBeNull();
  });

  it('only exact string equality triggers skip (prefix/substring do not)', () => {
    expect(completeFromResult(
      { available: true, version: '0.4.10', notes: null },
      '0.4.1',
      token,
    )).toEqual({ type: 'completeAvailable', token, version: '0.4.10', notes: null });
    expect(completeFromResult(
      { available: true, version: '0.4.0', notes: null },
      '0.4.0-beta',
      token,
    )).toEqual({ type: 'completeAvailable', token, version: '0.4.0', notes: null });
  });

  it('empty-string skippedVersion never matches a real version', () => {
    expect(completeFromResult(
      { available: true, version: '0.4.0', notes: null },
      '',
      token,
    )).toEqual({ type: 'completeAvailable', token, version: '0.4.0', notes: null });
  });

  it('end-to-end: dispatching the mapped event through applyEvent yields the expected phase', () => {
    const { state: checking, token: t } = startCheck(initialUpdateCheckState());
    const availableEvt = completeFromResult(
      { available: true, version: '0.4.0', notes: 'notes' },
      null,
      t,
    );
    expect(applyEvent(checking, availableEvt).phase).toBe('available');

    const { state: checking2, token: t2 } = startCheck(applyEvent(applyEvent(checking, availableEvt), { type: 'retry' }));
    const skippedEvt = completeFromResult(
      { available: true, version: '0.4.0', notes: 'notes' },
      '0.4.0',
      t2,
    );
    expect(applyEvent(checking2, skippedEvt).phase).toBe('skipped');

    const { state: checking3, token: t3 } = startCheck(applyEvent(applyEvent(checking2, skippedEvt), { type: 'retry' }));
    const noUpdateEvt = completeFromResult({ available: false }, null, t3);
    expect(applyEvent(checking3, noUpdateEvt).phase).toBe('no-update');
  });
});
