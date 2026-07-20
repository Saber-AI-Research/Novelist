import { formatNumber, parseNumber, type NumberStyle } from './numbering';
import { sanitizeFilenameStem } from './filename';

export interface Template {
  raw: string;
  /** True when the template contains a `{N}` (or variant) placeholder. */
  hasNumberSlot: boolean;
  /**
   * Literal text before the number placeholder when `hasNumberSlot` is true,
   * or before the title placeholder otherwise. Empty when the slot is the
   * very first thing in the template.
   */
  prefix: string;
  /**
   * Literal text after the number placeholder (may include "{title}") when
   * `hasNumberSlot` is true, or after the title placeholder otherwise.
   */
  suffix: string;
  /** True if the template contains "{title}". */
  hasTitleSlot: boolean;
  /** Where the title slot lives relative to the number; null when no slot or no number. */
  titleSlotPosition: 'after' | null;
  /**
   * Explicit style override extracted from the placeholder syntax:
   *   - `{N}`         → null (natural style — driven by template/folder context)
   *   - `{2N}`/`{3N}` → `{ kind: 'arabic', width: 2|3 }` (zero-padded)
   *   - `{CN}`        → `{ kind: 'chinese-lower' }` (一, 二, 三, ...)
   *   - `{rN}`        → `{ kind: 'roman-upper' }`
   *
   * Always null when `hasNumberSlot` is false.
   */
  forceStyle: NumberStyle | null;
}

/**
 * Recognized placeholder tokens for the number slot:
 *   {N}       — natural style
 *   {<d>N}    — Arabic padded to <d> digits (e.g. {3N} → 001, 002, ...)
 *   {CN}      — Chinese (一, 二, 三, ...)
 *   {rN}      — Roman (I, II, III, ...)
 */
const PLACEHOLDER_TOKEN_RE = /\{(\d+|C|r)?N\}/g;

function tokenToStyle(token: string | undefined): NumberStyle | null {
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    return { kind: 'arabic', width: parseInt(token, 10) };
  }
  if (token === 'C') return { kind: 'chinese-lower' };
  if (token === 'r') return { kind: 'roman-upper' };
  return null;
}

/**
 * Parse a user-facing template string into a descriptor.
 *
 * A template must contain at least one of `{N}` (or variant) and `{title}`,
 * each appearing at most once. Both `第{N}章-{title}` and `{title}` are
 * valid; bare literal strings without any slot are rejected so that the
 * setting can't silently produce filename collisions.
 */
/** Single-token regex (no /g) for whole-string validity testing. */
const PLACEHOLDER_TOKEN_RE_SINGLE = /^\{(?:\d+|C|r)?N\}$/;

