import { formatNumber, type NumberStyle } from './numbering';
import { sanitizeFilenameStem } from './filename';

export interface Template {
  raw: string;
  /** Literal text before {N} */
  prefix: string;
  /** Literal text after {N} (may include the literal "{title}" placeholder) */
  suffix: string;
  /** True if the suffix contains "{title}" */
  hasTitleSlot: boolean;
  /** Where the title slot lives relative to the number; null when no slot */
  titleSlotPosition: 'after' | null;
}

/**
 * Parse a user-facing template string into a descriptor.
 * Templates must contain exactly one {N}; may optionally contain {title}.
 * Returns null on validation failure.
 */
export function parseTemplate(raw: string): Template | null {
  if (raw.length === 0) return null;
  const numMatches = raw.match(/\{N\}/g) ?? [];
  if (numMatches.length !== 1) return null;
  const titleMatches = raw.match(/\{title\}/g) ?? [];
  if (titleMatches.length > 1) return null;

  const idx = raw.indexOf('{N}');
  const prefix = raw.slice(0, idx);
  const suffix = raw.slice(idx + 3);

  return {
    raw,
    prefix,
    suffix,
    hasTitleSlot: titleMatches.length === 1,
    titleSlotPosition: titleMatches.length === 1 ? 'after' : null,
  };
}

/** Characters after which we do NOT insert a space when appending the H1. */
const NO_SPACE_AFTER = new Set(['】', '）', ')', ']', '」', '』', '》', '>', ':', '：', '、', '.']);

/**
 * Render a template into a filename (with .md extension).
 *
 * - `value` and `style` produce the number portion.
 * - `title` is the H1 text; null/empty means use the placeholder form.
 *
 * Behavior:
 * - Template has {title} slot: substitute "Untitled" (or sanitized title) into slot
 * - Template has no {title} slot AND title is empty: render `prefix{N}suffix.md`
 * - Template has no {title} slot AND title given: special-case for "Untitled {N}"
 *   (replace whole stem with title); otherwise append "stem<sep><title>" where
 *   <sep> is " " unless the stem ends with one of NO_SPACE_AFTER.
 */
export function renderTemplate(
  template: Template,
  value: number,
  style: NumberStyle,
  title: string | null
): string {
  const numStr = formatNumber(value, style);
  const sanitized = title ? sanitizeFilenameStem(title) : '';

  if (template.hasTitleSlot) {
    const fill = sanitized.length > 0 ? sanitized : 'Untitled';
    const stem = template.prefix + numStr + template.suffix.replace('{title}', fill);
    return `${stem}.md`;
  }

  // No title slot
  const baseStem = template.prefix + numStr + template.suffix;
  if (sanitized.length === 0) return `${baseStem}.md`;

  // Special case: pure "Untitled {N}" → title replaces the whole stem
  if (template.prefix === 'Untitled ' && template.suffix === '') {
    return `${sanitized}.md`;
  }

  // Append with optional space
  const lastChar = baseStem.slice(-1);
  const sep = NO_SPACE_AFTER.has(lastChar) ? '' : ' ';
  return `${baseStem}${sep}${sanitized}.md`;
}

/**
 * Built-in placeholder regexes — any filename matching one of these is
 * considered "placeholder" (i.e., eligible for H1 auto-rename).
 *
 * Single source of truth; each pattern matches ONLY the placeholder form
 * (number + decoration only, no user-supplied title).
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^Untitled \d+\.md$/,
  /^第([\u4e00-\u9fff\d]+)章\.md$/,
  /^Chapter \d+\.md$/,
  /^Ch\.?\d+\.md$/,
  /^Part \d+\.md$/,
  /^\d+[-_. ]Untitled\.md$/,
  /^novelist_scratch_\d+\.md$/, // legacy migration
];

/** True if the filename (basename, with .md) is in the auto-generated placeholder set. */
export function isPlaceholder(filename: string): boolean {
  return PLACEHOLDER_PATTERNS.some(re => re.test(filename));
}
