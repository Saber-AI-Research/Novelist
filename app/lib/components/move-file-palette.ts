/**
 * Window event that asks App.svelte to open `MoveFilePalette` for a specific
 * file or folder (the sidebar's touch "Move to…" replacement for drag-drop).
 * Without this event the palette moves the active tab's file (Cmd+M).
 */
export const OPEN_MOVE_PALETTE_EVENT = 'novelist:open-move-palette';

export interface OpenMovePaletteDetail {
  sourcePath: string;
}

export function requestMovePalette(sourcePath: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenMovePaletteDetail>(OPEN_MOVE_PALETTE_EVENT, { detail: { sourcePath } }),
  );
}
