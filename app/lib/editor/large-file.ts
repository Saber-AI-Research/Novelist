/**
 * Large file optimizations for CodeMirror 6.
 *
 * Strategy (from design-overview.md):
 * - Normal (< 1MB): Full WYSIWYG + all extensions
 * - Large (1-10MB): Disable WYSIWYG, disable expensive extensions,
 *   keep syntax highlighting + virtual scrolling
 * - Huge (> 10MB): Future Rust-backed viewport mode with ropey
 *
 * This module provides a reduced extension set for large files
 * and utilities for file size classification.
 */

export const enum FileSize {
  Normal,   // < 1 MB
  Large,    // 1-10 MB
  Huge,     // > 10 MB (not yet implemented)
}

export function classifyFileSize(bytes: number): FileSize {
  if (bytes > 10 * 1024 * 1024) return FileSize.Huge;
  if (bytes > 1 * 1024 * 1024) return FileSize.Large;
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
 * - markdown syntax highlighting (CM6 parser is incremental)
 * - search keymap (user-initiated, not per-keystroke)
 * - lineWrapping (CSS-only)
 * - drawSelection (lightweight)
 */
