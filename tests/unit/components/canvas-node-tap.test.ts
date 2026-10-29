import { describe, expect, it } from 'vitest';
import { isTapOnSelected, type NodePress } from '$lib/components/canvas/node-tap';

const press = (overrides: Partial<NodePress> = {}): NodePress => ({
  pointerType: 'touch',
  x: 100,
  y: 100,
  wasSelected: true,
  ...overrides,
});

describe('isTapOnSelected', () => {
  it('edits on a touch or pen tap of an already selected node', () => {
    expect(isTapOnSelected(press(), { clientX: 103, clientY: 98 })).toBe(true);
    expect(isTapOnSelected(press({ pointerType: 'pen' }), { clientX: 100, clientY: 100 })).toBe(true);
  });

  it('only selects on the first tap, so a tap never edits an unselected node', () => {
    expect(isTapOnSelected(press({ wasSelected: false }), { clientX: 100, clientY: 100 })).toBe(false);
  });

  it('leaves mouse editing to dblclick', () => {
    expect(isTapOnSelected(press({ pointerType: 'mouse' }), { clientX: 100, clientY: 100 })).toBe(false);
  });

  it('treats a press that travelled as a drag', () => {
    expect(isTapOnSelected(press(), { clientX: 120, clientY: 100 })).toBe(false);
  });

  it('ignores a click without a recorded press', () => {
    expect(isTapOnSelected(null, { clientX: 100, clientY: 100 })).toBe(false);
  });
});
