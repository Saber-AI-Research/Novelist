import { describe, it, expect } from 'vitest';

/**
 * Scroll stabilizer guard logic tests.
 *
 * Three implementations are tested:
 *
 * 1. Original (ScrollGuardState): scrollHandler + rAF restoration loop
 *    - scrollHandler suppresses scrollIntoView → scrollAnchorHeight=-1
 *    - rAF loop pins scrollTop for 10 frames
 *    - locked flag blocks onScroll during rAF loop
 *
 * 2. Option A (ScrollGuardStateA): scrollHandler only, no rAF
 *    - Same scrollHandler suppression (scrollAnchorHeight=-1)
 *    - NO rAF restoration — trusts scrollAnchorHeight=-1 to prevent drift
 *    - Clears settleTimer to prevent delayed requestMeasure interference
 *    - Shorter lock (1 frame vs 10 frames)
 *
 * 3. Option B (ScrollGuardStateB): transactionFilter
 *    - Strips scrollIntoView from select.pointer transactions
 *    - Height anchor correction DOES run (scrollAnchorHeight ≥ 0)
 *    - Brief lock to absorb scroll events from correction
 */

// ===================================================================
// Original model (scrollHandler + rAF)
// ===================================================================

class ScrollGuardState {
  pending = false;
  locked = false;
  lastScrollTop = 0;

  onScroll(newScrollTop: number, viewportHeight: number) {
    if (this.locked) return;
    const delta = Math.abs(newScrollTop - this.lastScrollTop);
    if (delta > viewportHeight * 0.5) {
      this.pending = true;
    }
    this.lastScrollTop = newScrollTop;
  }

  /**
   * Simulates scrollHandler invocation.
   * Returns true if the scroll should be suppressed.
   */
  onScrollIntoView(headInViewport: boolean): boolean {
    if (!this.pending) return false;
    if (!headInViewport) return false; // let programmatic scrolls through
    this.pending = false;
    this.locked = true;
    return true;
  }

  /** Simulates rAF loop completion (lock released) */
  endLock() {
    this.locked = false;
    this.lastScrollTop = 0; // in real code, updated to current scrollTop
  }
}

// ===================================================================
// Option A model (scrollHandler only, no rAF)
// ===================================================================

class ScrollGuardStateA {
  pending = false;
  locked = false;
  lastScrollTop = 0;
  settleTimerPending = false;

  onScroll(newScrollTop: number, viewportHeight: number) {
    if (this.locked) return;
    const delta = Math.abs(newScrollTop - this.lastScrollTop);
    if (delta > viewportHeight * 0.5) {
      this.pending = true;
    }
    this.lastScrollTop = newScrollTop;
    this.settleTimerPending = true;
  }

  /**
   * Simulates scrollHandler invocation.
   * Returns true if scroll is suppressed.
   * Also clears settleTimer (key difference from original).
   */
  onScrollIntoView(headInViewport: boolean): boolean {
    if (!this.pending) return false;
    if (!headInViewport) return false;
    this.pending = false;
    this.locked = true;
    this.settleTimerPending = false; // clear settleTimer on suppression
    return true;
  }

  /** Simulates 1-frame rAF unlock (much shorter than original's 10-frame loop) */
  endLock(currentScrollTop: number) {
    this.locked = false;
    this.lastScrollTop = currentScrollTop;
  }
}

// ===================================================================
// Option B model (transactionFilter)
// ===================================================================

class ScrollGuardStateB {
  pending = false;
  locked = false;
  lastScrollTop = 0;
  settleTimerPending = false;

  onScroll(newScrollTop: number, viewportHeight: number) {
    if (this.locked) return;
    const delta = Math.abs(newScrollTop - this.lastScrollTop);
    if (delta > viewportHeight * 0.5) {
      this.pending = true;
    }
    this.lastScrollTop = newScrollTop;
    this.settleTimerPending = true;
  }

  /**
   * Simulates transactionFilter invocation.
   * Returns true if scrollIntoView was stripped from the transaction.
   */
  onTransaction(hasScrollIntoView: boolean, isPointerSelect: boolean): boolean {
    if (!this.pending) return false;
    if (!hasScrollIntoView) return false;
    if (!isPointerSelect) return false;
    this.pending = false;
    this.locked = true;
    this.settleTimerPending = false; // clear settleTimer
    return true;
  }

  /** Simulates 1-frame rAF unlock */
  endLock() {
    this.locked = false;
  }
}

// ===================================================================
// Tests: Original model
// ===================================================================

