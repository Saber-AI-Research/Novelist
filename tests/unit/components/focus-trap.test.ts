import { afterEach, describe, expect, it } from 'vitest';
import { focusTrap } from '$lib/components/focus-trap';

function dialog(): { node: HTMLElement; first: HTMLButtonElement; last: HTMLInputElement; opener: HTMLButtonElement } {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const node = document.createElement('div');
  node.tabIndex = -1;
  node.innerHTML = '<button id="first">A</button><button disabled>skip</button><input id="last" />';
  document.body.appendChild(node);
  return {
    node,
    first: node.querySelector<HTMLButtonElement>('#first')!,
    last: node.querySelector<HTMLInputElement>('#last')!,
    opener,
  };
}

function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusTrap', () => {
  it('moves focus into the dialog when it opens', async () => {
    const { node, first } = dialog();
    focusTrap(node);
    await Promise.resolve();
    expect(document.activeElement).toBe(first);
  });

  it('wraps Tab from the last control to the first and Shift+Tab back', () => {
    const { node, first, last } = dialog();
    focusTrap(node);
    last.focus();
    expect(tab(last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(tab(first, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the opener when the dialog closes', () => {
    const { node, last, opener } = dialog();
    const trap = focusTrap(node);
    last.focus();
    trap.destroy();
    node.remove();
    expect(document.activeElement).toBe(opener);
  });
});
