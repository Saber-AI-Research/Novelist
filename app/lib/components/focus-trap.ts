const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

function focusableIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest('[hidden], [inert]'));
}

/**
 * Svelte action for modal dialogs: Tab / Shift+Tab cycle inside `node`,
 * focus moves into the dialog when it opens (unless a child already took
 * it, e.g. an autofocused input), and returns to the previously focused
 * element when the dialog closes.
 */
export function focusTrap(node: HTMLElement): { destroy(): void } {
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const items = focusableIn(node);
    if (items.length === 0) {
      e.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && node.contains(active);
    if (e.shiftKey && (!inside || active === first || active === node)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  }

  node.addEventListener('keydown', onKeydown);
  queueMicrotask(() => {
    if (!node.isConnected || node.contains(document.activeElement)) return;
    (focusableIn(node)[0] ?? node).focus();
  });

  return {
    destroy() {
      node.removeEventListener('keydown', onKeydown);
      // Restore focus only if it would otherwise be lost with the dialog;
      // never pull it away from something the close action focused.
      const active = document.activeElement;
      const lost = !active || active === document.body || node.contains(active);
      if (lost && previouslyFocused?.isConnected) previouslyFocused.focus();
    },
  };
}
