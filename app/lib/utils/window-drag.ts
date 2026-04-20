import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Titlebar drag handler: calls `window.startDragging()` when the mousedown
 * is on a non-interactive element within the titlebar drag zone.
 *
 * The drag zone is either any element inside `[data-tauri-drag-region]`, or
 * the top 38px of the window (macOS traffic-light area).
 */
export function handleTitlebarDrag(e: MouseEvent) {
  const target = e.target as HTMLElement;
  // Don't interfere with interactive elements or the editor
  if (target.closest('button, input, a, [role="button"], select, textarea, .cm-editor, [contenteditable]')) return;
  const TITLEBAR_HEIGHT = 38;
  if (target.closest('[data-tauri-drag-region]') || e.clientY <= TITLEBAR_HEIGHT) {
    e.preventDefault();
    getCurrentWindow().startDragging();
  }
}
