import { describe, it, expect } from 'vitest';

/**
 * Scroll stabilizer state machine tests.
 *
 * The production stabilizer uses three layers:
 * 1. mousedown capture guard — saves scrollTop + posAtCoords
 * 2. scroll listener — detects/reverts native browser scroll, fixes selection
 * 3. scrollHandler facet — backup suppression of CM6's scrollIntoView
 *
 * This test models the state machine covering all three layers.
 * Test values (scrollTop, viewportHeight, line numbers) are taken directly
 * from real debug logs on novelist-150k.md (150,017 lines, ~3.19 MB).
 *
 * Line-to-scrollTop mapping (approximate, from logs):
 *   line 1     → scrollTop ≈ 0
 *   line 69    → scrollTop ≈ 1932
 *   line 235   → scrollTop ≈ 6335
 *   line 25315 → scrollTop ≈ 709347
 *   line 97650 → scrollTop ≈ 2734718
 *   line 108650→ scrollTop ≈ 3042723
 *   line 149984→ scrollTop ≈ 4200078
 */

// =================================================================
// State machine model matching the production three-layer stabilizer
// =================================================================

class NativeScrollGuard {
  // Scroll detection state
  pending = false;
  locked = false;
  lastScrollTop = 0;

  // Mousedown guard state
  guardActive = false;
  guardScrollTop = 0;
  guardClickPos = -1;

  // Simulated viewport height
  viewportHeight: number;

  constructor(viewportHeight = 476) {
    this.viewportHeight = viewportHeight;
  }

  // --- Layer 1: mousedown capture ---

  /** Simulates mousedown on content area. Returns false if guard not armed. */
  onMousedown(scrollTop: number, clickPos: number): boolean {
    if (!this.pending) return false;
    this.guardActive = true;
    this.guardScrollTop = scrollTop;
    this.guardClickPos = clickPos;
    return true;
  }

  // --- Layer 2: scroll listener ---

  /**
   * Simulates scroll event. Returns:
   *   'reverted'  — native scroll detected and reverted
   *   'pending'   — large scroll, pending flag set
   *   'ignored'   — small scroll or locked
   */
  onScroll(newScrollTop: number): 'reverted' | 'pending' | 'ignored' {
    // Native scroll interception during click processing
    if (this.guardActive && this.pending) {
      const delta = Math.abs(newScrollTop - this.guardScrollTop);
      if (delta > this.viewportHeight) {
        // Revert! In production: scrollDOM.scrollTop = guardScrollTop
        this.guardActive = false;
        this.locked = true;
        this.pending = false;
        // In production: queueMicrotask → dispatch({ selection: { anchor: guardClickPos } })
        return 'reverted';
      }
      this.guardActive = false;
    }

    if (this.locked) return 'ignored';

    const delta = Math.abs(newScrollTop - this.lastScrollTop);
    if (delta > this.viewportHeight * 0.5) {
      this.pending = true;
      this.lastScrollTop = newScrollTop;
      return 'pending';
    }
    this.lastScrollTop = newScrollTop;
    return 'ignored';
  }

  // --- Layer 3: scrollHandler (backup) ---

  /** Simulates CM6's scrollHandler facet invocation. */
  onScrollIntoView(headInViewport: boolean): boolean {
    if (!this.pending) return false;
    if (!headInViewport) return false;
    this.pending = false;
    this.locked = true;
    return true;
  }

  // --- Lifecycle ---

  /** Simulates rAF unlock after guard or scrollHandler */
  endLock(currentScrollTop: number) {
    this.locked = false;
    this.lastScrollTop = currentScrollTop;
  }
}

// =================================================================
// Core state machine tests
// =================================================================

describe('NativeScrollGuard — core state machine', () => {
  const VP = 476;

  it('not active initially', () => {
    const g = new NativeScrollGuard(VP);
    expect(g.pending).toBe(false);
    expect(g.onMousedown(0, 100)).toBe(false);
  });

  it('sets pending on large scroll', () => {
    const g = new NativeScrollGuard(VP);
    expect(g.onScroll(661)).toBe('pending');  // delta=661 > 238
    expect(g.pending).toBe(true);
  });

  it('ignores small scrolls', () => {
    const g = new NativeScrollGuard(VP);
    for (let i = 1; i <= 100; i++) g.onScroll(i * 2);  // delta=2 each
    expect(g.pending).toBe(false);
  });

  it('mousedown arms guard when pending', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    expect(g.onMousedown(3042723, 2300000)).toBe(true);
    expect(g.guardActive).toBe(true);
    expect(g.guardScrollTop).toBe(3042723);
    expect(g.guardClickPos).toBe(2300000);
  });

  it('mousedown ignored when not pending', () => {
    const g = new NativeScrollGuard(VP);
    expect(g.onMousedown(0, 100)).toBe(false);
    expect(g.guardActive).toBe(false);
  });

  it('native scroll reverted when guard active', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);

    // Browser native scroll: 3042723 → 6367 (catastrophic jump)
    const result = g.onScroll(6367);
    expect(result).toBe('reverted');
    expect(g.pending).toBe(false);
    expect(g.locked).toBe(true);
    expect(g.guardActive).toBe(false);
  });

  it('small scroll during guard not reverted', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);

    // Small adjustment — not a native jump
    const result = g.onScroll(3042800);
    expect(result).toBe('ignored');
    expect(g.guardActive).toBe(false);  // guard consumed
    expect(g.pending).toBe(true);  // pending still set
  });

  it('scroll during lock is blocked', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);
    g.onScroll(6367);  // reverted → locked

    // Post-revert scroll events blocked
    expect(g.onScroll(3042000)).toBe('ignored');
    expect(g.onScroll(3043000)).toBe('ignored');
    expect(g.pending).toBe(false);
  });

  it('endLock restores normal operation', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);
    g.onScroll(6367);  // reverted → locked
    g.endLock(3042723);

    expect(g.locked).toBe(false);
    // New large scroll should arm again
    expect(g.onScroll(4200000)).toBe('pending');
    expect(g.pending).toBe(true);
  });

  it('scrollHandler as backup when guard not triggered', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    // No mousedown guard — directly test scrollHandler
    expect(g.onScrollIntoView(true)).toBe(true);
    expect(g.pending).toBe(false);
    expect(g.locked).toBe(true);
  });

  it('scrollHandler lets programmatic scrolls through', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    expect(g.onScrollIntoView(false)).toBe(false);  // outside viewport
    expect(g.pending).toBe(true);  // guard stays armed
  });
});

