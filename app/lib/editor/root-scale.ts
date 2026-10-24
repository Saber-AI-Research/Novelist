/**
 * App zoom is `transform: scale(n)` on the root element (`uiStore.setZoom`).
 * `clientX/Y` and `getBoundingClientRect()` are scaled viewport coordinates,
 * while `left`/`top` of a `position: fixed` element inside the transformed
 * root are pre-transform layout coordinates: divide by this factor first.
 */
export function rootScale(): number {
  const match = document.documentElement.style.transform.match(/scale\(([^)]+)\)/);
  return (match && parseFloat(match[1])) || 1;
}
