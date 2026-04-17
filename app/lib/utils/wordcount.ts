/**
 * CJK-aware word count — single-pass algorithm.
 *
 * Walks the string once, classifying each character:
 * - CJK character → count +1 immediately
 * - Whitespace → ends any in-progress Latin word
 * - Other (Latin letter/digit/punct) → part of a Latin word
 *
 * Previous implementation used two full-document regex scans (match + replace).
 * This version is O(N) single-pass with no intermediate string allocations.
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0;

  let count = 0;
  let inLatinWord = false;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Fast ASCII path (most common)
    if (code <= 0x7F) {
      // Whitespace: space, tab, newline, carriage return
      if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) {
        if (inLatinWord) { count++; inLatinWord = false; }
      } else {
        inLatinWord = true;
      }
      continue;
    }

    // CJK Unified Ideographs and common ranges
    if (isCJK(code, text, i)) {
      if (inLatinWord) { count++; inLatinWord = false; }
      count++;
      // Skip low surrogate if we consumed a surrogate pair
      if (code >= 0xD800 && code <= 0xDBFF) i++;
      continue;
    }

    // Other non-ASCII (accented Latin, etc.) — treat as Latin word part
    inLatinWord = true;
    // Skip low surrogate
    if (code >= 0xD800 && code <= 0xDBFF) i++;
  }

  // Flush trailing Latin word
  if (inLatinWord) count++;

  return count;
}

/** Check if character at position is CJK (including surrogate pairs for extension planes). */
function isCJK(code: number, text: string, i: number): boolean {
  // BMP CJK ranges
  if (code >= 0x4E00 && code <= 0x9FFF) return true;  // CJK Unified Ideographs
  if (code >= 0x3400 && code <= 0x4DBF) return true;  // CJK Extension A
  if (code >= 0xF900 && code <= 0xFAFF) return true;  // CJK Compatibility Ideographs
  if (code >= 0x3000 && code <= 0x303F) return true;  // CJK Symbols and Punctuation
  if (code >= 0xFF00 && code <= 0xFFEF) return true;  // Fullwidth Forms

  // Supplementary planes (surrogate pairs) — Extension B through F
  if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
    const low = text.charCodeAt(i + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) {
      const cp = ((code - 0xD800) << 10) + (low - 0xDC00) + 0x10000;
      if (cp >= 0x20000 && cp <= 0x2A6DF) return true;  // Extension B
      if (cp >= 0x2A700 && cp <= 0x2B73F) return true;  // Extension C
      if (cp >= 0x2B740 && cp <= 0x2B81F) return true;  // Extension D
      if (cp >= 0x2B820 && cp <= 0x2CEAF) return true;  // Extension E
      if (cp >= 0x2CEB0 && cp <= 0x2EBEF) return true;  // Extension F
      if (cp >= 0x30000 && cp <= 0x3134F) return true;  // Extension G
    }
  }

  return false;
}
