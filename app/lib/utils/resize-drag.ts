/**
 * Generic mouse-drag handler factory for resize operations.
 *
 * Captures a snapshot at mousedown via `init(startEv)` (e.g. starting X and
 * width), then passes it to every `onMove` call so delta math doesn't
 * compound against a live reactive value.
 */
export function makeResizeHandler<S = void>(opts: {
  /** Called with `true` on start and `false` on release. */
  setDragging: (v: boolean) => void;
  /** Called once per frame during drag; `start` is whatever `init` returned. */
  onMove: (ev: MouseEvent, start: S) => void;
  /** Captured once at mousedown. Typical use: record startX and starting width. */
  init?: (startEv: MouseEvent) => S;
  /** Optional precondition; drag doesn't start if this returns false. */
  shouldStart?: () => boolean;
}): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    if (opts.shouldStart && !opts.shouldStart()) return;
    e.preventDefault();
    opts.setDragging(true);
    const start = opts.init ? opts.init(e) : (undefined as unknown as S);
    const onMove = (ev: MouseEvent) => opts.onMove(ev, start);
    const onUp = () => {
      opts.setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}