// =================================================================
// Real session regression tests (from debug logs on novelist-150k.md)
// =================================================================

describe('NativeScrollGuard — regression: real log sessions', () => {
  const VP = 476;

  it('session 1: scroll to line 97650, click line 97676', () => {
    const g = new NativeScrollGuard(VP);

    // User clicks line 69, cursor at 69
    // Then scrollbar drag from top to line 97650 area
    g.onScroll(1932);    // small scroll
    g.onScroll(2734718); // scrollbar drag to line 97650
    expect(g.pending).toBe(true);

    // User clicks at line 97676 (pos ≈ 2064000)
    expect(g.onMousedown(2734718, 2064000)).toBe(true);

    // Browser native scroll: 2734718 → 2111
    expect(g.onScroll(2111)).toBe('reverted');
    expect(g.locked).toBe(true);
    expect(g.guardClickPos).toBe(2064000); // saved for selection fix

    g.endLock(2734718);

    // Subsequent normal click should work without guard
    expect(g.pending).toBe(false);
    expect(g.onMousedown(2734718, 2064100)).toBe(false);
  });

  it('session 2: scroll to line 108650, click line 108676', () => {
    const g = new NativeScrollGuard(VP);

    // Scrollbar drag to line 108650
    g.onScroll(3042723);
    expect(g.pending).toBe(true);

    // Click at line 108676
    g.onMousedown(3042723, 2300000);

    // Browser native scroll: 3042723 → 6367
    expect(g.onScroll(6367)).toBe('reverted');

    g.endLock(3042723);
    expect(g.pending).toBe(false);
  });

  it('session 3: scroll to line 25315, click line 25337 (from line 97680)', () => {
    const g = new NativeScrollGuard(VP);

    // User previously at line 97680 (scrollTop ≈ 2734718)
    g.lastScrollTop = 2734718;

    // Scrollbar drag up to line 25315
    g.onScroll(709347);
    expect(g.pending).toBe(true);

    // Click at line 25337
    g.onMousedown(709347, 520000);

    // Browser native scroll: 709347 → 2734827 (jumps back to old cursor)
    expect(g.onScroll(2734827)).toBe('reverted');
    expect(g.guardClickPos).toBe(520000);

    g.endLock(709347);
  });

  it('session 4: scroll to bottom (line 149984), click line 150005', () => {
    const g = new NativeScrollGuard(VP);

    // Scrollbar drag to near-bottom
    g.onScroll(4200078);
    expect(g.pending).toBe(true);

    // Click at line 150005
    g.onMousedown(4200078, 3189000);

    // Browser native scroll: 4200078 → 709503
    expect(g.onScroll(709503)).toBe('reverted');

    g.endLock(4200078);
  });

  it('session 5: two scroll-click cycles in same session', () => {
    const g = new NativeScrollGuard(VP);

    // --- Cycle 1: scroll to line 97650, click ---
    g.onScroll(2734718);
    expect(g.pending).toBe(true);

    g.onMousedown(2734718, 2064000);
    expect(g.onScroll(2111)).toBe('reverted');
    g.endLock(2734718);

    // --- Cycle 2: scroll down to line 25315, click ---
    g.onScroll(709347);
    expect(g.pending).toBe(true);

    g.onMousedown(709347, 520000);
    expect(g.onScroll(2734827)).toBe('reverted');
    g.endLock(709347);

    // --- Normal operation restored ---
    expect(g.pending).toBe(false);
    expect(g.locked).toBe(false);
  });

  it('session 6: click without prior large scroll (normal operation)', () => {
    const g = new NativeScrollGuard(VP);

    // Small scroll (within threshold)
    g.onScroll(200);
    expect(g.pending).toBe(false);

    // Click — guard should NOT arm
    expect(g.onMousedown(200, 5000)).toBe(false);

    // Scroll events should be normal
    expect(g.onScroll(400)).toBe('ignored');
  });

  it('session 7: scrollbar click (not content) should not arm guard', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    expect(g.pending).toBe(true);

    // Scrollbar click does NOT call onMousedown (filtered by contentDOM check)
    // So guard is not armed, scroll events pass through normally
    g.onScroll(3100000);
    expect(g.pending).toBe(true);  // still pending, waiting for content click
  });

  it('session 8: multiple rapid scroll events during drag', () => {
    const g = new NativeScrollGuard(VP);

    // Simulate fast scrollbar drag with intermediate positions
    g.onScroll(18667);    // pending=true (first large delta)
    g.onScroll(500000);
    g.onScroll(1500000);
    g.onScroll(2500000);
    g.onScroll(3042723);  // final position

    expect(g.pending).toBe(true);
    expect(g.lastScrollTop).toBe(3042723);

    // Click at final position
    g.onMousedown(3042723, 2300000);
    expect(g.guardScrollTop).toBe(3042723);
  });

  it('session 9: guard reverts, then second click works normally', () => {
    const g = new NativeScrollGuard(VP);

    // First cycle: scroll + click + revert
    g.onScroll(2734718);
    g.onMousedown(2734718, 2064000);
    g.onScroll(2111);  // reverted
    g.endLock(2734718);

    // Second click at similar position — no large scroll happened since endLock,
    // so pending is false, guard does not arm
    expect(g.pending).toBe(false);
    expect(g.onMousedown(2734718, 2064100)).toBe(false);

    // Third click after small scroll — still no guard
    g.onScroll(2736627);  // delta=1909 > 238 → pending!
    expect(g.pending).toBe(true);

    // But this is a normal within-viewport scroll, mousedown will arm
    g.onMousedown(2736627, 2065000);
    // Small scroll — not a native jump
    expect(g.onScroll(2736700)).toBe('ignored');
    expect(g.guardActive).toBe(false);
    // pending still true, scrollHandler backup handles it
    expect(g.onScrollIntoView(true)).toBe(true);
    g.endLock(2736627);
  });
});

