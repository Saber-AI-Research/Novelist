import { formatNumber, parseNumber, type NumberStyle } from './numbering';
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

/**
 * Names that exist in chapter-like folders but are NOT part of the numeric
 * sequence (序章, prologue, etc.). These are recognized for "skip" purposes
 * but never advance the inferred number.
 */
const SKIP_TITLES = new Set([
  '序章', '序', '楔子', '引子', '前言',
  '终章', '尾声', '番外', '后记', '附录',
  'Prologue', 'Epilogue', 'Foreword', 'Afterword', 'Appendix',
]);

interface FamilyMatch {
  template: Template;
  /** Numbers found in the folder for this family. */
  numbers: number[];
  /** Style detected from the dominant existing match (or template default if no match). */
  style: NumberStyle;
}

/** Built-in template families tried in inference order (most specific first). */
const BUILTIN_TEMPLATES: string[] = [
  '第{N}章', '第{N}回', '第{N}节', '第{N}卷', '第{N}部',
  'Chapter {N}', 'Ch{N}', 'Ch.{N}', 'Part {N}', 'Volume {N}', 'Vol{N}',
  '{N}-{title}', '{N}_{title}', '{N}.{title}', '{N} {title}',
];

/** Build a regex that matches files in this family (capturing the number portion). */
function familyMatcher(template: Template): RegExp {
  const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapePrefix = escRegex(template.prefix);
  // In the suffix, {title} means "any filename-safe content" (non-empty)
  const escapeSuffix = template.suffix
    .split('{title}')
    .map(escRegex)
    .join('(?:[^/]*?)');
  // Number portion: digits OR Chinese numerals
  return new RegExp(`^${escapePrefix}([\\d\\u4e00-\\u9fff]+)${escapeSuffix}\\.md$`);
}

function detectFamily(filenames: string[], template: Template): FamilyMatch | null {
  const re = familyMatcher(template);
  interface Match { value: number; style: NumberStyle; }
  const matches: Match[] = [];
  for (const f of filenames) {
    const m = re.exec(f);
    if (!m) continue;
    const stem = f.replace(/\.md$/, '');
    if (SKIP_TITLES.has(stem)) continue;
    const parsed = parseNumber(m[1]);
    if (parsed) matches.push({ value: parsed.value, style: parsed.style });
  }
  if (matches.length === 0) return null;
  // Dominant style = most common; tie-break by first occurrence
  const styleKey = (s: NumberStyle) => s.kind === 'arabic' ? `arabic:${s.width}` : s.kind;
  const counts = new Map<string, { count: number; sample: NumberStyle }>();
  for (const p of matches) {
    const k = styleKey(p.style);
    const cur = counts.get(k);
    if (cur) cur.count++; else counts.set(k, { count: 1, sample: p.style });
  }
  let bestKey = '';
  let bestCount = -1;
  for (const [k, v] of counts) {
    if (v.count > bestCount) { bestCount = v.count; bestKey = k; }
  }
  return {
    template,
    numbers: matches.map(m => m.value),
    style: counts.get(bestKey)!.sample,
  };
}

/**
 * Compute the filename to use when the user creates a new file in `folderFiles`.
 *
 * - Built-in families require ≥2 matches in the folder to kick in (avoids false positives).
 * - The user's default template gets threshold 1 (a single matching file activates it).
 * - Empty folder or nothing matches → render default template at N=1 with its natural style.
 * - Collision resolution: bump the number until free.
 */
export function inferNextName(folderFiles: string[], userDefaultTemplate: Template): string {
  const candidates: FamilyMatch[] = [];

  // Built-in families: threshold 2
  for (const tmplStr of BUILTIN_TEMPLATES) {
    const tmpl = parseTemplate(tmplStr);
    if (!tmpl) continue;
    const m = detectFamily(folderFiles, tmpl);
    if (m && m.numbers.length >= 2) candidates.push(m);
  }

  // User default: threshold 1
  const userMatch = detectFamily(folderFiles, userDefaultTemplate);
  if (userMatch && userMatch.numbers.length >= 1) candidates.push(userMatch);

  if (candidates.length === 0) {
    // No recognizable pattern → render user default at N=1
    const style = naturalStyleFor(userDefaultTemplate);
    return bumpUntilFree(userDefaultTemplate, 1, style, folderFiles);
  }

  // Highest match count wins
  candidates.sort((a, b) => b.numbers.length - a.numbers.length);
  const winner = candidates[0];
  const next = Math.max(...winner.numbers) + 1;
  return bumpUntilFree(winner.template, next, winner.style, folderFiles);
}

function naturalStyleFor(template: Template): NumberStyle {
  // 第{N}章 / 第{N}回 etc. defaults to chinese-lower; everything else arabic width 1
  if (template.prefix === '第' && /^[章回节卷部]/.test(template.suffix)) {
    return { kind: 'chinese-lower' };
  }
  return { kind: 'arabic', width: 1 };
}

function bumpUntilFree(
  template: Template,
  startN: number,
  style: NumberStyle,
  folderFiles: string[]
): string {
  const taken = new Set(folderFiles);
  let n = startN;
  for (let i = 0; i < 10000; i++) {
    const candidate = renderTemplate(template, n, style, null);
    if (!taken.has(candidate)) return candidate;
    n++;
  }
  return `Untitled ${Date.now()}.md`;
}

/**
 * Compute the new filename when an H1 has been written into a placeholder file.
 *
 * - If `currentName` is not a placeholder, returns null (caller should not rename).
 * - If `h1` sanitizes to empty, returns null (no rename).
 * - Else: produces a new filename per the rules in spec §3.5.
 *   On collision with `siblings`, appends " 2", " 3", … to the *whole stem*.
 */
export function renameFromH1(currentName: string, h1: string, siblings: string[]): string | null {
  if (!isPlaceholder(currentName)) return null;
  const sanitized = sanitizeFilenameStem(h1);
  if (sanitized.length === 0) return null;

  const newName = computeNewNameForPlaceholder(currentName, sanitized);
  if (newName === currentName) return null;

  return bumpStemUntilFree(newName, siblings, currentName);
}

/** Map a known placeholder filename + sanitized H1 → new filename. */
function computeNewNameForPlaceholder(currentName: string, h1Stem: string): string {
  // Untitled N: replace whole stem
  if (/^Untitled \d+\.md$/.test(currentName)) return `${h1Stem}.md`;
  // legacy scratch: replace whole stem
  if (/^novelist_scratch_\d+\.md$/.test(currentName)) return `${h1Stem}.md`;
  // {N}<sep>Untitled with title slot: substitute "Untitled" with H1
  const slotMatch = /^(\d+[-_. ])Untitled\.md$/.exec(currentName);
  if (slotMatch) return `${slotMatch[1]}${h1Stem}.md`;
  // No-slot placeholders (chapter prefixes) → append with separator
  const stem = currentName.replace(/\.md$/, '');
  const lastChar = stem.slice(-1);
  const sep = NO_SPACE_AFTER.has(lastChar) ? '' : ' ';
  return `${stem}${sep}${h1Stem}.md`;
}

function bumpStemUntilFree(newName: string, siblings: string[], currentName: string): string {
  const taken = new Set(siblings);
  taken.delete(currentName); // own name is not a collision
  if (!taken.has(newName)) return newName;

  const stem = newName.replace(/\.md$/, '');
  let n = 2;
  for (let i = 0; i < 10000; i++) {
    const candidate = `${stem} ${n}.md`;
    if (!taken.has(candidate)) return candidate;
    n++;
  }
  return newName; // give up; caller handles error
}
