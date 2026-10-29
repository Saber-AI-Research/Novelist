/**
 * Move a popup to `document.body` so `position: fixed` resolves against the
 * viewport even when an ancestor creates a containing block (transformed
 * sheets, scroll containers with `contain`).
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