// =================================================================
// Edge cases and robustness
// =================================================================

describe('NativeScrollGuard — edge cases', () => {
  const VP = 476;

  it('guard not re-armed by locked scroll events after revert', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);
    g.onScroll(6367);  // reverted → locked

    // Many scroll events during lock — none should re-arm pending
    for (let i = 0; i < 10; i++) {
      g.onScroll(3042723 + i * 100);
    }
    expect(g.pending).toBe(false);

    g.endLock(3042723);
    expect(g.pending).toBe(false);
  });

  it('very small native scroll below threshold is not reverted', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);
    g.onMousedown(3042723, 2300000);

    // Native scroll of only 100px — within viewport threshold
    expect(g.onScroll(3042623)).toBe('ignored');
    expect(g.guardActive).toBe(false);  // guard consumed, not reverted
    expect(g.pending).toBe(true);  // pending stays for scrollHandler
  });

  it('pending persists through multiple scrollbar adjustments', () => {
    const g = new NativeScrollGuard(VP);

    // Big scroll sets pending
    g.onScroll(3042723);
    expect(g.pending).toBe(true);

    // User adjusts scrollbar position slightly (still large deltas)
    g.onScroll(3040000);
    g.onScroll(3045000);
    expect(g.pending).toBe(true);  // still pending

    // Click arms guard
    expect(g.onMousedown(3045000, 2300000)).toBe(true);
  });

  it('scrollHandler backup works when native scroll does not occur', () => {
    const g = new NativeScrollGuard(VP);
    g.onScroll(3042723);

    // Mousedown arms guard
    g.onMousedown(3042723, 2300000);

    // No native scroll happens (rare but possible)
    // Guard consumed by small or no scroll
    g.guardActive = false;

    // scrollHandler fires as backup
    expect(g.onScrollIntoView(true)).toBe(true);
    expect(g.pending).toBe(false);
    expect(g.locked).toBe(true);
    g.endLock(3042723);
  });

  it('concurrent scroll detection and guard lifecycle', () => {
    const g = new NativeScrollGuard(VP);

    // Phase 1: scroll detection
    g.onScroll(2734718);
    expect(g.pending).toBe(true);

    // Phase 2: guard arm + revert
    g.onMousedown(2734718, 2064000);
    g.onScroll(2111);  // reverted
    expect(g.pending).toBe(false);
    expect(g.locked).toBe(true);

    // Phase 3: locked — all scrolls blocked
    g.onScroll(50000);
    g.onScroll(100000);
    expect(g.pending).toBe(false);

    // Phase 4: unlock
    g.endLock(2734718);
    expect(g.locked).toBe(false);

    // Phase 5: new cycle
    g.onScroll(709347);
    expect(g.pending).toBe(true);
    g.onMousedown(709347, 520000);
    g.onScroll(2734827);  // reverted
    g.endLock(709347);
    expect(g.pending).toBe(false);
  });
});