describe('ScrollGuardState (original: scrollHandler + rAF)', () => {
  const VP = 476;

  it('not active initially', () => {
    const g = new ScrollGuardState();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('activates on large scroll', () => {
    const g = new ScrollGuardState();
    g.onScroll(11999, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('stays active indefinitely (no timeout)', () => {
    const g = new ScrollGuardState();
    g.onScroll(11999, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('deactivates after scrollIntoView suppression + lock release', () => {
    const g = new ScrollGuardState();
    g.onScroll(11999, VP);
    g.onScrollIntoView(true);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('reactivates on subsequent large scroll', () => {
    const g = new ScrollGuardState();
    g.onScroll(11999, VP);
    g.onScrollIntoView(true);
    g.endLock();
    g.onScroll(100000, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('ignores small scrolls', () => {
    const g = new ScrollGuardState();
    for (let i = 1; i <= 100; i++) g.onScroll(i * 3, VP);
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('lets programmatic scrolls through (target outside viewport)', () => {
    const g = new ScrollGuardState();
    g.onScroll(11999, VP);
    expect(g.onScrollIntoView(false)).toBe(false);
    // Guard stays active for the next (in-viewport) scroll
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  // -- locked flag blocks async scroll re-triggering --

  it('scroll during lock does NOT re-arm', () => {
    const g = new ScrollGuardState();
    g.onScroll(3047753, VP);
    g.onScrollIntoView(true); // locked=true
    // async scroll events blocked
    g.onScroll(3047734, VP);
    g.onScroll(3047753, VP);
    expect(g.pending).toBe(false);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('two independent scroll-click cycles', () => {
    const g = new ScrollGuardState();
    g.onScroll(3047753, VP);
    g.onScrollIntoView(true);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);

    g.onScroll(4151664, VP);
    g.onScrollIntoView(true);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  // -- regression tests from real logs --

  it('regression: guards click >1s after large scroll', () => {
    const g = new ScrollGuardState();
    g.onScroll(2735742, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('regression: full scrollIntoView cycle', () => {
    const g = new ScrollGuardState();
    g.onScroll(3219952, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('regression: edit→scroll up→click→scroll down→click', () => {
    const g = new ScrollGuardState();
    g.onScroll(3165241, VP);
    g.onScroll(569336, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);

    g.onScroll(569669, VP);
    g.onScroll(4200022, VP);
    g.onScrollIntoView(true);
    g.onScroll(4199283, VP); // blocked by lock
    g.endLock();
    expect(g.onScrollIntoView(true)).toBe(false);
  });
});

// ===================================================================
// Tests: Option A (scrollHandler only, no rAF)
// ===================================================================

describe('ScrollGuardStateA (Option A: scrollHandler, no rAF)', () => {
  const VP = 476;

  it('not active initially', () => {
    const g = new ScrollGuardStateA();
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('activates on large scroll', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(11999, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('clears settleTimer on suppression', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(11999, VP);
    expect(g.settleTimerPending).toBe(true);
    g.onScrollIntoView(true);
    expect(g.settleTimerPending).toBe(false);
  });

  it('endLock uses actual scrollTop (not zero)', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(587987, VP);
    g.onScrollIntoView(true);
    // In Option A, endLock receives the actual current scrollTop
    g.endLock(587987);
    expect(g.lastScrollTop).toBe(587987);
    // Small scroll after lock should NOT trigger pending
    g.onScroll(588100, VP);
    expect(g.pending).toBe(false); // delta=113 < 238
  });

  it('scroll during lock does NOT re-arm', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(3047753, VP);
    g.onScrollIntoView(true);
    g.onScroll(3047734, VP);
    g.onScroll(3047753, VP);
    expect(g.pending).toBe(false);
    g.endLock(3047753);
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('lets programmatic scrolls through', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(11999, VP);
    expect(g.onScrollIntoView(false)).toBe(false);
    expect(g.onScrollIntoView(true)).toBe(true);
  });

  it('two independent scroll-click cycles', () => {
    const g = new ScrollGuardStateA();
    // Cycle 1
    g.onScroll(3047753, VP);
    g.onScrollIntoView(true);
    g.endLock(3047753);
    expect(g.onScrollIntoView(true)).toBe(false);

    // Cycle 2
    g.onScroll(4151664, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
    g.endLock(4151664);
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  // -- Key difference: small scroll after endLock does NOT trigger --
  it('small scroll after endLock with real scrollTop does not trigger', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(587987, VP);
    g.onScrollIntoView(true);
    g.endLock(587987); // lastScrollTop = 587987 (not 0)
    g.onScroll(588100, VP); // delta = 113 < 238
    expect(g.pending).toBe(false);
  });

  // -- Regression from real logs --
  it('regression: edit→scroll up→click→scroll down→click', () => {
    const g = new ScrollGuardStateA();
    g.onScroll(3165241, VP);
    g.onScroll(569336, VP);
    expect(g.onScrollIntoView(true)).toBe(true);
    expect(g.settleTimerPending).toBe(false); // cleared on suppression
    g.endLock(569336);

    // Small adjustment should NOT trigger (delta=333 < 238? No, 333 > 238)
    // 569669 - 569336 = 333 > 238 → this IS a large scroll
    g.onScroll(569669, VP);
    // But then the big drag down:
    g.onScroll(4200022, VP);
    g.onScrollIntoView(true);
    g.onScroll(4199283, VP); // blocked by lock
    g.endLock(4200022);
    expect(g.onScrollIntoView(true)).toBe(false);
  });

  it('regression: 150k-line doc, scrollbar drag from top to middle', () => {
    const g = new ScrollGuardStateA();
    // User at line 169, scrollTop ≈ 0
    // Drags scrollbar to line 108856, scrollTop ≈ 3047753
    g.onScroll(3047753, VP);
    expect(g.pending).toBe(true);
    expect(g.onScrollIntoView(true)).toBe(true);
    expect(g.settleTimerPending).toBe(false);
    g.endLock(3047753);
    // Normal small scroll after — should NOT re-arm
    g.onScroll(3047900, VP); // delta = 147 < 238
    expect(g.pending).toBe(false);
  });
});

// ===================================================================
// Tests: Option B (transactionFilter)
// ===================================================================

describe('ScrollGuardStateB (Option B: transactionFilter)', () => {
  const VP = 476;

  it('not active initially', () => {
    const g = new ScrollGuardStateB();
    expect(g.onTransaction(true, true)).toBe(false);
  });

  it('activates on large scroll', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(11999, VP);
    expect(g.onTransaction(true, true)).toBe(true);
  });

  it('ignores non-pointer transactions', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(11999, VP);
    // e.g., search "next match" — has scrollIntoView but is not pointer
    expect(g.onTransaction(true, false)).toBe(false);
    // Guard stays armed for the next pointer click
    expect(g.onTransaction(true, true)).toBe(true);
  });

  it('ignores transactions without scrollIntoView', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(11999, VP);
    // e.g., text input — pointer but no scrollIntoView
    expect(g.onTransaction(false, true)).toBe(false);
    // Guard stays armed
    expect(g.onTransaction(true, true)).toBe(true);
  });

  it('clears settleTimer on suppression', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(11999, VP);
    expect(g.settleTimerPending).toBe(true);
    g.onTransaction(true, true);
    expect(g.settleTimerPending).toBe(false);
  });

  it('scroll during lock does NOT re-arm', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(3047753, VP);
    g.onTransaction(true, true); // locked=true
    // Height anchor correction triggers scroll events — blocked
    g.onScroll(3047000, VP);
    g.onScroll(3048000, VP);
    expect(g.pending).toBe(false);
    g.endLock();
    expect(g.onTransaction(true, true)).toBe(false);
  });

  it('two independent scroll-click cycles', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(3047753, VP);
    g.onTransaction(true, true);
    g.endLock();

    g.onScroll(4151664, VP);
    expect(g.onTransaction(true, true)).toBe(true);
    g.endLock();
    expect(g.onTransaction(true, true)).toBe(false);
  });

  // -- Regression from real logs --
  it('regression: edit→scroll up→click→scroll down→click', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(3165241, VP);
    g.onScroll(569336, VP);
    expect(g.onTransaction(true, true)).toBe(true);
    g.endLock();

    g.onScroll(569669, VP);
    g.onScroll(4200022, VP);
    g.onTransaction(true, true);
    g.onScroll(4199283, VP); // blocked by lock
    g.endLock();
    expect(g.onTransaction(true, true)).toBe(false);
  });

  it('regression: 150k-line doc, non-pointer scroll after guard consumed', () => {
    const g = new ScrollGuardStateB();
    g.onScroll(3047753, VP);
    g.onTransaction(true, true); // consumed
    g.endLock();
    // Programmatic scroll (e.g., search) should NOT be affected
    expect(g.onTransaction(true, false)).toBe(false); // not pointer
    // New large scroll re-arms
    g.onScroll(500000, VP);
    expect(g.onTransaction(true, true)).toBe(true);
  });
});
