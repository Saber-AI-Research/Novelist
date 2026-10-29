/**
 * Keep a `position: fixed` popup (context menu) inside the visible viewport,
 * including safe-area insets (notch, home indicator) and the on-screen
 * keyboard (visual viewport). The element keeps its own `left`/`top`; this
 * action only nudges them after layout and caps the height (scrolling the
 * popup) when it cannot fit.
 *
 * `enabled: false` leaves the raw placement untouched (desktop behavior).
 * Pass the anchor point as `x`/`y` so a re-positioned popup is re-clamped.
 */
import type { ActionReturn } from 'svelte/action';

export interface ClampToViewportOptions {
  enabled: boolean;
  /** Anchor point; a change re-runs the clamp. */
  x?: number;
  y?: number;
}

const EDGE_MARGIN_PX = 8;

interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function safeAreaInsets(): Insets {
  const probe = document.createElement('div');
  probe.style.cssText = [
    'position:fixed',
    'visibility:hidden',
    'pointer-events:none',
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)',
  ].join(';');
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

function clamp(node: HTMLElement) {
  node.style.maxHeight = '';
  node.style.overflowY = '';
  const rect = node.getBoundingClientRect();
  if (rect.width === 0 || node.offsetWidth === 0) return;
  // Root zoom (`html { transform: scale() }`): rects are post-transform,
  // inline left/top are pre-transform CSS pixels.
  const zoom = rect.width / node.offsetWidth || 1;
  const safe = safeAreaInsets();
  const vv = window.visualViewport;
  const viewLeft = vv?.offsetLeft ?? 0;
  const viewTop = vv?.offsetTop ?? 0;
  const viewWidth = vv?.width ?? window.innerWidth;
  const viewHeight = vv?.height ?? window.innerHeight;

  const minX = viewLeft + safe.left * zoom + EDGE_MARGIN_PX;
  const maxX = viewLeft + viewWidth - safe.right * zoom - EDGE_MARGIN_PX;
  const minY = viewTop + safe.top * zoom + EDGE_MARGIN_PX;
  const maxY = viewTop + viewHeight - safe.bottom * zoom - EDGE_MARGIN_PX;

  let dx = 0;
  if (rect.right > maxX) dx = maxX - rect.right;
  if (rect.left + dx < minX) dx = minX - rect.left;

  let dy = 0;
  const available = Math.max(0, maxY - minY);
  if (rect.height > available) {
    node.style.maxHeight = `${available / zoom}px`;
    node.style.overflowY = 'auto';
    dy = minY - rect.top;
  } else {
    if (rect.bottom > maxY) dy = maxY - rect.bottom;
    if (rect.top + dy < minY) dy = minY - rect.top;
  }

  if (dx !== 0) node.style.left = `${(parseFloat(node.style.left) || 0) + dx / zoom}px`;
  if (dy !== 0) node.style.top = `${(parseFloat(node.style.top) || 0) + dy / zoom}px`;
}

export function clampToViewport(
  node: HTMLElement,
  options: ClampToViewportOptions,
): ActionReturn<ClampToViewportOptions> {
  // Deferred to a microtask: the component writes the new `left`/`top`
  // (and portals the node) in the same flush that calls the action.
  const schedule = (opts: ClampToViewportOptions) => {
    if (!opts.enabled) return;
    queueMicrotask(() => {
      if (node.isConnected) clamp(node);
    });
  };
  schedule(options);
  return {
    update(next) {
      schedule(next);
    },
  };
}
