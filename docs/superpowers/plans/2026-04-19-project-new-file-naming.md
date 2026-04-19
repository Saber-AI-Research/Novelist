# Project-mode New File Naming, H1 Auto-rename, and File-tree Sort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `novelist_scratch_<ts>.md` placeholder names with smart, folder-aware, H1-renaming filenames; add per-project file-tree sort modes including numeric-aware ordering.

**Architecture:** Pure-function utility libraries (numbering, h1, placeholder, sort) shared between new-file generation, save-time rename, and tree sort. Backend gains collision-aware `rename_item`, file-watcher rename suppression, and encoding-state migration. Frontend wires placeholder lib into save flow, adds Settings UI for the default template, adds sort dropdown to Sidebar, and broadcasts `file-renamed` events for multi-window/split-pane consistency.

**Tech Stack:** Svelte 5 + TypeScript (frontend), Rust + Tauri v2 (backend), Vitest (unit), Playwright (E2E), cargo test (Rust).

**Spec:** `docs/superpowers/specs/2026-04-19-project-new-file-naming-design.md` — read it before starting Phase 1.

---

## Phase 1 — Pure Utility Libraries

These are TS modules with zero dependencies on Svelte stores, IPC, or DOM. Each pairs with a Vitest unit-test file. Phase 1 ships nothing user-visible but establishes the deterministic core that Phases 2–4 wire up.

### Task 1.1: Number parser/formatter — Arabic

**Files:**
- Create: `app/lib/utils/numbering.ts`
- Create: `tests/unit/utils/numbering.test.ts`

- [ ] **Step 1: Write failing test for Arabic parse**

```typescript
// tests/unit/utils/numbering.test.ts
import { describe, it, expect } from 'vitest';
import { parseNumber, formatNumber, type NumberStyle } from '$lib/utils/numbering';

describe('parseNumber — Arabic', () => {
  it('parses bare digits', () => {
    expect(parseNumber('1')).toEqual({ value: 1, style: { kind: 'arabic', width: 1 } });
    expect(parseNumber('42')).toEqual({ value: 42, style: { kind: 'arabic', width: 2 } });
  });
  it('preserves zero-padding width', () => {
    expect(parseNumber('01')).toEqual({ value: 1, style: { kind: 'arabic', width: 2 } });
    expect(parseNumber('001')).toEqual({ value: 1, style: { kind: 'arabic', width: 3 } });
  });
  it('returns null for non-numbers', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal Arabic parse**

```typescript
// app/lib/utils/numbering.ts
export type NumberStyle =
  | { kind: 'arabic'; width: number }
  | { kind: 'chinese-lower' }
  | { kind: 'chinese-upper' }
  | { kind: 'roman-upper' };

export interface ParsedNumber {
  value: number;
  style: NumberStyle;
}

export function parseNumber(s: string): ParsedNumber | null {
  if (/^\d+$/.test(s)) {
    return { value: parseInt(s, 10), style: { kind: 'arabic', width: s.length } };
  }
  return null;
}

export function formatNumber(value: number, style: NumberStyle): string {
  if (style.kind === 'arabic') return String(value).padStart(style.width, '0');
  throw new Error(`formatNumber: unsupported style ${style.kind}`);
}
```

- [ ] **Step 4: Verify Arabic tests pass**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add Arabic format tests**

```typescript
describe('formatNumber — Arabic', () => {
  it('renders bare', () => {
    expect(formatNumber(7, { kind: 'arabic', width: 1 })).toBe('7');
  });
  it('zero-pads to width', () => {
    expect(formatNumber(7, { kind: 'arabic', width: 2 })).toBe('07');
    expect(formatNumber(7, { kind: 'arabic', width: 3 })).toBe('007');
    expect(formatNumber(42, { kind: 'arabic', width: 2 })).toBe('42');
  });
  it('exceeds width without truncating', () => {
    expect(formatNumber(123, { kind: 'arabic', width: 2 })).toBe('123');
  });
});
```

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add app/lib/utils/numbering.ts tests/unit/utils/numbering.test.ts
git commit -m "feat(numbering): Arabic number parser and formatter"
```

---

### Task 1.2: Number parser/formatter — Chinese (lower + upper)

**Files:**
- Modify: `app/lib/utils/numbering.ts`
- Modify: `tests/unit/utils/numbering.test.ts`

- [ ] **Step 1: Write failing tests for Chinese-lower**

Append to `tests/unit/utils/numbering.test.ts`:

```typescript
describe('parseNumber — Chinese lower', () => {
  it('parses 一 to 十', () => {
    expect(parseNumber('一')?.value).toBe(1);
    expect(parseNumber('五')?.value).toBe(5);
    expect(parseNumber('十')?.value).toBe(10);
  });
  it('parses 11–19 as 十N', () => {
    expect(parseNumber('十一')?.value).toBe(11);
    expect(parseNumber('十九')?.value).toBe(19);
  });
  it('parses N十 (20, 30, 90)', () => {
    expect(parseNumber('二十')?.value).toBe(20);
    expect(parseNumber('九十')?.value).toBe(90);
  });
  it('parses N十M (21–99)', () => {
    expect(parseNumber('二十一')?.value).toBe(21);
    expect(parseNumber('九十九')?.value).toBe(99);
  });
  it('parses 一百 to 九百九十九', () => {
    expect(parseNumber('一百')?.value).toBe(100);
    expect(parseNumber('一百零一')?.value).toBe(101);
    expect(parseNumber('一百二十三')?.value).toBe(123);
    expect(parseNumber('九百九十九')?.value).toBe(999);
  });
  it('returns chinese-lower style', () => {
    expect(parseNumber('五')?.style).toEqual({ kind: 'chinese-lower' });
  });
});

describe('formatNumber — Chinese lower', () => {
  it('formats 1–10', () => {
    expect(formatNumber(1, { kind: 'chinese-lower' })).toBe('一');
    expect(formatNumber(10, { kind: 'chinese-lower' })).toBe('十');
  });
  it('formats 11–19', () => {
    expect(formatNumber(11, { kind: 'chinese-lower' })).toBe('十一');
    expect(formatNumber(19, { kind: 'chinese-lower' })).toBe('十九');
  });
  it('formats N0 (20, 90)', () => {
    expect(formatNumber(20, { kind: 'chinese-lower' })).toBe('二十');
    expect(formatNumber(90, { kind: 'chinese-lower' })).toBe('九十');
  });
  it('formats N1–N9 (21–99)', () => {
    expect(formatNumber(21, { kind: 'chinese-lower' })).toBe('二十一');
    expect(formatNumber(99, { kind: 'chinese-lower' })).toBe('九十九');
  });
  it('formats 100–999', () => {
    expect(formatNumber(100, { kind: 'chinese-lower' })).toBe('一百');
    expect(formatNumber(101, { kind: 'chinese-lower' })).toBe('一百零一');
    expect(formatNumber(110, { kind: 'chinese-lower' })).toBe('一百一十');
    expect(formatNumber(123, { kind: 'chinese-lower' })).toBe('一百二十三');
    expect(formatNumber(999, { kind: 'chinese-lower' })).toBe('九百九十九');
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: FAIL — Chinese parsing/formatting not implemented.

- [ ] **Step 3: Implement Chinese-lower**

Append to `app/lib/utils/numbering.ts`:

```typescript
const CN_LOWER_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const CN_LOWER_DIGIT_MAP = new Map<string, number>(
  CN_LOWER_DIGITS.map((c, i) => [c, i])
);

function parseChineseLower(s: string): number | null {
  if (s.length === 0) return null;
  // Single digit
  if (s.length === 1) {
    if (s === '十') return 10;
    const d = CN_LOWER_DIGIT_MAP.get(s);
    return d === undefined || d === 0 ? null : d;
  }
  // 十X (11–19)
  if (s.startsWith('十') && s.length === 2) {
    const d = CN_LOWER_DIGIT_MAP.get(s[1]);
    return d === undefined ? null : 10 + d;
  }
  // X十 or X十Y (20–99)
  const shiIdx = s.indexOf('十');
  if (shiIdx > 0 && !s.includes('百')) {
    const tens = CN_LOWER_DIGIT_MAP.get(s[shiIdx - 1]);
    if (tens === undefined) return null;
    if (s.length === shiIdx + 1) return tens * 10;
    if (s.length === shiIdx + 2) {
      const ones = CN_LOWER_DIGIT_MAP.get(s[shiIdx + 1]);
      if (ones === undefined) return null;
      return tens * 10 + ones;
    }
    return null;
  }
  // X百 [零Y | Y十 | Y十Z]
  const baiIdx = s.indexOf('百');
  if (baiIdx > 0) {
    const hundreds = CN_LOWER_DIGIT_MAP.get(s[baiIdx - 1]);
    if (hundreds === undefined) return null;
    const rest = s.slice(baiIdx + 1);
    if (rest.length === 0) return hundreds * 100;
    // 零Y: 一百零三
    if (rest.startsWith('零') && rest.length === 2) {
      const ones = CN_LOWER_DIGIT_MAP.get(rest[1]);
      if (ones === undefined) return null;
      return hundreds * 100 + ones;
    }
    // Y or Y十 or Y十Z
    const sub = parseChineseLower(rest);
    if (sub === null) return null;
    return hundreds * 100 + sub;
  }
  return null;
}

function formatChineseLower(n: number): string {
  if (n < 1 || n > 999) throw new Error(`formatChineseLower: out of range ${n}`);
  if (n < 10) return CN_LOWER_DIGITS[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + CN_LOWER_DIGITS[n - 10];
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return CN_LOWER_DIGITS[tens] + '十' + (ones === 0 ? '' : CN_LOWER_DIGITS[ones]);
  }
  // 100–999
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (rest === 0) return CN_LOWER_DIGITS[hundreds] + '百';
  if (rest < 10) return CN_LOWER_DIGITS[hundreds] + '百零' + CN_LOWER_DIGITS[rest];
  return CN_LOWER_DIGITS[hundreds] + '百' + formatChineseLower(rest);
}
```

Update `parseNumber` and `formatNumber`:

```typescript
export function parseNumber(s: string): ParsedNumber | null {
  if (/^\d+$/.test(s)) {
    return { value: parseInt(s, 10), style: { kind: 'arabic', width: s.length } };
  }
  const cnLower = parseChineseLower(s);
  if (cnLower !== null) return { value: cnLower, style: { kind: 'chinese-lower' } };
  return null;
}

export function formatNumber(value: number, style: NumberStyle): string {
  if (style.kind === 'arabic') return String(value).padStart(style.width, '0');
  if (style.kind === 'chinese-lower') return formatChineseLower(value);
  throw new Error(`formatNumber: unsupported style ${style.kind}`);
}
```

- [ ] **Step 4: Verify Chinese-lower tests pass**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Add Chinese-upper tests**

```typescript
describe('parseNumber — Chinese upper', () => {
  it('parses 壹 to 拾', () => {
    expect(parseNumber('壹')?.value).toBe(1);
    expect(parseNumber('玖')?.value).toBe(9);
    expect(parseNumber('拾')?.value).toBe(10);
  });
  it('returns chinese-upper style', () => {
    expect(parseNumber('壹')?.style).toEqual({ kind: 'chinese-upper' });
  });
});

describe('formatNumber — Chinese upper', () => {
  it('formats 1–10', () => {
    expect(formatNumber(1, { kind: 'chinese-upper' })).toBe('壹');
    expect(formatNumber(10, { kind: 'chinese-upper' })).toBe('拾');
  });
});
```

- [ ] **Step 6: Implement Chinese-upper (digits 1–9 + 拾)**

Add to `app/lib/utils/numbering.ts`:

```typescript
const CN_UPPER_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'] as const;
const CN_UPPER_DIGIT_MAP = new Map<string, number>(
  CN_UPPER_DIGITS.map((c, i) => [c, i])
);

function parseChineseUpper(s: string): number | null {
  if (s === '拾') return 10;
  if (s.length === 1) {
    const d = CN_UPPER_DIGIT_MAP.get(s);
    return d === undefined || d === 0 ? null : d;
  }
  return null;
}

function formatChineseUpper(n: number): string {
  if (n === 10) return '拾';
  if (n >= 1 && n <= 9) return CN_UPPER_DIGITS[n];
  throw new Error(`formatChineseUpper: out of range ${n} (only 1-10 supported)`);
}
```

Extend `parseNumber` and `formatNumber`:

```typescript
// In parseNumber, after Chinese-lower attempt:
  const cnUpper = parseChineseUpper(s);
  if (cnUpper !== null) return { value: cnUpper, style: { kind: 'chinese-upper' } };

// In formatNumber, add case:
  if (style.kind === 'chinese-upper') return formatChineseUpper(value);
```

- [ ] **Step 7: Verify Chinese-upper tests pass**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/lib/utils/numbering.ts tests/unit/utils/numbering.test.ts
git commit -m "feat(numbering): Chinese lower + upper number parser/formatter"
```

---

### Task 1.3: Number parser/formatter — Roman numerals

**Files:**
- Modify: `app/lib/utils/numbering.ts`
- Modify: `tests/unit/utils/numbering.test.ts`

