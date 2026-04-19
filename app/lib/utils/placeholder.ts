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
