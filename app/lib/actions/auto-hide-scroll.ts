/**
 * Overlay-scrollbar auto-hide.
 *
 * Our scrollbars are themed and transparent at rest (see `app/app.css`). The
 * thumb fades in on `:hover` via pure CSS; this module adds the *other* reveal
 * trigger — active scrolling (wheel / trackpad / keyboard) even when the
 * pointer isn't over the container — by toggling an `is-scrolling` class.
 *
 * A single capture-phase listener on `document` covers every scroll container
 * (the CodeMirror scroller, the sidebar tree, right panels, command-palette
 * lists, …) without each component opting in. Scroll events don't bubble, but
 * they DO fire during the capture phase at the document level, so one listener
 * sees them all — including containers mounted later.
 */

const HIDE_DELAY_MS = 900;
const timers = new WeakMap<Element, number>();

function onScroll(e: Event): void {
  const el = e.target as Element | null;
  if (!el || !(el instanceof Element)) return; // document/window scroll → skip
  el.classList.add('is-scrolling');
  const prev = timers.get(el);
  if (prev !== undefined) clearTimeout(prev);
  timers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove('is-scrolling');
      timers.delete(el);
    }, HIDE_DELAY_MS),
  );
}

/**
 * Start the global auto-hide listener. Returns a teardown function; call it
 * from the host component's cleanup (e.g. App.svelte onMount return).
 */
export function initScrollAutoHide(): () => void {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => document.removeEventListener('scroll', onScroll, { capture: true });
}