- [ ] **Step 1: Write failing Roman tests**

```typescript
describe('parseNumber — Roman', () => {
  it('parses I, V, X, L, C, D, M', () => {
    expect(parseNumber('I')?.value).toBe(1);
    expect(parseNumber('V')?.value).toBe(5);
    expect(parseNumber('X')?.value).toBe(10);
  });
  it('parses additive (II, III, VIII)', () => {
    expect(parseNumber('II')?.value).toBe(2);
    expect(parseNumber('VIII')?.value).toBe(8);
  });
  it('parses subtractive (IV, IX, XL, XC, CD, CM)', () => {
    expect(parseNumber('IV')?.value).toBe(4);
    expect(parseNumber('IX')?.value).toBe(9);
    expect(parseNumber('XL')?.value).toBe(40);
    expect(parseNumber('XC')?.value).toBe(90);
    expect(parseNumber('CD')?.value).toBe(400);
    expect(parseNumber('CM')?.value).toBe(900);
  });
  it('parses compound (XLII = 42, MCMXCIV = 1994)', () => {
    expect(parseNumber('XLII')?.value).toBe(42);
    expect(parseNumber('MCMXCIV')?.value).toBe(1994);
  });
  it('returns roman-upper style', () => {
    expect(parseNumber('IV')?.style).toEqual({ kind: 'roman-upper' });
  });
  it('rejects mixed case or invalid', () => {
    expect(parseNumber('iv')).toBeNull();
    expect(parseNumber('IIII')).toBeNull();  // strict: no IIII
  });
});

describe('formatNumber — Roman', () => {
  it('formats 1, 4, 9, 40, 90, 400, 900', () => {
    expect(formatNumber(1, { kind: 'roman-upper' })).toBe('I');
    expect(formatNumber(4, { kind: 'roman-upper' })).toBe('IV');
    expect(formatNumber(9, { kind: 'roman-upper' })).toBe('IX');
    expect(formatNumber(40, { kind: 'roman-upper' })).toBe('XL');
    expect(formatNumber(90, { kind: 'roman-upper' })).toBe('XC');
    expect(formatNumber(400, { kind: 'roman-upper' })).toBe('CD');
    expect(formatNumber(900, { kind: 'roman-upper' })).toBe('CM');
  });
  it('formats compound (1994 = MCMXCIV)', () => {
    expect(formatNumber(1994, { kind: 'roman-upper' })).toBe('MCMXCIV');
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Roman**

Add to `app/lib/utils/numbering.ts`:

```typescript
const ROMAN_PAIRS: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function parseRoman(s: string): number | null {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  let i = 0;
  let total = 0;
  for (const [v, sym] of ROMAN_PAIRS) {
    while (s.startsWith(sym, i)) {
      total += v;
      i += sym.length;
    }
  }
  if (i !== s.length) return null;
  // Round-trip check rejects non-canonical forms like "IIII"
  if (formatRoman(total) !== s) return null;
  return total;
}

function formatRoman(n: number): string {
  if (n < 1 || n > 3999) throw new Error(`formatRoman: out of range ${n}`);
  let out = '';
  let rem = n;
  for (const [v, sym] of ROMAN_PAIRS) {
    while (rem >= v) {
      out += sym;
      rem -= v;
    }
  }
  return out;
}
```

Extend `parseNumber` and `formatNumber`:

```typescript
// In parseNumber, after Chinese-upper attempt:
  const roman = parseRoman(s);
  if (roman !== null) return { value: roman, style: { kind: 'roman-upper' } };

// In formatNumber, add case:
  if (style.kind === 'roman-upper') return formatRoman(value);
```

- [ ] **Step 4: Verify Roman tests pass**

Run: `pnpm test --run tests/unit/utils/numbering.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/numbering.ts tests/unit/utils/numbering.test.ts
git commit -m "feat(numbering): Roman numeral parser and formatter"
```

---

### Task 1.4: H1 extractor

**Files:**
- Create: `app/lib/utils/h1.ts`
- Create: `tests/unit/utils/h1.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/utils/h1.test.ts
import { describe, it, expect } from 'vitest';
import { extractFirstH1 } from '$lib/utils/h1';

