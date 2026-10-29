/**
 * Touch/pen long-press — the touch counterpart of `contextmenu`.
 *
 * `use:longPress={{ onLongPress }}` fires after the finger rests ~500ms
 * without travelling more than 10px. Mouse pointers are ignored (they keep
 * their native right-click path). `pointerdown` is never prevented, so
 * native scrolling and text selection still work; any scroll or
 * `pointercancel` simply abandons the gesture.
 *
 * Dedupe rules, so one gesture opens exactly one menu:
 * - Android also raises `contextmenu` for a long-press. Whichever comes first
 *   (our timer or the platform event) opens the menu; the other is swallowed
 *   before it reaches the component's `oncontextmenu` handler.
 * - The `click` some engines synthesize when the finger lifts is swallowed.
 * - Nested long-press regions: the innermost element claims the gesture.
 */
import type { ActionReturn } from 'svelte/action';

export interface LongPressEvent {
  clientX: number;
  clientY: number;
  /** The element the finger originally landed on. */
  target: EventTarget | null;
}

export interface LongPressOptions {
  onLongPress: (e: LongPressEvent) => void;
  /** Hold time in milliseconds (default 500). */
  delay?: number;
}

const DEFAULT_DELAY_MS = 500;
const MOVE_TOLERANCE_PX = 10;
/** Trailing click/contextmenu this soon after the finger lifts belongs to the same gesture. */
const GESTURE_TAIL_MS = 600;

/** pointerdown events already claimed by a nested long-press region. */
const claimedPointerDowns = new WeakSet<Event>();

/** Long-press inside text fields stays native (caret, selection, paste menu). */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function longPress(
  node: HTMLElement,
  options: LongPressOptions,
): ActionReturn<LongPressOptions> {
  let opts = options;
  let holdTimer: number | null = null;
  let tailTimer: number | null = null;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startTarget: EventTarget | null = null;
  let lastTouchEndAt = Number.NEGATIVE_INFINITY;
  /** This gesture already opened a menu; swallow its trailing click/contextmenu. */
  let fired = false;

  function clearHoldTimer() {
    if (holdTimer !== null) {
      window.clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function clearTailTimer() {
    if (tailTimer !== null) {
      window.clearTimeout(tailTimer);
      tailTimer = null;
    }
  }

  function stopTracking() {
    clearHoldTimer();
    if (pointerId === null) return;
    pointerId = null;
    lastTouchEndAt = performance.now();
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
    window.removeEventListener('scroll', onScroll, true);
  }

  function fire(clientX: number, clientY: number) {
    clearHoldTimer();
    fired = true;
    opts.onLongPress({ clientX, clientY, target: startTarget });
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse') return;
    if (!e.isPrimary) {
      // A second finger joined (pinch): not a long-press.
      clearHoldTimer();
      return;
    }
    if (claimedPointerDowns.has(e)) return;
    claimedPointerDowns.add(e);
    if (e.target instanceof Element && e.target.closest(EDITABLE_SELECTOR)) return;

    stopTracking();
    clearTailTimer();
    fired = false;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startTarget = e.target;
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      fire(startX, startY);
    }, opts.delay ?? DEFAULT_DELAY_MS);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== pointerId || holdTimer === null) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE_PX) clearHoldTimer();
  }

  function onPointerEnd(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    stopTracking();
    if (fired) {
      clearTailTimer();
      tailTimer = window.setTimeout(() => {
        tailTimer = null;
        fired = false;
      }, GESTURE_TAIL_MS);
    }
  }

  function onScroll() {
    clearHoldTimer();
  }

  function isTouchContextMenu(e: MouseEvent): boolean {
    if (pointerId !== null) return true;
    if (performance.now() - lastTouchEndAt < GESTURE_TAIL_MS) return true;
    const pointerType = (e as Partial<PointerEvent>).pointerType;
    return pointerType === 'touch' || pointerType === 'pen';
  }

  function onContextMenu(e: MouseEvent) {
    if (e.target instanceof Element && e.target.closest(EDITABLE_SELECTOR)) return;
    if (fired) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!isTouchContextMenu(e)) return; // mouse right-click / menu key: native path
    e.preventDefault();
    e.stopPropagation();
    if (pointerId === null) startTarget = e.target;
    fire(e.clientX, e.clientY);
  }

  function onClick(e: MouseEvent) {
    if (!fired) return;
    e.preventDefault();
    e.stopPropagation();
  }

  node.addEventListener('pointerdown', onPointerDown, { passive: true });
  // Bubble phase: the innermost long-press region sees the platform
  // `contextmenu` first and stops it before outer regions and Svelte's
  // delegated `oncontextmenu` handlers (attached at the root).
  node.addEventListener('contextmenu', onContextMenu);
  node.addEventListener('click', onClick, true);

  return {
    update(next) {
      opts = next;
    },
    destroy() {
      stopTracking();
      clearTailTimer();
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('contextmenu', onContextMenu);
      node.removeEventListener('click', onClick, true);
    },
  };
}
