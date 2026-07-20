/**
 * Large file optimizations for CodeMirror 6.
 *
 * Strategy (matching Editor.svelte):
 * - Normal (< 1MB): Full WYSIWYG + all extensions
 * - Large (1-3.5MB): Disable WYSIWYG and expensive extensions
 * - Huge (>= 3.5MB): Read-only stripped mode
 *
 * This module provides a reduced extension set for large files
 * and utilities for file size classification.
 */

export const enum FileSize {
  Normal,   // < 1 MB
  Large,    // 1-3.5 MB
  Huge,     // >= 3.5 MB, read-only
}

export function classifyFileSize(bytes: number): FileSize {
  if (bytes >= 3.5 * 1024 * 1024) return FileSize.Huge;
  if (bytes >= 1 * 1024 * 1024) return FileSize.Large;
  return FileSize.Normal;
}

/**
 * For large files, these CM6 extensions should be DISABLED
 * because they have O(document) or O(visible × expensive) cost:
 *
 * - WYSIWYG decorations (custom buildDecorations walks syntax tree per update)
 * - highlightSelectionMatches (searches entire doc for selection text)
 * - bracketMatching (can be slow on deeply nested structures)
 * - closeBrackets (minor overhead but unnecessary for plain mode)
 * - highlightActiveLine (minor but adds up)
 * - scrollPastEnd (can cause measurement issues on huge docs)
 *
 * Extensions that are SAFE for large files:
 * - lineNumbers (CM6 virtualizes this well)
 * - history (uses efficient change tracking)
 * - search keymap (user-initiated, not per-keystroke)
 * - drawSelection (lightweight)
 * - selected-quote and structural hierarchy handlers (action-local)
 */