describe('extractFirstH1', () => {
  it('extracts ATX H1', () => {
    expect(extractFirstH1('# Hello\n\nbody')).toBe('Hello');
  });
  it('strips trailing #', () => {
    expect(extractFirstH1('# Title #')).toBe('Title');
    expect(extractFirstH1('# Title ###')).toBe('Title');
  });
  it('trims whitespace', () => {
    expect(extractFirstH1('#   Spaced   ')).toBe('Spaced');
  });
  it('returns null when no H1', () => {
    expect(extractFirstH1('## Only H2')).toBeNull();
    expect(extractFirstH1('plain body')).toBeNull();
    expect(extractFirstH1('')).toBeNull();
  });
  it('returns first when multiple H1s', () => {
    expect(extractFirstH1('# First\n\n# Second')).toBe('First');
  });
  it('skips frontmatter', () => {
    const md = '---\ntitle: meta\n---\n\n# Real Title\n';
    expect(extractFirstH1(md)).toBe('Real Title');
  });
  it('skips fenced code blocks', () => {
    const md = '```\n# fake\n```\n\n# real\n';
    expect(extractFirstH1(md)).toBe('real');
  });
  it('skips tilde-fenced code blocks', () => {
    const md = '~~~\n# fake\n~~~\n\n# real\n';
    expect(extractFirstH1(md)).toBe('real');
  });
  it('skips indented (4-space) code blocks', () => {
    const md = '    # fake\n\n# real\n';
    expect(extractFirstH1(md)).toBe('real');
  });
  it('recognizes Setext H1', () => {
    expect(extractFirstH1('Title\n=====\n')).toBe('Title');
    expect(extractFirstH1('Multi line\n===\n')).toBe('Multi line');
  });
  it('does not treat # without space as H1', () => {
    // ATX requires space or end-of-line after #
    expect(extractFirstH1('#NoSpace\n')).toBeNull();
    expect(extractFirstH1('#\n')).toBe('');
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `pnpm test --run tests/unit/utils/h1.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement H1 extractor**

```typescript
// app/lib/utils/h1.ts

/**
 * Extract the first H1 heading text from a markdown document.
 * Returns null if no H1 found.
 *
 * Recognizes:
 * - ATX: `# Title` (with required space or end-of-line after #)
 * - Setext: `Title\n====`
 *
 * Skips:
 * - YAML frontmatter (--- block at top)
 * - Fenced code blocks (``` and ~~~)
 * - Indented code blocks (4 spaces)
 *
 * Returns the inner text trimmed of leading/trailing whitespace and
 * any trailing # characters (per CommonMark closing sequence).
 */
export function extractFirstH1(markdown: string): string | null {
  const lines = markdown.split('\n');
  let i = 0;

  // Skip frontmatter
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++; // skip closing ---
  }

  let inFence: string | null = null; // '```' or '~~~' or null

  for (; i < lines.length; i++) {
    const line = lines[i];

    // Toggle fence
    if (inFence) {
      if (line.trimStart().startsWith(inFence)) inFence = null;
      continue;
    }
    const trimStart = line.trimStart();
    if (trimStart.startsWith('```')) { inFence = '```'; continue; }
    if (trimStart.startsWith('~~~')) { inFence = '~~~'; continue; }

    // Indented code block (4+ spaces, not in a list — simplified)
    if (line.startsWith('    ')) continue;

    // ATX H1: starts with single # followed by space, end-of-line, or nothing
    const atx = /^# ?(.*)$/.exec(line);
    if (atx && !line.startsWith('##')) {
      let text = atx[1] ?? '';
      // Strip closing # sequence (per CommonMark)
      text = text.replace(/\s+#+\s*$/, '');
      return text.trim();
    }

    // Setext H1: next line is === run
    if (i + 1 < lines.length && /^=+\s*$/.test(lines[i + 1]) && line.trim().length > 0) {
      return line.trim();
    }
  }

  return null;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/h1.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/h1.ts tests/unit/utils/h1.test.ts
git commit -m "feat(utils): markdown first-H1 extractor"
```

---

### Task 1.5: Filename sanitizer

**Files:**
- Create: `app/lib/utils/filename.ts`
- Create: `tests/unit/utils/filename.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/utils/filename.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeFilenameStem } from '$lib/utils/filename';

describe('sanitizeFilenameStem', () => {
  it('passes ordinary text through', () => {
    expect(sanitizeFilenameStem('开篇')).toBe('开篇');
    expect(sanitizeFilenameStem('Hello World')).toBe('Hello World');
  });
  it('strips leading hash and whitespace from H1 carry-over', () => {
    expect(sanitizeFilenameStem('#  开篇')).toBe('开篇');
    expect(sanitizeFilenameStem('# 开篇 #')).toBe('开篇');
  });
  it('strips .md extension if user typed it', () => {
    expect(sanitizeFilenameStem('foo.md')).toBe('foo');
    expect(sanitizeFilenameStem('foo.markdown')).toBe('foo');
  });
  it('replaces forbidden filesystem chars with -', () => {
    expect(sanitizeFilenameStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
  });
  it('collapses repeated dashes', () => {
    expect(sanitizeFilenameStem('a///b')).toBe('a-b');
  });
  it('trims length to 80 chars (UTF-8 aware)', () => {
    const long = '字'.repeat(100);
    expect(sanitizeFilenameStem(long).length).toBe(80);
  });
  it('returns empty for whitespace-only', () => {
    expect(sanitizeFilenameStem('   ')).toBe('');
    expect(sanitizeFilenameStem('')).toBe('');
  });
  it('prefixes underscore to leading dot', () => {
    expect(sanitizeFilenameStem('.hidden')).toBe('_.hidden');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/filename.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// app/lib/utils/filename.ts

/**
 * Convert arbitrary text (e.g., an H1 heading) into a safe filename stem.
 * - Strips leading `#` markers, surrounding whitespace, and trailing `.md`/`.markdown`
 * - Replaces forbidden filesystem chars with `-`
 * - Collapses repeated dashes
 * - Truncates to 80 chars (counted by code points, not bytes)
 * - Returns empty string when nothing usable remains
 */
export function sanitizeFilenameStem(input: string): string {
  let s = input.trim();
  // Strip leading ATX hashes ("# Title", "## also", "#" alone)
  s = s.replace(/^#+\s*/, '');
  // Strip trailing closing-hash sequence ("Title #" / "Title ###")
  s = s.replace(/\s+#+\s*$/, '').trim();
  // Strip trailing .md / .markdown
  s = s.replace(/\.(md|markdown)$/i, '').trim();
  // Replace forbidden chars
  s = s.replace(/[\/\\:*?"<>|]/g, '-');
  // Collapse repeated dashes
  s = s.replace(/-{2,}/g, '-');
  // Hidden-file guard
  if (s.startsWith('.')) s = '_' + s;
  // Length cap (code points)
  const codepoints = Array.from(s);
  if (codepoints.length > 80) s = codepoints.slice(0, 80).join('');
  return s;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/filename.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/filename.ts tests/unit/utils/filename.test.ts
git commit -m "feat(utils): filename stem sanitizer"
```

---

### Task 1.6: Placeholder template parser

**Files:**
- Create: `app/lib/utils/placeholder.ts`
- Create: `tests/unit/utils/placeholder.test.ts`

This task introduces the template descriptor used by the rest of the system. Subsequent tasks (1.7, 1.8, 1.9) layer on inference, rename, and detection.

- [ ] **Step 1: Write failing tests for template parsing**

```typescript
// tests/unit/utils/placeholder.test.ts
import { describe, it, expect } from 'vitest';
import { parseTemplate, type Template } from '$lib/utils/placeholder';

describe('parseTemplate', () => {
  it('parses Untitled {N}', () => {
    const t = parseTemplate('Untitled {N}');
    expect(t).toEqual({
      raw: 'Untitled {N}',
      prefix: 'Untitled ',
      suffix: '',
      hasTitleSlot: false,
      titleSlotPosition: null,
    });
  });
  it('parses 第{N}章', () => {
    const t = parseTemplate('第{N}章');
    expect(t?.prefix).toBe('第');
    expect(t?.suffix).toBe('章');
    expect(t?.hasTitleSlot).toBe(false);
  });
  it('parses Chapter {N}', () => {
    const t = parseTemplate('Chapter {N}');
    expect(t?.prefix).toBe('Chapter ');
    expect(t?.suffix).toBe('');
  });
  it('parses {N}-{title}', () => {
    const t = parseTemplate('{N}-{title}');
    expect(t?.prefix).toBe('');
    expect(t?.suffix).toBe('-{title}');
    expect(t?.hasTitleSlot).toBe(true);
    expect(t?.titleSlotPosition).toBe('after');
  });
  it('rejects template missing {N}', () => {
    expect(parseTemplate('no number')).toBeNull();
  });
  it('rejects template with multiple {N}', () => {
    expect(parseTemplate('{N}-{N}')).toBeNull();
  });
  it('rejects empty', () => {
    expect(parseTemplate('')).toBeNull();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement template parser**

```typescript
// app/lib/utils/placeholder.ts

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
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/placeholder.ts tests/unit/utils/placeholder.test.ts
git commit -m "feat(placeholder): template descriptor parser"
```

---

### Task 1.7: Placeholder filename render + detection

**Files:**
- Modify: `app/lib/utils/placeholder.ts`
- Modify: `tests/unit/utils/placeholder.test.ts`

- [ ] **Step 1: Write failing tests for renderTemplate**

```typescript
import { renderTemplate } from '$lib/utils/placeholder';
import type { NumberStyle } from '$lib/utils/numbering';

describe('renderTemplate', () => {
  it('renders Untitled 1.md', () => {
    const t = parseTemplate('Untitled {N}')!;
    expect(renderTemplate(t, 1, { kind: 'arabic', width: 1 }, null)).toBe('Untitled 1.md');
  });
  it('renders 第一章.md (chinese-lower)', () => {
    const t = parseTemplate('第{N}章')!;
    expect(renderTemplate(t, 1, { kind: 'chinese-lower' }, null)).toBe('第一章.md');
  });
  it('renders 03-Untitled.md when title slot present', () => {
    const t = parseTemplate('{N}-{title}')!;
    expect(renderTemplate(t, 3, { kind: 'arabic', width: 2 }, null)).toBe('03-Untitled.md');
  });
  it('substitutes title slot when title given', () => {
    const t = parseTemplate('{N}-{title}')!;
    expect(renderTemplate(t, 3, { kind: 'arabic', width: 2 }, '开篇')).toBe('03-开篇.md');
  });
  it('appends title with space when no slot (chapter prefix)', () => {
    const t = parseTemplate('第{N}章')!;
    expect(renderTemplate(t, 3, { kind: 'chinese-lower' }, '开篇')).toBe('第三章 开篇.md');
  });
  it('appends title without space when stem ends in closing bracket', () => {
    const t = parseTemplate('【第{N}章】')!;
    expect(renderTemplate(t, 3, { kind: 'chinese-lower' }, '开篇')).toBe('【第三章】开篇.md');
  });
  it('Untitled {N} replaces full name when title given', () => {
    const t = parseTemplate('Untitled {N}')!;
    expect(renderTemplate(t, 1, { kind: 'arabic', width: 1 }, '开篇')).toBe('开篇.md');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement renderTemplate**

Add to `app/lib/utils/placeholder.ts`:

```typescript
import { formatNumber, type NumberStyle } from './numbering';
import { sanitizeFilenameStem } from './filename';

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
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS.

- [ ] **Step 5: Add tests for isPlaceholder**

```typescript
import { isPlaceholder } from '$lib/utils/placeholder';

describe('isPlaceholder', () => {
  it('detects Untitled N', () => {
    expect(isPlaceholder('Untitled 1.md')).toBe(true);
    expect(isPlaceholder('Untitled 42.md')).toBe(true);
  });
  it('detects 第N章 (chinese-lower or arabic)', () => {
    expect(isPlaceholder('第三章.md')).toBe(true);
    expect(isPlaceholder('第3章.md')).toBe(true);
  });
  it('detects Chapter N', () => {
    expect(isPlaceholder('Chapter 3.md')).toBe(true);
  });
  it('detects {N}-Untitled', () => {
    expect(isPlaceholder('03-Untitled.md')).toBe(true);
    expect(isPlaceholder('03_Untitled.md')).toBe(true);
    expect(isPlaceholder('3.Untitled.md')).toBe(true);
  });
  it('detects legacy novelist_scratch_<ts>', () => {
    expect(isPlaceholder('novelist_scratch_1234567890.md')).toBe(true);
  });
  it('rejects user-named files', () => {
    expect(isPlaceholder('开篇.md')).toBe(false);
    expect(isPlaceholder('Hello World.md')).toBe(false);
    expect(isPlaceholder('第三章 开篇.md')).toBe(false);
    expect(isPlaceholder('03-开篇.md')).toBe(false);
  });
});
```

- [ ] **Step 6: Implement isPlaceholder**

Add to `app/lib/utils/placeholder.ts`:

```typescript
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
```

- [ ] **Step 7: Verify isPlaceholder tests pass**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app/lib/utils/placeholder.ts tests/unit/utils/placeholder.test.ts
git commit -m "feat(placeholder): renderTemplate + isPlaceholder detection"
```

---

### Task 1.8: Folder pattern inference

**Files:**
- Modify: `app/lib/utils/placeholder.ts`
- Modify: `tests/unit/utils/placeholder.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { inferNextName } from '$lib/utils/placeholder';

describe('inferNextName', () => {
  const defaultTemplate = parseTemplate('Untitled {N}')!;

  it('empty folder uses default template', () => {
    expect(inferNextName([], defaultTemplate)).toBe('Untitled 1.md');
  });

  it('user template applied to empty folder', () => {
    const t = parseTemplate('第{N}章')!;
    expect(inferNextName([], t)).toBe('第一章.md');
  });

  it('infers next chapter from chinese-lower series (≥2 matches)', () => {
    expect(inferNextName(['第一章.md', '第二章.md'], defaultTemplate)).toBe('第三章.md');
  });

  it('infers next chapter from arabic series', () => {
    expect(inferNextName(['Chapter 1.md', 'Chapter 2.md', 'Chapter 5.md'], defaultTemplate))
      .toBe('Chapter 6.md');
  });

  it('preserves zero-padding width', () => {
    expect(inferNextName(['01-intro.md', '02-rising.md'], defaultTemplate))
      .toBe('03-Untitled.md');
  });

  it('skips serial members (序章, 楔子)', () => {
    expect(inferNextName(['序章.md', '第一章.md', '第二章.md'], defaultTemplate))
      .toBe('第三章.md');
  });

  it('falls back to default template when only 1 match (auto threshold = 2)', () => {
    expect(inferNextName(['第一章.md', 'notes.md'], defaultTemplate)).toBe('Untitled 1.md');
  });

  it('user template lowers threshold to 1', () => {
    const t = parseTemplate('第{N}章')!;
    expect(inferNextName(['第一章.md', 'notes.md'], t)).toBe('第二章.md');
  });

  it('avoids collision by bumping number', () => {
    expect(inferNextName(['第一章.md', '第二章.md', '第三章.md'], defaultTemplate))
      .toBe('第四章.md');
  });

  it('Untitled fallback bumps number on collision', () => {
    expect(inferNextName(['Untitled 1.md', 'Untitled 2.md'], defaultTemplate))
      .toBe('Untitled 3.md');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement family detection + inference**

Add to `app/lib/utils/placeholder.ts`:

```typescript
import { parseNumber } from './numbering';

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
  const escapePrefix = template.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapeSuffix = template.suffix
    .replace(/\{title\}/g, '(?:[^/]*?)')   // accept any title content
    .replace(/[.*+?^${}()|[\]\\]/g, m => m === '(' || m === ')' ? m : '\\' + m);
  // Number portion: digits OR Chinese numerals
  return new RegExp(`^${escapePrefix}([\\d\\u4e00-\\u9fff]+)${escapeSuffix}\\.md$`);
}

function detectFamily(filenames: string[], template: Template): FamilyMatch | null {
  const re = familyMatcher(template);
  const matches: ParsedNumber[] = [];
  for (const f of filenames) {
    const m = re.exec(f);
    if (!m) continue;
    const stem = f.replace(/\.md$/, '');
    if (SKIP_TITLES.has(stem)) continue;
    const parsed = parseNumber(m[1]);
    if (parsed) matches.push(parsed);
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
 * - `folderFiles` is the list of basenames in the target folder (just .md files matter).
 * - `userDefaultTemplate` is the template configured in Settings (parsed).
 *
 * Rules: prefer a built-in family that has ≥2 matches in the folder; otherwise use
 * the user default template (which gets threshold 1 — so even a single matching
 * file in the folder kicks it in). For a fully empty folder, render the default
 * template at N=1 with its natural style (chinese-lower for 第{N}章, arabic for the rest).
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
    // Empty / no recognizable pattern → render user default at N=1
    const style = naturalStyleFor(userDefaultTemplate);
    return bumpUntilFree(userDefaultTemplate, 1, style, folderFiles);
  }

  // Highest match count wins; on tie, earliest in BUILTIN_TEMPLATES order
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
  // Cap to prevent runaway loop on pathological folders
  for (let i = 0; i < 10000; i++) {
    const candidate = renderTemplate(template, n, style, null);
    if (!taken.has(candidate)) return candidate;
    n++;
  }
  // Should not happen; fall back to timestamp suffix
  return `Untitled ${Date.now()}.md`;
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/placeholder.ts tests/unit/utils/placeholder.test.ts
git commit -m "feat(placeholder): folder-aware next-name inference"
```

---

### Task 1.9: H1 → new filename rename helper

**Files:**
- Modify: `app/lib/utils/placeholder.ts`
- Modify: `tests/unit/utils/placeholder.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { renameFromH1 } from '$lib/utils/placeholder';

describe('renameFromH1', () => {
  it('Untitled 1.md → 开篇.md', () => {
    expect(renameFromH1('Untitled 1.md', '开篇', [])).toBe('开篇.md');
  });
  it('returns null when filename is not a placeholder', () => {
    expect(renameFromH1('开篇.md', 'NewTitle', [])).toBeNull();
  });
  it('returns null when H1 is empty after sanitization', () => {
    expect(renameFromH1('Untitled 1.md', '   ', [])).toBeNull();
    expect(renameFromH1('Untitled 1.md', '', [])).toBeNull();
  });
  it('第三章.md + 开篇 → 第三章 开篇.md', () => {
    expect(renameFromH1('第三章.md', '开篇', [])).toBe('第三章 开篇.md');
  });
  it('Chapter 3.md + Opening → Chapter 3 Opening.md', () => {
    expect(renameFromH1('Chapter 3.md', 'Opening', [])).toBe('Chapter 3 Opening.md');
  });
  it('03-Untitled.md + 开篇 → 03-开篇.md', () => {
    expect(renameFromH1('03-Untitled.md', '开篇', [])).toBe('03-开篇.md');
  });
  it('03_Untitled.md + Opening → 03_Opening.md', () => {
    expect(renameFromH1('03_Untitled.md', 'Opening', [])).toBe('03_Opening.md');
  });
  it('legacy novelist_scratch → uses H1 as full name', () => {
    expect(renameFromH1('novelist_scratch_1234.md', '开篇', [])).toBe('开篇.md');
  });
  it('collision bumps with " 2"', () => {
    expect(renameFromH1('Untitled 1.md', '开篇', ['开篇.md'])).toBe('开篇 2.md');
    expect(renameFromH1('Untitled 1.md', '开篇', ['开篇.md', '开篇 2.md'])).toBe('开篇 3.md');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement renameFromH1**

Add to `app/lib/utils/placeholder.ts`:

```typescript
/**
 * Compute the new filename when an H1 has been written into a placeholder file.
 *
 * - If `currentName` is not a placeholder, returns null (caller should not rename).
 * - If `h1` sanitizes to empty, returns null (no rename).
 * - Else: produces a new filename per the rules in §3.5 of the spec.
 *   On collision with `siblings`, appends " 2", " 3", … to the *whole stem*
 *   (matches `create_file` backend collision strategy).
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
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/placeholder.ts tests/unit/utils/placeholder.test.ts
git commit -m "feat(placeholder): H1-driven rename helper"
```

---

### Task 1.10: Numeric-aware file sort comparator

**Files:**
- Create: `app/lib/utils/file-sort.ts`
- Create: `tests/unit/utils/file-sort.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/utils/file-sort.test.ts
import { describe, it, expect } from 'vitest';
import { compareByMode, type SortMode } from '$lib/utils/file-sort';

interface F { name: string; is_dir: boolean; mtime?: number; }

const sortNames = (files: F[], mode: SortMode): string[] =>
  [...files].sort((a, b) => compareByMode(a, b, mode)).map(f => f.name);

describe('compareByMode — name-asc', () => {
  it('case-insensitive lex order', () => {
    expect(sortNames(
      [{ name: 'Banana', is_dir: false }, { name: 'apple', is_dir: false }],
      'name-asc'
    )).toEqual(['apple', 'Banana']);
  });
  it('folders first within same mode', () => {
    expect(sortNames(
      [{ name: 'a.md', is_dir: false }, { name: 'z', is_dir: true }],
      'name-asc'
    )).toEqual(['z', 'a.md']);
  });
});

describe('compareByMode — name-desc', () => {
  it('reverses lex order', () => {
    expect(sortNames(
      [{ name: 'a', is_dir: false }, { name: 'b', is_dir: false }],
      'name-desc'
    )).toEqual(['b', 'a']);
  });
});

describe('compareByMode — numeric-asc', () => {
  it('orders chinese chapters numerically', () => {
    expect(sortNames(
      [
        { name: '第十章.md', is_dir: false },
        { name: '第二章.md', is_dir: false },
        { name: '第一章.md', is_dir: false },
      ],
      'numeric-asc'
    )).toEqual(['第一章.md', '第二章.md', '第十章.md']);
  });
  it('orders arabic prefixes numerically', () => {
    expect(sortNames(
      [
        { name: '10-finale.md', is_dir: false },
        { name: '2-rising.md', is_dir: false },
        { name: '1-intro.md', is_dir: false },
      ],
      'numeric-asc'
    )).toEqual(['1-intro.md', '2-rising.md', '10-finale.md']);
  });
  it('non-numeric files sort after numbered, alphabetically', () => {
    expect(sortNames(
      [
        { name: 'notes.md', is_dir: false },
        { name: '1-intro.md', is_dir: false },
        { name: 'appendix.md', is_dir: false },
      ],
      'numeric-asc'
    )).toEqual(['1-intro.md', 'appendix.md', 'notes.md']);
  });
  it('folders still first', () => {
    expect(sortNames(
      [{ name: '1.md', is_dir: false }, { name: 'aaa', is_dir: true }],
      'numeric-asc'
    )).toEqual(['aaa', '1.md']);
  });
});

describe('compareByMode — numeric-desc', () => {
  it('reverses numeric order', () => {
    expect(sortNames(
      [
        { name: '第一章.md', is_dir: false },
        { name: '第十章.md', is_dir: false },
        { name: '第二章.md', is_dir: false },
      ],
      'numeric-desc'
    )).toEqual(['第十章.md', '第二章.md', '第一章.md']);
  });
});

describe('compareByMode — mtime-desc', () => {
  it('newest first', () => {
    expect(sortNames(
      [
        { name: 'old', is_dir: false, mtime: 100 },
        { name: 'new', is_dir: false, mtime: 200 },
      ],
      'mtime-desc'
    )).toEqual(['new', 'old']);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/utils/file-sort.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement comparator**

```typescript
// app/lib/utils/file-sort.ts
import { parseNumber } from './numbering';

export type SortMode =
  | 'name-asc'
  | 'name-desc'
  | 'numeric-asc'
  | 'numeric-desc'
  | 'mtime-desc'
  | 'mtime-asc';

export interface SortableEntry {
  name: string;
  is_dir: boolean;
  mtime?: number;
}

/**
 * Extract the leftmost run of digits OR Chinese numerals from the name (sans .md).
 * Returns { prefix, value, suffix } or null if no number found.
 */
function extractLeftmostNumber(name: string): { prefix: string; value: number; suffix: string } | null {
  const stem = name.replace(/\.[^.]+$/, '');
  // Find leftmost run of digits OR CJK chars that parse as a number.
  // Try digits first.
  const arabicMatch = /^(.*?)(\d+)(.*)$/.exec(stem);
  // Try CJK numerals
  const cjkMatch = /^(.*?)([\u4e00-\u9fff]+)(.*)$/.exec(stem);
  let candidates: Array<{ prefix: string; numStr: string; suffix: string; pos: number }> = [];
  if (arabicMatch) candidates.push({ prefix: arabicMatch[1], numStr: arabicMatch[2], suffix: arabicMatch[3], pos: arabicMatch[1].length });
  if (cjkMatch) {
    const parsed = parseNumber(cjkMatch[2]);
    if (parsed !== null) candidates.push({ prefix: cjkMatch[1], numStr: cjkMatch[2], suffix: cjkMatch[3], pos: cjkMatch[1].length });
  }
  if (candidates.length === 0) return null;
  // Earliest position wins; on tie, prefer arabic
  candidates.sort((a, b) => a.pos - b.pos);
  const c = candidates[0];
  const parsed = parseNumber(c.numStr);
  if (parsed === null) return null;
  return { prefix: c.prefix, value: parsed.value, suffix: c.suffix };
}

function compareNumeric(a: SortableEntry, b: SortableEntry): number {
  const an = extractLeftmostNumber(a.name);
  const bn = extractLeftmostNumber(b.name);
  // Both have numbers
  if (an && bn) {
    const pfxCmp = an.prefix.toLowerCase().localeCompare(bn.prefix.toLowerCase());
    if (pfxCmp !== 0) return pfxCmp;
    if (an.value !== bn.value) return an.value - bn.value;
    return an.suffix.toLowerCase().localeCompare(bn.suffix.toLowerCase());
  }
  // Only one has a number — numbered files first when prefixes match; else lex
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  // Neither has a number
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

export function compareByMode(a: SortableEntry, b: SortableEntry, mode: SortMode): number {
  // Folders always first
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

  switch (mode) {
    case 'name-asc': return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    case 'name-desc': return b.name.toLowerCase().localeCompare(a.name.toLowerCase());
    case 'numeric-asc': return compareNumeric(a, b);
    case 'numeric-desc': return -compareNumeric(a, b);
    case 'mtime-desc': return (b.mtime ?? 0) - (a.mtime ?? 0);
    case 'mtime-asc': return (a.mtime ?? 0) - (b.mtime ?? 0);
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/utils/file-sort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/utils/file-sort.ts tests/unit/utils/file-sort.test.ts
git commit -m "feat(file-sort): numeric-aware comparator with multiple sort modes"
```

---

## Phase 2 — Backend Changes

Phase 2 enables the rename + sort flow on the Rust side: collision-bumping rename, file-watcher rename suppression, encoding-state migration, and `FileEntry` mtime exposure for the sort.

### Task 2.1: `FileEntry` gains `mtime`

**Files:**
- Modify: `core/src/models/file_state.rs`
- Modify: `core/src/commands/file.rs:288-295` (the `entries.push` site)

- [ ] **Step 1: Locate the model**

Run: `Grep "struct FileEntry" core/src/models/`
Expected: shows the current `FileEntry` definition.

- [ ] **Step 2: Add mtime field**

In `core/src/models/file_state.rs`, find `FileEntry` and add a field:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix epoch milliseconds; None when filesystem doesn't expose mtime.
    pub mtime: Option<i64>,
}
```

- [ ] **Step 3: Populate mtime in `list_directory`**

In `core/src/commands/file.rs`, modify the `entries.push` block in `list_directory` (currently lines 288–295):

```rust
let metadata = entry.metadata().await?;
let mtime = metadata
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as i64);
entries.push(FileEntry {
    name,
    path: entry.path().to_string_lossy().to_string(),
    is_dir: metadata.is_dir(),
    size: metadata.len(),
    mtime,
});
```

- [ ] **Step 4: Update `test_list_directory` to assert mtime present**

In the existing test (around `core/src/commands/file.rs:737`), add an assertion:

```rust
assert!(entries.iter().any(|e| e.mtime.is_some()), "at least one entry should have mtime");
```

- [ ] **Step 5: Run Rust tests**

Run: `pnpm test:rust`
Expected: PASS (171+ tests).

- [ ] **Step 6: Regenerate TS bindings**

The mtime field needs to flow into TypeScript. Bindings regenerate when `pnpm tauri dev` runs once. For a quick path:

Run: `pnpm tauri dev` — let it boot, then quit (Ctrl+C).

Verify `app/lib/ipc/commands.ts` now contains `mtime` on the `FileEntry` type:

Run: `Grep "mtime" app/lib/ipc/commands.ts`
Expected: shows `mtime: number | null` in the FileEntry definition.

- [ ] **Step 7: Run frontend tests to confirm no regressions**

Run: `pnpm test --run`
Expected: PASS (existing tests, including new ones from Phase 1).

- [ ] **Step 8: Commit**

```bash
git add core/src/models/file_state.rs core/src/commands/file.rs app/lib/ipc/commands.ts
git commit -m "feat(core): expose mtime on FileEntry for sort modes"
```

---

### Task 2.2: `list_directory` drops backend sort

**Files:**
- Modify: `core/src/commands/file.rs:297-302`

- [ ] **Step 1: Write the failing test**

In `core/src/commands/file.rs::tests`, add:

```rust
#[tokio::test]
async fn test_list_directory_returns_unsorted() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("z.md"), "").unwrap();
    fs::write(dir.path().join("a.md"), "").unwrap();
    let result = list_directory(dir.path().to_string_lossy().to_string()).await.unwrap();
    let names: Vec<&str> = result.iter().map(|e| e.name.as_str()).collect();
    // Either order is fine — the contract is "no guarantee"
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"a.md"));
    assert!(names.contains(&"z.md"));
}
```

- [ ] **Step 2: Verify the existing `test_list_directory` still passes**

The pre-existing test asserts `entries[0].is_dir == true` for "chapters". After we drop the in-Rust sort, this assertion may fail. Check:

Run: `cargo test --manifest-path core/Cargo.toml test_list_directory`
Expected: existing test may FAIL because folder ordering is no longer guaranteed.

- [ ] **Step 3: Drop the sort and update the existing test**

In `core/src/commands/file.rs`, remove lines 297–302 (the `entries.sort_by` block). The function returns `entries` directly.

Update the pre-existing `test_list_directory` to not depend on order:

```rust
// Replace ordering assertions like:
//   assert_eq!(entries[0].name, "chapters");
// With:
let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
assert!(names.contains(&"chapters"));
assert!(names.contains(&"a.md"));
assert!(names.contains(&"b.md"));
assert!(!names.contains(&".hidden"));
```

- [ ] **Step 4: Run Rust tests**

Run: `pnpm test:rust`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/commands/file.rs
git commit -m "refactor(core): drop list_directory sort — frontend now owns ordering"
```

---

### Task 2.3: `rename_item` gains collision-bump

**Files:**
- Modify: `core/src/commands/file.rs:386-406`

- [ ] **Step 1: Write failing test**

In `core/src/commands/file.rs::tests`:

```rust
#[tokio::test]
async fn test_rename_item_bumps_on_collision() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("orig.md");
    let conflict = dir.path().join("target.md");
    let conflict2 = dir.path().join("target 2.md");
    fs::write(&src, "x").unwrap();
    fs::write(&conflict, "y").unwrap();
    fs::write(&conflict2, "z").unwrap();
    let result = rename_item(
        src.to_string_lossy().to_string(),
        "target.md".to_string(),
        Some(true),
    ).await.unwrap();
    assert!(result.ends_with("target 3.md"));
    assert!(!src.exists());
}

#[tokio::test]
async fn test_rename_item_errors_on_collision_when_disabled() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("orig.md");
    let conflict = dir.path().join("target.md");
    fs::write(&src, "x").unwrap();
    fs::write(&conflict, "y").unwrap();
    let result = rename_item(
        src.to_string_lossy().to_string(),
        "target.md".to_string(),
        Some(false),
    ).await;
    assert!(result.is_err());
    assert!(src.exists());
}
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --manifest-path core/Cargo.toml test_rename_item_bumps`
Expected: FAIL (function signature changed).

- [ ] **Step 3: Modify `rename_item` signature + implementation**

Replace the `rename_item` function in `core/src/commands/file.rs`:

```rust
/// Rename a file or folder in place.
/// When `allow_collision_bump` is Some(true), appends " 2", " 3", … on collision
/// (matches `create_file`'s strategy). Defaults to error-on-collision.
#[tauri::command]
#[specta::specta]
pub async fn rename_item(
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
) -> Result<String, AppError> {
    let old = validate_path(&old_path)?;
    if !old.exists() {
        return Err(AppError::FileNotFound(old_path));
    }
    let safe_name = sanitize_filename(&new_name)?;
    let parent = old
        .parent()
        .ok_or_else(|| AppError::Custom("Cannot determine parent directory".to_string()))?;
    let mut new_path = parent.join(&safe_name);

    if new_path.exists() && new_path != old {
        if allow_collision_bump.unwrap_or(false) {
            let p = std::path::Path::new(&safe_name);
            let stem = p.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let ext = p
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let mut counter = 2u32;
            loop {
                new_path = parent.join(format!("{stem} {counter}{ext}"));
                if !new_path.exists() || new_path == old {
                    break;
                }
                counter += 1;
            }
        } else {
            return Err(AppError::Custom(format!(
                "Already exists: {}",
                new_path.display()
            )));
        }
    }

    tokio::fs::rename(&old, &new_path).await?;
    Ok(new_path.to_string_lossy().to_string())
}
```

- [ ] **Step 4: Update existing call sites**

Run: `Grep "rename_item|renameItem" --type ts --type rs --type svelte`
Expected: shows existing TS callers.

For each TS call site (e.g., in Sidebar.svelte / FileTreeNode.svelte), pass `null` as the third argument:

```typescript
// Before:
await commands.renameItem(oldPath, newName);
// After:
await commands.renameItem(oldPath, newName, null);
```

(Tauri-specta turns `Option<bool>` into `boolean | null`.)

- [ ] **Step 5: Run Rust tests**

Run: `pnpm test:rust`
Expected: PASS.

- [ ] **Step 6: Regenerate bindings + check frontend types**

Run: `pnpm tauri dev` — boot once and quit.
Verify: `app/lib/ipc/commands.ts` shows `renameItem(oldPath, newName, allowCollisionBump)`.

- [ ] **Step 7: Run frontend type-check**

Run: `pnpm check`
Expected: PASS (callers updated).

- [ ] **Step 8: Commit**

```bash
git add core/src/commands/file.rs app/lib/ipc/commands.ts \
  app/lib/components/Sidebar.svelte app/lib/components/FileTreeNode.svelte
git commit -m "feat(core): rename_item collision-bump option"
```

(Adjust the `git add` list to include any additional Svelte files Grep turned up in step 4.)

---

### Task 2.4: File watcher — rename suppression

**Files:**
- Modify: `core/src/services/file_watcher.rs`
- Modify: `core/src/commands/file.rs` (`rename_item` call site)
- Modify: `core/src/lib.rs` (register new command, if needed)

- [ ] **Step 1: Inspect the existing write-ignore mechanism**

Run: `Read core/src/services/file_watcher.rs:280-330` to see `register_write_ignore` and the ignore-set type.

Look for the in-memory state storing ignored paths; you'll extend it with a rename-aware set.

- [ ] **Step 2: Write failing Rust test**

In `core/src/services/file_watcher.rs::tests` (add the tests module if absent):

```rust
#[tokio::test]
async fn test_register_rename_ignore_suppresses_both_paths() {
    use crate::services::file_watcher::{register_rename_ignore, take_rename_ignored};
    let old = "/tmp/foo.md".to_string();
    let new = "/tmp/bar.md".to_string();
    register_rename_ignore(old.clone(), new.clone()).await;
    assert!(take_rename_ignored(&old).await);
    assert!(take_rename_ignored(&new).await);
    // Second take returns false (already consumed)
    assert!(!take_rename_ignored(&old).await);
}
```

- [ ] **Step 3: Verify failure**

Run: `cargo test --manifest-path core/Cargo.toml test_register_rename_ignore`
Expected: FAIL.

- [ ] **Step 4: Add the rename-ignore set**

In `core/src/services/file_watcher.rs`, alongside the existing write-ignore state, add:

```rust
use tokio::sync::Mutex;
use std::collections::HashSet;
use once_cell::sync::Lazy;

static RENAME_IGNORED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Register both old and new paths as expected — the next FS event for either
/// path is consumed without forwarding to listeners.
pub async fn register_rename_ignore(old_path: String, new_path: String) {
    let mut set = RENAME_IGNORED.lock().await;
    set.insert(old_path);
    set.insert(new_path);
}

/// Returns true and removes the entry if `path` was registered as a rename
/// to ignore; otherwise returns false.
pub async fn take_rename_ignored(path: &str) -> bool {
    let mut set = RENAME_IGNORED.lock().await;
    set.remove(path)
}
```

(If `once_cell` is not yet a dep, add it to `core/Cargo.toml` under `[dependencies]`: `once_cell = "1"`. If `tokio::sync::Mutex` is not yet imported elsewhere, ensure the import resolves.)

- [ ] **Step 5: Wire into the watcher event handler**

Find the watcher event-dispatch loop (search for `notify::Event` handling). Where it forwards events for write/create/remove, gate them with the ignore-set:

```rust
// Pseudocode — adapt to actual structure
for path in event.paths {
    let p = path.to_string_lossy().to_string();
    if take_rename_ignored(&p).await {
        // Suppress this event
        continue;
    }
    // ... existing dispatch
}
```

- [ ] **Step 6: Verify Rust test passes**

Run: `cargo test --manifest-path core/Cargo.toml test_register_rename_ignore`
Expected: PASS.

- [ ] **Step 7: Make `rename_item` register the rename**

In `core/src/commands/file.rs`, in `rename_item`, immediately before `tokio::fs::rename(...)`:

```rust
crate::services::file_watcher::register_rename_ignore(
    old.to_string_lossy().to_string(),
    new_path.to_string_lossy().to_string(),
).await;
```

- [ ] **Step 8: Run all Rust tests**

Run: `pnpm test:rust`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add core/src/services/file_watcher.rs core/src/commands/file.rs core/Cargo.toml
git commit -m "feat(core): rename-aware file watcher suppression"
```

---

### Task 2.5: Encoding-state migration on rename

**Files:**
- Modify: `core/src/commands/file.rs` (`EncodingState` impl + `rename_item`)

- [ ] **Step 1: Write failing test**

In `core/src/commands/file.rs::tests`:

```rust
#[tokio::test]
async fn test_rename_migrates_encoding_state() {
    let dir = TempDir::new().unwrap();
    let src = dir.path().join("orig.md");
    fs::write(&src, "x").unwrap();
    let canonical_old = src.canonicalize().unwrap().to_string_lossy().to_string();

    // Pre-seed encoding state for old path
    let state = EncodingState::new();
    state.encodings.lock().unwrap().insert(canonical_old.clone(), "GBK");

    let new_path_str = rename_item(
        src.to_string_lossy().to_string(),
        "renamed.md".to_string(),
        Some(false),
    ).await.unwrap();

    // Manually invoke the migration helper for this test (rename_item itself
    // does not have access to State<EncodingState>; migration is wired in step 3
    // by adding a public migration helper that the new save flow calls).
    let canonical_new = std::fs::canonicalize(&new_path_str).unwrap().to_string_lossy().to_string();
    crate::commands::file::migrate_encoding_state(&state, &canonical_old, &canonical_new);

    let map = state.encodings.lock().unwrap();
    assert!(!map.contains_key(&canonical_old));
    assert_eq!(map.get(&canonical_new), Some(&"GBK"));
}
```

- [ ] **Step 2: Verify failure**

Run: `cargo test --manifest-path core/Cargo.toml test_rename_migrates_encoding`
Expected: FAIL — `migrate_encoding_state` not defined; `encodings` field not pub.

- [ ] **Step 3: Make `encodings` pub(crate) and add migration helper**

In `core/src/commands/file.rs`, change `encodings: Mutex<...>` to `pub(crate) encodings: Mutex<...>` and add:

```rust
/// Move the encoding entry from `old_canonical` to `new_canonical`. No-op when
/// the old key is not present (file was UTF-8).
pub fn migrate_encoding_state(state: &EncodingState, old_canonical: &str, new_canonical: &str) {
    let mut map = state.encodings.lock().expect("encodings lock");
    if let Some(enc) = map.remove(old_canonical) {
        map.insert(new_canonical.to_string(), enc);
    }
}
```

- [ ] **Step 4: Make `rename_item` accept `EncodingState` and call migration**

Update `rename_item`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn rename_item(
    old_path: String,
    new_name: String,
    allow_collision_bump: Option<bool>,
    encoding_state: tauri::State<'_, EncodingState>,
) -> Result<String, AppError> {
    // ... existing body up through `tokio::fs::rename(&old, &new_path).await?;`

    // After rename succeeds, migrate encoding state.
    let old_canon = old.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
    let new_canon = new_path.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
    if let (Some(o), Some(n)) = (old_canon, new_canon) {
        migrate_encoding_state(&encoding_state, &o, &n);
    }

    Ok(new_path.to_string_lossy().to_string())
}
```

(Note: the old path can't be canonicalized after the rename since the file moved; canonicalize *before* rename. Restructure if needed.)

Restructure to canonicalize BEFORE rename:

```rust
let old_canon = old.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
crate::services::file_watcher::register_rename_ignore(...).await;
tokio::fs::rename(&old, &new_path).await?;
let new_canon = new_path.canonicalize().ok().map(|p| p.to_string_lossy().to_string());
if let (Some(o), Some(n)) = (old_canon, new_canon) {
    migrate_encoding_state(&encoding_state, &o, &n);
}
```

- [ ] **Step 5: Adapt callers — TS bindings change**

The new signature is `rename_item(old_path, new_name, allow_collision_bump)` from the TS perspective (Tauri injects State automatically). No frontend caller change needed beyond Phase 2.3's update.

- [ ] **Step 6: Run all Rust tests**

Run: `pnpm test:rust`
Expected: PASS.

- [ ] **Step 7: Regenerate TS bindings**

Run: `pnpm tauri dev` — boot, quit.
Verify: `Grep "renameItem" app/lib/ipc/commands.ts` still shows the 3-arg signature.

- [ ] **Step 8: Commit**

```bash
git add core/src/commands/file.rs
git commit -m "feat(core): migrate encoding state on rename_item"
```

---

### Task 2.6: Backend smoke — full Phase 2 regression

- [ ] **Step 1: Run all Rust tests**

Run: `pnpm test:rust`
Expected: PASS, all 171+ tests + the new ones.

- [ ] **Step 2: Run all frontend unit tests**

Run: `pnpm test --run`
Expected: PASS, no regression from binding changes.

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Run existing E2E**

Run: `pnpm test:e2e:browser`
Expected: PASS (rename flow not yet wired into UI; existing behaviors unaffected).

If any test fails because the mock `tauri-mock.ts` needs the new field/argument, update mocks minimally — Phase 4 will add the dedicated mock support for the new behavior.

---

## Phase 3 — Frontend Wiring

Phase 3 hooks the utilities into stores, the new-file flow, the save flow, the Sidebar UI, and the Settings UI. By the end, the feature is user-visible.

### Task 3.1: Project new-file settings store

**Files:**
- Create: `app/lib/stores/new-file-settings.svelte.ts`
- Create: `tests/unit/stores/new-file-settings.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/stores/new-file-settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';

describe('newFileSettings', () => {
  beforeEach(() => localStorage.clear());

  it('default template is "Untitled {N}"', () => {
    newFileSettings.load();
    expect(newFileSettings.template).toBe('Untitled {N}');
  });

  it('default detectFromFolder is true', () => {
    newFileSettings.load();
    expect(newFileSettings.detectFromFolder).toBe(true);
  });

  it('default autoRenameFromH1 is true', () => {
    newFileSettings.load();
    expect(newFileSettings.autoRenameFromH1).toBe(true);
  });

  it('persists template change to localStorage', () => {
    newFileSettings.setTemplate('第{N}章');
    newFileSettings.load();
    expect(newFileSettings.template).toBe('第{N}章');
  });

  it('rejects invalid template (no {N})', () => {
    expect(() => newFileSettings.setTemplate('no number')).toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/stores/new-file-settings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the store**

```typescript
// app/lib/stores/new-file-settings.svelte.ts
import { parseTemplate } from '$lib/utils/placeholder';

const STORAGE_KEY = 'novelist.newFileSettings.v1';

interface SettingsShape {
  template: string;
  detectFromFolder: boolean;
  autoRenameFromH1: boolean;
}

const DEFAULTS: SettingsShape = {
  template: 'Untitled {N}',
  detectFromFolder: true,
  autoRenameFromH1: true,
};

class NewFileSettingsStore {
  template = $state<string>(DEFAULTS.template);
  detectFromFolder = $state<boolean>(DEFAULTS.detectFromFolder);
  autoRenameFromH1 = $state<boolean>(DEFAULTS.autoRenameFromH1);

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        this.template = DEFAULTS.template;
        this.detectFromFolder = DEFAULTS.detectFromFolder;
        this.autoRenameFromH1 = DEFAULTS.autoRenameFromH1;
        return;
      }
      const parsed = JSON.parse(raw) as Partial<SettingsShape>;
      this.template = parsed.template ?? DEFAULTS.template;
      this.detectFromFolder = parsed.detectFromFolder ?? DEFAULTS.detectFromFolder;
      this.autoRenameFromH1 = parsed.autoRenameFromH1 ?? DEFAULTS.autoRenameFromH1;
    } catch {
      // Fall back to defaults on parse error
      this.template = DEFAULTS.template;
      this.detectFromFolder = DEFAULTS.detectFromFolder;
      this.autoRenameFromH1 = DEFAULTS.autoRenameFromH1;
    }
  }

  private persist(): void {
    const data: SettingsShape = {
      template: this.template,
      detectFromFolder: this.detectFromFolder,
      autoRenameFromH1: this.autoRenameFromH1,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  setTemplate(template: string): void {
    if (!parseTemplate(template)) {
      throw new Error(`Invalid template: ${template}`);
    }
    this.template = template;
    this.persist();
  }

  setDetectFromFolder(value: boolean): void {
    this.detectFromFolder = value;
    this.persist();
  }

  setAutoRenameFromH1(value: boolean): void {
    this.autoRenameFromH1 = value;
    this.persist();
  }
}

export const newFileSettings = new NewFileSettingsStore();

// Auto-load on module init when running in a browser context
if (typeof localStorage !== 'undefined') {
  newFileSettings.load();
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/stores/new-file-settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stores/new-file-settings.svelte.ts tests/unit/stores/new-file-settings.test.ts
git commit -m "feat(store): newFileSettings rune store with localStorage persistence"
```

---

### Task 3.2: `projectStore` gains sortMode (per-project)

**Files:**
- Modify: `app/lib/stores/project.svelte.ts`
- Create: `tests/unit/stores/project-sort.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/stores/project-sort.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { projectStore } from '$lib/stores/project.svelte';

describe('projectStore.sortMode', () => {
  beforeEach(() => {
    localStorage.clear();
    projectStore.close();
  });

  it('defaults to numeric-asc', () => {
    expect(projectStore.sortMode).toBe('numeric-asc');
  });

  it('persists per-project to localStorage', () => {
    projectStore.setProject('/tmp/proj-a', null, []);
    projectStore.setSortMode('name-desc');
    expect(projectStore.sortMode).toBe('name-desc');

    // Switch project — should fall back to default for new project
    projectStore.setProject('/tmp/proj-b', null, []);
    expect(projectStore.sortMode).toBe('numeric-asc');

    // Switch back — should restore name-desc
    projectStore.setProject('/tmp/proj-a', null, []);
    expect(projectStore.sortMode).toBe('name-desc');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/stores/project-sort.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add sortMode to projectStore**

In `app/lib/stores/project.svelte.ts`, add at the top:

```typescript
import type { SortMode } from '$lib/utils/file-sort';

const SORT_KEY_PREFIX = 'novelist.sortMode.';

function readPersistedSort(dirPath: string): SortMode {
  if (typeof localStorage === 'undefined') return 'numeric-asc';
  const raw = localStorage.getItem(SORT_KEY_PREFIX + dirPath);
  if (raw === 'name-asc' || raw === 'name-desc' || raw === 'numeric-asc' ||
      raw === 'numeric-desc' || raw === 'mtime-asc' || raw === 'mtime-desc') {
    return raw;
  }
  return 'numeric-asc';
}
```

In the `ProjectStore` class:

```typescript
sortMode = $state<SortMode>('numeric-asc');

setSortMode(mode: SortMode) {
  this.sortMode = mode;
  if (this.dirPath && typeof localStorage !== 'undefined') {
    localStorage.setItem(SORT_KEY_PREFIX + this.dirPath, mode);
  }
}
```

In `setProject`:

```typescript
setProject(dirPath: string, config: ProjectConfig | null, files: FileEntry[]) {
  this.dirPath = dirPath;
  this.config = config;
  this.files = files.map(toNode);
  this.isLoading = false;
  this.singleFileMode = false;
  this.sortMode = readPersistedSort(dirPath);
}
```

In `close`:

```typescript
close() {
  this.dirPath = null;
  this.config = null;
  this.files = [];
  this.singleFileMode = false;
  this.sortMode = 'numeric-asc';
}
```

- [ ] **Step 4: Verify test passes**

Run: `pnpm test --run tests/unit/stores/project-sort.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stores/project.svelte.ts tests/unit/stores/project-sort.test.ts
git commit -m "feat(store): per-project sortMode rune persisted to localStorage"
```

---

### Task 3.3: Sidebar root list uses comparator

**Files:**
- Modify: `app/lib/components/Sidebar.svelte:76-80`

- [ ] **Step 1: Locate the existing sort**

The current Sidebar sort lives in the `sortedFiles` derived. Replace it with the new comparator.

- [ ] **Step 2: Modify `sortedFiles`**

In `app/lib/components/Sidebar.svelte`:

```typescript
import { compareByMode } from '$lib/utils/file-sort';
// (add to existing imports)

let sortedFiles = $derived.by<FileNode[]>(() => {
  return [...projectStore.files].sort((a, b) =>
    compareByMode(a, b, projectStore.sortMode)
  );
});
```

- [ ] **Step 3: Apply the same to `FileTreeNode.svelte`**

Find `FileTreeNode.svelte`'s child sort (likely a similar sorted-derived). Replace with `compareByMode(a, b, projectStore.sortMode)`.

Run: `Grep "sort\(|localeCompare" app/lib/components/FileTreeNode.svelte`
Expected: shows the inner sort call.

Replace it analogously, importing `projectStore` and `compareByMode`.

- [ ] **Step 4: Run unit tests**

Run: `pnpm test --run`
Expected: PASS (no test asserts the old order; if any does, fix).

- [ ] **Step 5: Verify visually (manual smoke)**

Run: `pnpm tauri dev`
Open a folder containing `第一章.md`, `第二章.md`, `第十章.md`. They should appear in numeric order. Quit.

- [ ] **Step 6: Commit**

```bash
git add app/lib/components/Sidebar.svelte app/lib/components/FileTreeNode.svelte
git commit -m "feat(sidebar): apply sortMode-aware comparator to file tree"
```

---

### Task 3.4: Sidebar header — sort dropdown

**Files:**
- Modify: `app/lib/components/Sidebar.svelte`
- Modify: `app/lib/i18n/locales/en.ts`
- Modify: `app/lib/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add i18n strings**

In `app/lib/i18n/locales/en.ts`, add under the `sidebar` namespace (or create one):

```typescript
sidebar: {
  sort: {
    button: 'Sort files',
    nameAsc: 'Name (A → Z)',
    nameDesc: 'Name (Z → A)',
    numericAsc: 'Number (1 → N)',
    numericDesc: 'Number (N → 1)',
    mtimeDesc: 'Modified (newest)',
    mtimeAsc: 'Modified (oldest)',
  },
},
```

In `app/lib/i18n/locales/zh-CN.ts`:

```typescript
sidebar: {
  sort: {
    button: '排序',
    nameAsc: '名称（A → Z）',
    nameDesc: '名称（Z → A）',
    numericAsc: '编号（1 → N）',
    numericDesc: '编号（N → 1）',
    mtimeDesc: '修改时间（最新）',
    mtimeAsc: '修改时间（最早）',
  },
},
```

- [ ] **Step 2: Add the dropdown UI in Sidebar header**

In `app/lib/components/Sidebar.svelte`, find the header area (the bit rendering project name + existing buttons). Add the sort dropdown beside the existing controls:

```svelte
<script lang="ts">
  // ...existing imports
  import type { SortMode } from '$lib/utils/file-sort';
  let sortMenuOpen = $state(false);

  const sortOptions: Array<{ id: SortMode; labelKey: string }> = [
    { id: 'numeric-asc', labelKey: 'sidebar.sort.numericAsc' },
    { id: 'numeric-desc', labelKey: 'sidebar.sort.numericDesc' },
    { id: 'name-asc', labelKey: 'sidebar.sort.nameAsc' },
    { id: 'name-desc', labelKey: 'sidebar.sort.nameDesc' },
    { id: 'mtime-desc', labelKey: 'sidebar.sort.mtimeDesc' },
    { id: 'mtime-asc', labelKey: 'sidebar.sort.mtimeAsc' },
  ];

  function selectSort(mode: SortMode) {
    projectStore.setSortMode(mode);
    sortMenuOpen = false;
  }
</script>

<!-- Inside the existing header row, next to the "+ new file" button: -->
<div class="relative">
  <button
    type="button"
    data-testid="sidebar-sort-button"
    title={t('sidebar.sort.button')}
    aria-label={t('sidebar.sort.button')}
    onclick={() => sortMenuOpen = !sortMenuOpen}
    class="p-1 rounded hover:bg-[var(--novelist-hover)]"
    style="color: var(--novelist-text-secondary);"
  >
    ⇅
  </button>
  {#if sortMenuOpen}
    <div
      class="absolute right-0 mt-1 z-50 rounded shadow-md text-sm"
      style="background: var(--novelist-panel-bg); border: 1px solid var(--novelist-border); min-width: 180px;"
      data-testid="sidebar-sort-menu"
    >
      {#each sortOptions as opt}
        <button
          type="button"
          data-testid="sidebar-sort-{opt.id}"
          onclick={() => selectSort(opt.id)}
          class="w-full text-left px-3 py-1.5 hover:bg-[var(--novelist-hover)] flex items-center gap-2"
          style="color: var(--novelist-text);"
        >
          <span class="w-3">{projectStore.sortMode === opt.id ? '✓' : ''}</span>
          <span>{t(opt.labelKey)}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
```

Add a click-outside handler to close the menu:

```svelte
<script>
  // ... existing
  $effect(() => {
    if (!sortMenuOpen) return;
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-testid="sidebar-sort-menu"], [data-testid="sidebar-sort-button"]')) {
        sortMenuOpen = false;
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });
</script>
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Smoke test**

Run: `pnpm tauri dev`. Open a project. Click the sort button. Switch modes. Verify visual reordering. Quit.

- [ ] **Step 5: Commit**

```bash
git add app/lib/components/Sidebar.svelte \
  app/lib/i18n/locales/en.ts app/lib/i18n/locales/zh-CN.ts
git commit -m "feat(sidebar): sort mode dropdown in header"
```

---

### Task 3.5: `tabsStore` — `updatePath` for rename propagation

**Files:**
- Modify: `app/lib/stores/tabs.svelte.ts`
- Create: `tests/unit/stores/tabs-update-path.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/stores/tabs-update-path.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { tabsStore } from '$lib/stores/tabs.svelte';

describe('tabsStore.updatePath', () => {
  beforeEach(() => {
    tabsStore.closeAll();
  });

  it('updates filePath and fileName on a single tab', () => {
    tabsStore.openTab('/proj/Untitled 1.md', '');
    const id = tabsStore.activeTabId!;
    tabsStore.updatePath('/proj/Untitled 1.md', '/proj/开篇.md');
    const tab = tabsStore.tabs.find(t => t.id === id);
    expect(tab?.filePath).toBe('/proj/开篇.md');
    expect(tab?.fileName).toBe('开篇.md');
  });

  it('updates ALL panes when same file open in split view', () => {
    tabsStore.openTab('/proj/foo.md', '');
    tabsStore.toggleSplit();
    tabsStore.openTabInPane('pane-2', '/proj/foo.md', '');
    tabsStore.updatePath('/proj/foo.md', '/proj/bar.md');
    const all = tabsStore.findAllByPath('/proj/bar.md');
    expect(all.length).toBe(2);
    const stillOld = tabsStore.findAllByPath('/proj/foo.md');
    expect(stillOld.length).toBe(0);
  });

  it('no-op when no matching tab', () => {
    tabsStore.openTab('/proj/a.md', '');
    expect(() => tabsStore.updatePath('/proj/missing.md', '/proj/x.md')).not.toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test --run tests/unit/stores/tabs-update-path.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `updatePath`**

In `app/lib/stores/tabs.svelte.ts` `TabsStore` class, add:

```typescript
/** Update filePath and fileName for ALL tabs across ALL panes that match `oldPath`. */
updatePath(oldPath: string, newPath: string) {
  const newName = newPath.split('/').pop() || newPath;
  for (const pane of this.panes) {
    for (const tab of pane.tabs) {
      if (tab.filePath === oldPath) {
        tab.filePath = newPath;
        tab.fileName = newName;
      }
    }
  }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `pnpm test --run tests/unit/stores/tabs-update-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/stores/tabs.svelte.ts tests/unit/stores/tabs-update-path.test.ts
git commit -m "feat(tabs): updatePath syncs filePath across all panes"
```

---

### Task 3.6: `App.svelte::handleNewFile` uses placeholder lib

**Files:**
- Modify: `app/App.svelte:257-274`

- [ ] **Step 1: Replace `handleNewFile`**

In `app/App.svelte`, find `handleNewFile` and replace its body:

```typescript
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
import { parseTemplate, inferNextName } from '$lib/utils/placeholder';

async function handleNewFile() {
  if (!projectStore.dirPath) return;

  // Determine target folder: focused folder if any, else project root.
  // (For now, use root. Subfolder targeting is a Phase 4 polish.)
  const targetDir = projectStore.dirPath;

  // List sibling files to feed inference
  const filesResult = await commands.listDirectory(targetDir);
  const siblings = filesResult.status === 'ok'
    ? filesResult.data.filter(e => !e.is_dir).map(e => e.name)
    : [];

  // Resolve template
  const userTemplate = parseTemplate(newFileSettings.template) ?? parseTemplate('Untitled {N}')!;

  const proposedName = newFileSettings.detectFromFolder
    ? inferNextName(siblings, userTemplate)
    : (() => {
        // Bypass folder detection — use user template at next-N
        return inferNextName([], userTemplate);
      })();

  const result = await commands.createFile(targetDir, proposedName);
  if (result.status === 'ok') {
    if (filesResult.status === 'ok') projectStore.updateFiles(filesResult.data);
    // Refresh again to pick up the newly created file
    const after = await commands.listDirectory(targetDir);
    if (after.status === 'ok') projectStore.updateFiles(after.data);

    const readResult = await commands.readFile(result.data);
    if (readResult.status === 'ok') {
      tabsStore.openTab(result.data, readResult.data);
      await commands.registerOpenFile(result.data);
    }
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Run frontend tests**

Run: `pnpm test --run`
Expected: PASS.

- [ ] **Step 4: Smoke**

Run: `pnpm tauri dev`. In an empty project folder, create new file → should be `Untitled 1.md`. In a folder with `第一章.md` and `第二章.md`, create new file → should be `第三章.md`. Quit.

- [ ] **Step 5: Commit**

```bash
git add app/App.svelte
git commit -m "feat(app): handleNewFile uses smart inference instead of timestamp"
```

---

### Task 3.7: Save flow — H1 auto-rename

**Files:**
- Modify: `app/lib/stores/tabs.svelte.ts` (the save method)
- Modify: `app/lib/components/Editor.svelte` (autosave trigger, if rename happens here)

- [ ] **Step 1: Locate the existing save**

Run: `Grep "writeFile|saveFile|save_dirty" app/lib/stores/tabs.svelte.ts`
Expected: shows `saveAllDirty`, individual save methods, and `markSaved`.

- [ ] **Step 2: Add a private rename helper to `tabsStore`**

In `app/lib/stores/tabs.svelte.ts`:

```typescript
import { isPlaceholder, renameFromH1 } from '$lib/utils/placeholder';
import { extractFirstH1 } from '$lib/utils/h1';
import { newFileSettings } from '$lib/stores/new-file-settings.svelte';

/**
 * Post-write hook: if the file is a placeholder and its content has an H1,
 * rename the file to match. Returns the new path (== old path if no rename).
 */
private async tryRenameAfterSave(filePath: string, content: string): Promise<string> {
  if (!newFileSettings.autoRenameFromH1) return filePath;
  const fileName = filePath.split('/').pop() || filePath;
  if (!isPlaceholder(fileName)) return filePath;
  const h1 = extractFirstH1(content);
  if (!h1 || h1.trim().length === 0) return filePath;

  const parentDir = filePath.slice(0, filePath.length - fileName.length - 1);
  // Re-list to get current siblings for collision check
  const list = await commands.listDirectory(parentDir);
  const siblings = list.status === 'ok' ? list.data.map(e => e.name) : [];

  const newName = renameFromH1(fileName, h1, siblings);
  if (!newName || newName === fileName) return filePath;

  const result = await commands.renameItem(filePath, newName, true);
  if (result.status !== 'ok') {
    console.warn('Auto-rename failed:', result.error);
    return filePath;
  }
  const newPath = result.data;
  this.updatePath(filePath, newPath);
  // Notify other windows
  await commands.broadcastFileRenamed(filePath, newPath).catch(() => {});
  return newPath;
}
```

(`broadcastFileRenamed` is added in Task 3.9.)

- [ ] **Step 3: Wire `tryRenameAfterSave` into save sites**

Find every place that calls `commands.writeFile(filePath, ...)` followed by `markSaved`. After the write succeeds, before the next user-visible step, call `await this.tryRenameAfterSave(filePath, content)`.

Examples (search and patch each):

```typescript
// closeTab branch (around line 237):
await commands.registerWriteIgnore(fresh.filePath);
const result = await commands.writeFile(fresh.filePath, fresh.content);
if (result.status === 'ok') {
  await this.tryRenameAfterSave(fresh.filePath, fresh.content);
  this.markSaved(fresh.id);
}
```

Repeat for `saveAllDirty`, `saveActive` (if present), and the autosave entry point. Be exhaustive — `Grep "commands.writeFile" app/lib/stores/tabs.svelte.ts` to find them.

- [ ] **Step 4: Add an integration test for the save+rename flow**

```typescript
// tests/unit/stores/tabs-save-rename.test.ts
// (skip if mocking IPC at unit level is impractical here — this is covered
// more thoroughly by E2E in Phase 4.)
```

For pragmatic reasons, defer the integration of save+rename to E2E (Task 4.1).

- [ ] **Step 5: Type-check + unit tests**

Run: `pnpm check && pnpm test --run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/lib/stores/tabs.svelte.ts
git commit -m "feat(tabs): H1-driven auto-rename after save for placeholder files"
```

---

### Task 3.8: Settings UI — "New file in project" section

**Files:**
- Modify: `app/lib/components/Settings.svelte`
- Modify: `app/lib/i18n/locales/en.ts`
- Modify: `app/lib/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Add i18n strings**

In `app/lib/i18n/locales/en.ts`, under `settings.editor`:

```typescript
newFile: {
  heading: 'New file in project',
  detectFromFolder: 'Detect chapter patterns from folder',
  detectFromFolderHint: 'When on, scans the folder and picks the next number in the existing series.',
  template: 'Default filename template',
  templateHint: 'Used when no folder pattern is detected.',
  templatePreview: 'Preview',
  templateInvalid: 'Template must contain {N} exactly once.',
  autoRename: 'Auto-rename placeholder files from H1',
  autoRenameHint: 'Only affects auto-generated names. Stops once you manually rename.',
  presetCustom: 'Custom…',
},
```

Mirror in `zh-CN.ts`:

```typescript
newFile: {
  heading: '项目内新建文件',
  detectFromFolder: '自动从文件夹推断章节命名',
  detectFromFolderHint: '关闭后总是用下方的默认模板。',
  template: '默认文件名模板',
  templateHint: '在未检测到文件夹章节模式时使用。',
  templatePreview: '预览',
  templateInvalid: '模板必须且只能包含一个 {N}。',
  autoRename: '保存时根据 H1 自动重命名占位文件',
  autoRenameHint: '仅对自动生成的文件名生效，手动重命名后停止。',
  presetCustom: '自定义…',
},
```

- [ ] **Step 2: Add the section to Settings.svelte**

In `app/lib/components/Settings.svelte`, locate the `editor` section (around line 423–514) and add a new block after the existing controls (e.g., after the auto-save interval control):

```svelte
<script>
  // Add to existing imports
  import { newFileSettings } from '$lib/stores/new-file-settings.svelte';
  import { parseTemplate, inferNextName } from '$lib/utils/placeholder';

  const PRESETS = [
    'Untitled {N}',
    '第{N}章',
    'Chapter {N}',
    '{N}-{title}',
    '{N}.{title}',
  ];

  let templateInput = $state(newFileSettings.template);
  let templateError = $state<string | null>(null);

  let preview = $derived.by(() => {
    const t = parseTemplate(templateInput);
    if (!t) return '';
    // Render 3 sample names for an empty folder
    const names: string[] = [];
    let folder: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = inferNextName(folder, t);
      names.push(next);
      folder.push(next);
    }
    return names.join(', ');
  });

  function applyTemplate() {
    try {
      newFileSettings.setTemplate(templateInput);
      templateError = null;
    } catch (e) {
      templateError = (e as Error).message;
    }
  }

  function selectPreset(p: string) {
    templateInput = p;
    applyTemplate();
  }
</script>

<!-- Within {#if activeSection === 'editor'} ... -->
<div class="mt-8" data-testid="settings-newfile-section">
  <h4 class="text-sm font-semibold mb-3" style="color: var(--novelist-text);">
    {t('settings.editor.newFile.heading')}
  </h4>

  <label class="flex items-start gap-2 mb-4">
    <input
      type="checkbox"
      data-testid="settings-newfile-detect"
      checked={newFileSettings.detectFromFolder}
      onchange={(e) => newFileSettings.setDetectFromFolder(e.currentTarget.checked)}
    />
    <div>
      <div>{t('settings.editor.newFile.detectFromFolder')}</div>
      <div class="text-xs" style="color: var(--novelist-text-secondary);">
        {t('settings.editor.newFile.detectFromFolderHint')}
      </div>
    </div>
  </label>

  <div class="mb-4">
    <div class="text-sm mb-1">{t('settings.editor.newFile.template')}</div>
    <div class="flex gap-2 items-center">
      <input
        type="text"
        data-testid="settings-newfile-template"
        bind:value={templateInput}
        onblur={applyTemplate}
        class="flex-1 px-2 py-1 rounded"
        style="background: var(--novelist-input-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
      />
      <select
        data-testid="settings-newfile-preset"
        onchange={(e) => selectPreset(e.currentTarget.value)}
        class="px-2 py-1 rounded"
        style="background: var(--novelist-input-bg); color: var(--novelist-text); border: 1px solid var(--novelist-border);"
      >
        <option value="">{t('settings.editor.newFile.presetCustom')}</option>
        {#each PRESETS as p}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </div>
    <div class="text-xs mt-1" style="color: var(--novelist-text-secondary);">
      {t('settings.editor.newFile.templateHint')}
    </div>
    {#if templateError}
      <div class="text-xs mt-1" style="color: var(--novelist-error, #c44);">{templateError}</div>
    {:else if preview}
      <div class="text-xs mt-1" style="color: var(--novelist-text-secondary);">
        {t('settings.editor.newFile.templatePreview')}: {preview}
      </div>
    {/if}
  </div>

  <label class="flex items-start gap-2">
    <input
      type="checkbox"
      data-testid="settings-newfile-autorename"
      checked={newFileSettings.autoRenameFromH1}
      onchange={(e) => newFileSettings.setAutoRenameFromH1(e.currentTarget.checked)}
    />
    <div>
      <div>{t('settings.editor.newFile.autoRename')}</div>
      <div class="text-xs" style="color: var(--novelist-text-secondary);">
        {t('settings.editor.newFile.autoRenameHint')}
      </div>
    </div>
  </label>
</div>
```

- [ ] **Step 3: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 4: Smoke**

Run: `pnpm tauri dev`. Open Settings > Editor. Confirm the new section appears, the template preview updates as you type, invalid templates show the error, and toggles persist after restart.

- [ ] **Step 5: Commit**

```bash
git add app/lib/components/Settings.svelte \
  app/lib/i18n/locales/en.ts app/lib/i18n/locales/zh-CN.ts
git commit -m "feat(settings): New file in project section with template preview"
```

---

### Task 3.9: Cross-window `file-renamed` broadcast

**Files:**
- Modify: `core/src/commands/file.rs` (new command `broadcast_file_renamed`)
- Modify: `core/src/lib.rs` (register the command)
- Modify: `app/App.svelte` (listen for the event and propagate to tabsStore)

- [ ] **Step 1: Add Rust command**

In `core/src/commands/file.rs`:

```rust
#[derive(Debug, Clone, Serialize, Type)]
pub struct FileRenamedPayload {
    pub old_path: String,
    pub new_path: String,
}

/// Emit a global Tauri event so other windows can update their tab state.
#[tauri::command]
#[specta::specta]
pub async fn broadcast_file_renamed(
    old_path: String,
    new_path: String,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    use tauri::Emitter;
    app.emit("file-renamed", FileRenamedPayload { old_path, new_path })
        .map_err(|e| AppError::Custom(format!("emit failed: {e}")))?;
    Ok(())
}
```

- [ ] **Step 2: Register in `lib.rs`**

In `core/src/lib.rs`, add `broadcast_file_renamed` to both the `tauri_specta::collect_commands!` call and the `invoke_handler` list.

- [ ] **Step 3: Regenerate bindings**

Run: `pnpm tauri dev` — boot, quit.
Verify: `Grep "broadcastFileRenamed" app/lib/ipc/commands.ts` shows the new function.

- [ ] **Step 4: Listen in `App.svelte`**

In `app/App.svelte`'s `onMount`:

```typescript
import { listen } from '@tauri-apps/api/event';

const unlistenRename = await listen<{ old_path: string; new_path: string }>(
  'file-renamed',
  (e) => {
    tabsStore.updatePath(e.payload.old_path, e.payload.new_path);
    // Refresh the parent folder in the sidebar
    const parent = e.payload.new_path.slice(0, e.payload.new_path.lastIndexOf('/'));
    projectStore.refreshFolder(parent).catch(() => {});
  }
);
// Don't forget to call unlistenRename() in onDestroy.
```

- [ ] **Step 5: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 6: Smoke**

Run: `pnpm tauri dev`. Open the project. Open a second window (Cmd+Shift+N) on the same project. In window A, create a new file, type `# 测试`, save → file renames. In window B, the sidebar refresh should reflect the new name; if a tab in window B was open on the old path, its filePath updates.

- [ ] **Step 7: Commit**

```bash
git add core/src/commands/file.rs core/src/lib.rs \
  app/lib/ipc/commands.ts app/App.svelte
git commit -m "feat(core): file-renamed cross-window broadcast event"
```

---

### Task 3.10: File-watcher `file-changed` survives renames

**Files:**
- Modify: `app/App.svelte` (the `file-changed` listener that uses `dirname`)

- [ ] **Step 1: Verify behavior**

The watcher emits `file-changed` events with file paths. After a rename, the watcher should NOT emit a `file-changed` for either old or new path (suppressed by Phase 2.4). But the sidebar still needs a `refreshFolder(parent)` to pick up the new entry — which is handled in Task 3.9 step 4.

This task is a no-op confirmation step; documented separately to flag the risk.

- [ ] **Step 2: Smoke test for spurious reload**

Run: `pnpm tauri dev`. In an open file with content "hello", trigger a rename via Cmd+S after writing `# Title`. Verify the editor does NOT reload from disk (no flicker, undo history preserved).

If the editor DOES reload, debug: trace whether the `file-changed` event fires; if it does, the rename-ignore in Phase 2.4 didn't hook the right event variants. Fix by widening the suppression in `core/src/services/file_watcher.rs` to cover `Modify(Modify::Name(...))` notify events as well.

- [ ] **Step 3: Commit (only if a fix was needed)**

```bash
git add core/src/services/file_watcher.rs
git commit -m "fix(watcher): also suppress Name-modify events on registered renames"
```

---

## Phase 4 — E2E Tests, i18n Polish, and Release Gates

### Task 4.1: E2E mocks support new IPC + behavior

**Files:**
- Modify: `tests/e2e/fixtures/tauri-mock.ts`

- [ ] **Step 1: Inspect existing mock**

Run: `Grep "rename_item|listDirectory|writeFile|create_file" tests/e2e/fixtures/tauri-mock.ts -n`
Expected: shows the existing mock entries.

- [ ] **Step 2: Add `mtime` to mock listDirectory entries**

Each mock file in `mockState.files` should optionally carry `mtime`. Update the entry shape and the response builder to pass `mtime: file.mtime ?? Date.now()`.

- [ ] **Step 3: Update mock `rename_item` to accept the third arg**

```typescript
case 'rename_item': {
  const { old_path, new_name, allow_collision_bump } = payload;
  // Strip parent
  const parent = old_path.slice(0, old_path.lastIndexOf('/'));
  let newPath = `${parent}/${new_name}`;
  if (mockState.files.some(f => f.path === newPath) && allow_collision_bump) {
    let n = 2;
    const base = new_name.replace(/\.md$/, '');
    while (mockState.files.some(f => f.path === `${parent}/${base} ${n}.md`)) n++;
    newPath = `${parent}/${base} ${n}.md`;
  }
  const file = mockState.files.find(f => f.path === old_path);
  if (!file) return { status: 'error', error: 'not found' };
  file.path = newPath;
  file.name = newPath.split('/').pop()!;
  return { status: 'ok', data: newPath };
}
```

- [ ] **Step 4: Add mock `broadcast_file_renamed` (no-op return ok)**

```typescript
case 'broadcast_file_renamed':
  return { status: 'ok', data: null };
```

- [ ] **Step 5: Verify existing E2E still passes**

Run: `pnpm test:e2e:browser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/fixtures/tauri-mock.ts
git commit -m "test(e2e): mock supports mtime, rename collision-bump, file-renamed broadcast"
```

---

### Task 4.2: E2E — new file naming flow

**Files:**
- Create: `tests/e2e/specs/new-file-naming.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/specs/new-file-naming.spec.ts
import { test, expect } from '../fixtures/tauri-test';

test.describe('New file naming in project mode', () => {
  test('empty folder → Untitled 1.md', async ({ app, mockState }) => {
    await mockState.openProject('/proj', []);
    await app.getByTestId('sidebar-new-file-btn').click();
    await expect(app.getByText('Untitled 1.md')).toBeVisible();
  });

  test('folder with chapter pattern → next chapter', async ({ app, mockState }) => {
    await mockState.openProject('/proj', [
      { name: '第一章.md', path: '/proj/第一章.md', is_dir: false, size: 0 },
      { name: '第二章.md', path: '/proj/第二章.md', is_dir: false, size: 0 },
    ]);
    await app.getByTestId('sidebar-new-file-btn').click();
    await expect(app.getByText('第三章.md')).toBeVisible();
  });

  test('H1 + save renames placeholder', async ({ app, mockState }) => {
    await mockState.openProject('/proj', []);
    await app.getByTestId('sidebar-new-file-btn').click();
    // Type H1
    await app.locator('.cm-content').first().pressSequentially('# 开篇\n');
    // Cmd+S
    await app.keyboard.press('Meta+s');
    await expect(app.getByText('开篇.md')).toBeVisible();
    // Window title should reflect new name
    await expect(app).toHaveTitle(/开篇/);
  });

  test('manual rename then H1 = no auto-rename', async ({ app, mockState }) => {
    await mockState.openProject('/proj', []);
    await app.getByTestId('sidebar-new-file-btn').click();
    // Manually rename the file
    await mockState.renameFile('/proj/Untitled 1.md', '/proj/manual.md');
    await app.waitForTimeout(100);
    // Type a new H1 and save
    await app.locator('.cm-content').first().pressSequentially('# 别动我\n');
    await app.keyboard.press('Meta+s');
    await app.waitForTimeout(100);
    // File name should still be "manual.md"
    await expect(app.getByText('manual.md')).toBeVisible();
    await expect(app.getByText('别动我.md')).not.toBeVisible();
  });

  test('collision on rename bumps to " 2"', async ({ app, mockState }) => {
    await mockState.openProject('/proj', [
      { name: '开篇.md', path: '/proj/开篇.md', is_dir: false, size: 0 },
    ]);
    await app.getByTestId('sidebar-new-file-btn').click();
    await app.locator('.cm-content').first().pressSequentially('# 开篇\n');
    await app.keyboard.press('Meta+s');
    await expect(app.getByText('开篇 2.md')).toBeVisible();
  });
});
```

- [ ] **Step 2: Add `openProject` and `renameFile` helpers to `mockState`**

In `tests/e2e/fixtures/tauri-mock.ts`, extend `mockState`:

```typescript
mockState.openProject = async (dirPath: string, files: FileEntry[]) => {
  mockState.dirPath = dirPath;
  mockState.files = files;
};
mockState.renameFile = async (oldPath: string, newPath: string) => {
  const f = mockState.files.find(x => x.path === oldPath);
  if (!f) return;
  f.path = newPath;
  f.name = newPath.split('/').pop()!;
};
```

(Adapt to the existing fixture shape.)

- [ ] **Step 3: Add `data-testid="sidebar-new-file-btn"` to the button**

In `app/lib/components/Sidebar.svelte`, locate the "+ new file" button and add `data-testid="sidebar-new-file-btn"`. (If it already has one, reuse it.)

- [ ] **Step 4: Run the new spec**

Run: `pnpm test:e2e:browser tests/e2e/specs/new-file-naming.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/specs/new-file-naming.spec.ts \
  tests/e2e/fixtures/tauri-mock.ts \
  app/lib/components/Sidebar.svelte
git commit -m "test(e2e): new-file naming, H1 auto-rename, collision bump"
```

---

### Task 4.3: E2E — sidebar sort modes

**Files:**
- Create: `tests/e2e/specs/sidebar-sort.spec.ts`

- [ ] **Step 1: Write the spec**

```typescript
// tests/e2e/specs/sidebar-sort.spec.ts
import { test, expect } from '../fixtures/tauri-test';

test.describe('Sidebar sort modes', () => {
  test('numeric-asc orders chapters numerically by default', async ({ app, mockState }) => {
    await mockState.openProject('/proj', [
      { name: '第十章.md', path: '/proj/第十章.md', is_dir: false, size: 0 },
      { name: '第二章.md', path: '/proj/第二章.md', is_dir: false, size: 0 },
      { name: '第一章.md', path: '/proj/第一章.md', is_dir: false, size: 0 },
    ]);
    const items = app.locator('[data-testid="filetree-item"]');
    await expect(items.nth(0)).toHaveText(/第一章/);
    await expect(items.nth(1)).toHaveText(/第二章/);
    await expect(items.nth(2)).toHaveText(/第十章/);
  });

  test('switching to name-asc gives lexicographic order', async ({ app, mockState }) => {
    await mockState.openProject('/proj', [
      { name: '第十章.md', path: '/proj/第十章.md', is_dir: false, size: 0 },
      { name: '第二章.md', path: '/proj/第二章.md', is_dir: false, size: 0 },
    ]);
    await app.getByTestId('sidebar-sort-button').click();
    await app.getByTestId('sidebar-sort-name-asc').click();
    const items = app.locator('[data-testid="filetree-item"]');
    // Lex order puts 十 (U+5341) before 二 (U+4E8C)? No — 二 (U+4E8C) < 十 (U+5341).
    // So name-asc: 第二章, 第十章 (still!). Use a different example for the lex differentiator.
    // Replace fixture with arabic to make the lex/numeric divergence visible:
  });

  test('name-asc vs numeric-asc: 1, 10, 2 vs 1, 2, 10', async ({ app, mockState }) => {
    await mockState.openProject('/proj', [
      { name: '10-finale.md', path: '/proj/10-finale.md', is_dir: false, size: 0 },
      { name: '2-rising.md', path: '/proj/2-rising.md', is_dir: false, size: 0 },
      { name: '1-intro.md', path: '/proj/1-intro.md', is_dir: false, size: 0 },
    ]);
    // numeric-asc default
    let items = app.locator('[data-testid="filetree-item"]');
    await expect(items.nth(0)).toHaveText(/1-intro/);
    await expect(items.nth(1)).toHaveText(/2-rising/);
    await expect(items.nth(2)).toHaveText(/10-finale/);

    // Switch to name-asc
    await app.getByTestId('sidebar-sort-button').click();
    await app.getByTestId('sidebar-sort-name-asc').click();
    items = app.locator('[data-testid="filetree-item"]');
    await expect(items.nth(0)).toHaveText(/1-intro/);
    await expect(items.nth(1)).toHaveText(/10-finale/);
    await expect(items.nth(2)).toHaveText(/2-rising/);
  });

  test('sort mode persists per project', async ({ app, mockState }) => {
    await mockState.openProject('/proj-A', []);
    await app.getByTestId('sidebar-sort-button').click();
    await app.getByTestId('sidebar-sort-name-desc').click();
    // Switch project
    await mockState.openProject('/proj-B', []);
    await app.getByTestId('sidebar-sort-button').click();
    // Default for B is numeric-asc (the ✓ should be on numeric-asc)
    await expect(app.locator('[data-testid="sidebar-sort-numeric-asc"]')).toContainText('✓');
    // Switch back
    await mockState.openProject('/proj-A', []);
    await app.getByTestId('sidebar-sort-button').click();
    await expect(app.locator('[data-testid="sidebar-sort-name-desc"]')).toContainText('✓');
  });
});
```

- [ ] **Step 2: Add `data-testid="filetree-item"` to FileTreeNode rows**

In `app/lib/components/FileTreeNode.svelte`, the row `<div>` or `<button>` that renders each file/folder name should have `data-testid="filetree-item"`. If a more specific testid already exists, reuse / extend.

- [ ] **Step 3: Run the spec**

Run: `pnpm test:e2e:browser tests/e2e/specs/sidebar-sort.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/specs/sidebar-sort.spec.ts \
  app/lib/components/FileTreeNode.svelte
git commit -m "test(e2e): sidebar sort mode coverage"
```

---

### Task 4.4: Migration cleanup — drop old scratch filename in handleNewFile

The legacy `novelist_scratch_<ts>.md` was the previous naming. With Task 3.6 it is no longer generated. The `isPlaceholder` regex retains it for one release so existing files in user folders still get auto-renamed on save.

- [ ] **Step 1: Verify backward-compat detection**

Run: `pnpm test --run tests/unit/utils/placeholder.test.ts`
Expected: PASS, including the legacy `novelist_scratch_*` test.

- [ ] **Step 2: Add a TODO note for future removal**

In `app/lib/utils/placeholder.ts`, add a comment above the legacy regex:

```typescript
// Legacy: pre-v0.1.x naming. Recognized for one release so existing files
// auto-rename on first save. Remove after v0.3.x.
/^novelist_scratch_\d+\.md$/,
```

- [ ] **Step 3: Commit**

```bash
git add app/lib/utils/placeholder.ts
git commit -m "docs(placeholder): note legacy novelist_scratch removal target"
```

---

### Task 4.5: Documentation updates

**Files:**
- Modify: `Novelist-app/CLAUDE.md`
- Modify: `Novelist-app/docs/keyboard-shortcuts.md` (if any new shortcut is introduced — none in this plan)
- Modify: `Novelist-app/docs/development.md` (no change needed)

- [ ] **Step 1: Add a "Recent Additions" entry**

In `CLAUDE.md`, under "Recent Additions (v0.1.0+)", append:

```markdown
- **Smart new file naming**: project-mode "New file" infers the next chapter number from sibling filenames; falls back to a user-configurable template (Settings > Editor > New file in project). Saving a file with an H1 renames the file to match (one-shot, only while the filename is still placeholder)
- **Numeric-aware sidebar sort**: file tree orders `第二章 < 第十章` numerically by default; sort mode dropdown in the sidebar header offers name/number/mtime asc-desc; choice persists per project
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: smart new file naming + sort modes in Recent Additions"
```

---

### Task 4.6: Full regression run

- [ ] **Step 1: Unit + Rust + E2E**

Run all three:

```bash
pnpm test --run
pnpm test:rust
pnpm test:e2e:browser
```

Expected: PASS for all.

- [ ] **Step 2: Type-check**

Run: `pnpm check`
Expected: PASS.

- [ ] **Step 3: Manual smoke checklist**

Boot `pnpm tauri dev` and verify each user-facing scenario:

| Scenario | Expected |
|---|---|
| Empty folder + click "+" | New file `Untitled 1.md` |
| Folder with `第一章.md, 第二章.md` + click "+" | New file `第三章.md` |
| Type `# 开篇`, Cmd+S in `Untitled 1.md` | Renames to `开篇.md`; window title updates; sidebar refreshes |
| Type `# 开篇` while `开篇.md` exists | Renames to `开篇 2.md` |
| Manually rename then type new H1 | No auto-rename |
| Settings: change template to `第{N}章`, new file in empty folder | `第一章.md` |
| Sidebar sort dropdown: switch through all 6 modes | Tree reorders |
| Sort mode persists across project switches | ✓ |
| Two windows open same project, rename in one | Other window's tab updates filePath |
| Split view, same file in both panes, rename | Both tabs update |

- [ ] **Step 4: Commit final polish (if any)**

If the manual smoke surfaces small fixes, address them and commit individually with `fix:` prefixes.

---

## Done — Definition

The plan is complete when:
- [ ] All Phase 1–4 tasks committed
- [ ] `pnpm test --run` passes
- [ ] `pnpm test:rust` passes
- [ ] `pnpm test:e2e:browser` passes
- [ ] `pnpm check` passes
- [ ] Manual smoke checklist (4.6 step 3) passes
- [ ] CLAUDE.md "Recent Additions" updated
- [ ] Spec doc unchanged (was the contract; no design drift)
