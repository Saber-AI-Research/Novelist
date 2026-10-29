/**
 * "Tap a selected node to edit it" for touch and pen, which have no reliable
 * dblclick. Mouse keeps dblclick only. The first tap merely selects (so a
 * drag never opens an editor), and a press that travelled is a drag.
 */
export interface NodePress {
  pointerType: string;
  x: number;
  y: number;
  wasSelected: boolean;
}

/** Farther than this between press and click is a drag, not a tap. */
const TAP_SLOP_PX = 8;

/** Capture on pointerdown, before SvelteFlow updates the selection. */
export function recordPress(e: PointerEvent, selected: boolean): NodePress {
  return { pointerType: e.pointerType, x: e.clientX, y: e.clientY, wasSelected: selected };
}

export function isTapOnSelected(
  press: NodePress | null,
  click: { clientX: number; clientY: number },
): boolean {
  if (!press || press.pointerType === 'mouse' || !press.wasSelected) return false;
  return Math.hypot(click.clientX - press.x, click.clientY - press.y) <= TAP_SLOP_PX;
}