export function parseTemplate(raw: string): Template | null {
  if (raw.length === 0) return null;
  const numMatches = Array.from(raw.matchAll(PLACEHOLDER_TOKEN_RE));
  if (numMatches.length > 1) return null;
  const titleMatches = raw.match(/\{title\}/g) ?? [];
  if (titleMatches.length > 1) return null;
  if (numMatches.length === 0 && titleMatches.length === 0) return null;

  // Reject typos like `{cN}`, `{Title}`, `{tile}` — any brace-delimited
  // token in the raw template that isn't a recognized placeholder must
  // not be silently treated as literal text. Macros (e.g. `{date:YYMMDD}`)
  // are already resolved upstream of parseTemplate.
  const allBraceTokens = raw.match(/\{[^{}]*\}/g) ?? [];
  for (const tok of allBraceTokens) {
    if (tok === '{title}') continue;
    if (PLACEHOLDER_TOKEN_RE_SINGLE.test(tok)) continue;
    return null;
  }

  if (numMatches.length === 1) {
    const match = numMatches[0];
    const idx = match.index!;
    const tokenLen = match[0].length;
    const prefix = raw.slice(0, idx);
    const suffix = raw.slice(idx + tokenLen);
    const forceStyle = tokenToStyle(match[1]);

    return {
      raw,
      hasNumberSlot: true,
      prefix,
      suffix,
      hasTitleSlot: titleMatches.length === 1,
      titleSlotPosition: titleMatches.length === 1 ? 'after' : null,
      forceStyle,
    };
  }

  // Title-only template — no `{N}` slot.
  const titleIdx = raw.indexOf('{title}');
  return {
    raw,
    hasNumberSlot: false,
    prefix: raw.slice(0, titleIdx),
    suffix: raw.slice(titleIdx + '{title}'.length),
    hasTitleSlot: true,
    titleSlotPosition: null,
    forceStyle: null,
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
  const sanitized = title ? sanitizeFilenameStem(title) : '';

  if (!template.hasNumberSlot) {
    const fill = sanitized.length > 0 ? sanitized : 'Untitled';
    return `${template.prefix}${fill}${template.suffix}.md`;
  }

  const numStr = formatNumber(value, style);

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
  // Title-only template (`{title}`) renders as `Untitled.md`, then
  // `Untitled 2.md`, `Untitled 3.md`, ... on collision.
  /^Untitled\.md$/,
  /^Untitled \d+\.md$/,
  /^第([\u4e00-\u9fff\d]+)章\.md$/,
  /^Chapter \d+\.md$/,
  /^Ch\.?\d+\.md$/,
  /^Part \d+\.md$/,
  /^\d+[-_. ]Untitled\.md$/,
  // Date-prefixed Untitled with counter: `260508_Untitled 1.md`,
  // `20260508-Untitled 12.md`, etc. The date portion belongs to the user;
  // H1 auto-rename must replace the "Untitled N" portion only.
  /^\d+[-_. ]Untitled \d+\.md$/,
  // Legacy: pre-v0.1.x timestamp-scratch naming. Kept so existing files in
  // user folders auto-rename on first save. Remove after v0.3.x.
  /^novelist_scratch_\d+\.md$/,
];

function splitMarkdownFilename(filename: string): { stem: string; extension: string } | null {
  const match = /\.(?:markdown|md)$/i.exec(filename);
  if (!match) return null;
  return {
    stem: filename.slice(0, -match[0].length),
    extension: match[0],
  };
}

/** True if the Markdown filename is in the auto-generated placeholder set. */
export function isPlaceholder(filename: string): boolean {
  const parts = splitMarkdownFilename(filename);
  if (!parts) return false;
  const canonicalName = `${parts.stem}.md`;
  return PLACEHOLDER_PATTERNS.some(re => re.test(canonicalName));
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

function detectFamily(
  filenames: string[],
  template: Template,
  maxValue?: number,
): FamilyMatch | null {
  const re = familyMatcher(template);
  interface Match { value: number; style: NumberStyle; }
  const matches: Match[] = [];
  for (const f of filenames) {
    const m = re.exec(f);
    if (!m) continue;
    const stem = f.replace(/\.md$/, '');
    if (SKIP_TITLES.has(stem)) continue;
    const parsed = parseNumber(m[1]);
    if (!parsed) continue;
    if (maxValue !== undefined && parsed.value > maxValue) continue;
    matches.push({ value: parsed.value, style: parsed.style });
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
/**
 * Plausibility cap for builtin family detection. Generic builtins like
 * `{N}_{title}` would otherwise mis-interpret a date prefix like `260508` as a
 * 260508-th chapter, then "increment" it to 260509 — producing files that
 * advance by date instead of by N. The cap (chosen well above any plausible
 * chapter count) keeps date-prefixed user templates working while still
 * letting the builtins kick in for novels with hundreds or low thousands of
 * chapters. The user's own template is never subject to this cap.
 */
const BUILTIN_FAMILY_MAX_VALUE = 9999;

export function inferNextName(folderFiles: string[], userDefaultTemplate: Template): string {
  // Title-only template: render once with placeholder "Untitled" and bump
  // on collision using the same suffix scheme as H1 rename.
  if (!userDefaultTemplate.hasNumberSlot) {
    const baseName = renderTemplate(userDefaultTemplate, 0, { kind: 'arabic', width: 1 }, null);
    return bumpStemUntilFree(baseName, folderFiles, '');
  }

  // User default: threshold 1, no plausibility cap (trusts user intent).
  const userMatch = detectFamily(folderFiles, userDefaultTemplate);
  if (userMatch && userMatch.numbers.length >= 1) {
    const next = Math.max(...userMatch.numbers) + 1;
    const style = userMatch.template.forceStyle ?? userMatch.style;
    return bumpUntilFree(userMatch.template, next, style, folderFiles);
  }

  // Builtin families: threshold 2, plausibility cap to avoid treating date
  // prefixes as chapter numbers.
  const candidates: FamilyMatch[] = [];
  for (const tmplStr of BUILTIN_TEMPLATES) {
    const tmpl = parseTemplate(tmplStr);
    if (!tmpl) continue;
    const m = detectFamily(folderFiles, tmpl, BUILTIN_FAMILY_MAX_VALUE);
    if (m && m.numbers.length >= 2) candidates.push(m);
  }

  if (candidates.length === 0) {
    // No recognizable pattern → render user default at N=1
    const style = naturalStyleFor(userDefaultTemplate);
    return bumpUntilFree(userDefaultTemplate, 1, style, folderFiles);
  }

  // Highest match count wins
  candidates.sort((a, b) => b.numbers.length - a.numbers.length);
  const winner = candidates[0];
  const next = Math.max(...winner.numbers) + 1;
  // Explicit forceStyle on the user's template (e.g. `{3N}`) wins over the
  // style sampled from existing folder files.
  const style = winner.template.forceStyle ?? winner.style;
  return bumpUntilFree(winner.template, next, style, folderFiles);
}

function naturalStyleFor(template: Template): NumberStyle {
  // Explicit override from the placeholder token (e.g. {3N}, {CN}) wins.
  // Bare {N} is always Arabic — users opt into Chinese with {CN}.
  if (template.forceStyle) return template.forceStyle;
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
  const parts = splitMarkdownFilename(currentName);
  const extension = parts?.extension ?? '.md';
  const canonicalName = `${parts?.stem ?? currentName}.md`;
  // Bare Untitled.md (from a title-only template): replace whole stem
  if (/^Untitled\.md$/.test(canonicalName)) return `${h1Stem}${extension}`;
  // Untitled N: replace whole stem
  if (/^Untitled \d+\.md$/.test(canonicalName)) return `${h1Stem}${extension}`;
  // legacy scratch: replace whole stem
  if (/^novelist_scratch_\d+\.md$/.test(canonicalName)) return `${h1Stem}${extension}`;
  // {date}<sep>Untitled <N>: keep the date prefix, drop the "Untitled N"
  // suffix. e.g. `260508_Untitled 3.md` + `开篇` → `260508_开篇.md`.
  const datedSlotMatch = /^(\d+[-_. ])Untitled \d+\.md$/.exec(canonicalName);
  if (datedSlotMatch) return `${datedSlotMatch[1]}${h1Stem}${extension}`;
  // {N}<sep>Untitled with title slot: substitute "Untitled" with H1
  const slotMatch = /^(\d+[-_. ])Untitled\.md$/.exec(canonicalName);
  if (slotMatch) return `${slotMatch[1]}${h1Stem}${extension}`;
  // No-slot placeholders (chapter prefixes) → append with separator
  const stem = parts?.stem ?? currentName;
  const lastChar = stem.slice(-1);
  const sep = NO_SPACE_AFTER.has(lastChar) ? '' : ' ';
  return `${stem}${sep}${h1Stem}${extension}`;
}

function bumpStemUntilFree(newName: string, siblings: string[], currentName: string): string {
  const taken = new Set(siblings);
  taken.delete(currentName); // own name is not a collision
  if (!taken.has(newName)) return newName;

  const parts = splitMarkdownFilename(newName);
  const stem = parts?.stem ?? newName;
  const extension = parts?.extension ?? '.md';
  let n = 2;
  for (let i = 0; i < 10000; i++) {
    const candidate = `${stem} ${n}${extension}`;
    if (!taken.has(candidate)) return candidate;
    n++;
  }
  return newName; // give up; caller handles error
}

/**
 * Path B of ongoing H1→filename sync. Compute the new filename when a tab's
 * H1 has changed from `oldH1` to `newH1` and the file is already past the
 * placeholder→title transition (Path A in tabsStore.tryRenameAfterSave).
 *
 * Returns null when:
 * - either side sanitizes to empty (no anchor to act on)
 * - old and new sanitize to the same stem (nothing to do)
 * - the sanitized old H1 is not present in the current filename stem
 *   (i.e. the user manually renamed the file — sync auto-detaches)
 *
 * On a hit, the rightmost occurrence of sanitized old H1 inside the stem is
 * replaced with sanitized new H1 (lastIndexOf — title slot is conventionally
 * at the end of the stem). Resulting collisions with `siblings` get bumped
 * via the existing `bumpStemUntilFree` ` 2`/` 3`/… scheme.
 */
export function applyH1Substitution(
  currentName: string,
  oldH1: string,
  newH1: string,
  siblings: string[],
): string | null {
  const sanitizedOld = sanitizeFilenameStem(oldH1);
  const sanitizedNew = sanitizeFilenameStem(newH1);
  if (sanitizedOld.length === 0) return null;
  if (sanitizedNew.length === 0) return null;
  if (sanitizedOld === sanitizedNew) return null;

  const extensionMatch = /\.(?:markdown|md)$/i.exec(currentName);
  const extension = extensionMatch?.[0] ?? '.md';
  const stem = extensionMatch
    ? currentName.slice(0, -extension.length)
    : currentName;
  const idx = stem.lastIndexOf(sanitizedOld);
  if (idx === -1) return null;

  const newStem = stem.slice(0, idx) + sanitizedNew + stem.slice(idx + sanitizedOld.length);
  const newName = `${newStem}${extension}`;
  // (no `newName === currentName` guard needed — earlier guards ensure
  // sanitizedOld !== sanitizedNew and idx >= 0, so the stem must differ.)

  return bumpStemUntilFree(newName, siblings, currentName);
}

/**
 * Matcher for a template's own placeholder form — the filename produced when
 * the file was created with no title yet (the "Untitled" fill), e.g.
 * `第{N}章-{title}` → `第3章-Untitled.md`, `draft-{title}` → `draft-Untitled.md`.
 *
 * PLACEHOLDER_PATTERNS only knows the built-in families; user templates with
 * a {title} slot render placeholder names the static list can't enumerate, so
 * Path A of the H1 auto-rename additionally consults this template-derived
 * matcher. Templates whose macros (e.g. {date}) were resolved at creation
 * time won't match here — their resolved forms are digit-prefixed and already
 * covered by the built-in `{N}<sep>Untitled` patterns.
 *
 * Captures: [1] before the fill, [2] optional collision counter, [3] after.
 */
function templateTitleSlotMatcher(templateRaw: string): RegExp | null {
  const template = parseTemplate(templateRaw);
  if (!template || !template.hasTitleSlot) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (template.hasNumberSlot) {
    const [pre, post = ''] = template.suffix.split('{title}');
    return new RegExp(
      `^(${esc(template.prefix)}[\\d\\u4e00-\\u9fff]+${esc(pre)})Untitled( \\d+)?(${esc(post)})\\.md$`,
    );
  }
  return new RegExp(
    `^(${esc(template.prefix)})Untitled( \\d+)?(${esc(template.suffix)})\\.md$`,
  );
}

/** True if `filename` is `templateRaw`'s rendered placeholder (Untitled fill). */
export function isTemplateTitlePlaceholder(filename: string, templateRaw: string): boolean {
  const re = templateTitleSlotMatcher(templateRaw);
  const parts = splitMarkdownFilename(filename);
  return re && parts ? re.test(`${parts.stem}.md`) : false;
}

/**
 * Path A companion to `renameFromH1` for template-derived placeholders:
 * swap the "Untitled" fill (and any collision counter) for the sanitized H1.
 * `第1章-Untitled.md` + `开篇` → `第1章-开篇.md`.
 */
export function renameFromTemplateTitleSlot(
  currentName: string,
  h1: string,
  templateRaw: string,
  siblings: string[],
): string | null {
  const parts = splitMarkdownFilename(currentName);
  if (!parts) return null;
  const m = templateTitleSlotMatcher(templateRaw)?.exec(`${parts.stem}.md`);
  if (!m) return null;
  const sanitized = sanitizeFilenameStem(h1);
  if (sanitized.length === 0) return null;
  const newName = `${m[1]}${sanitized}${m[3]}${parts.extension}`;
  if (newName === currentName) return null;
  return bumpStemUntilFree(newName, siblings, currentName);
}
