import { describe, it, expect } from 'vitest';
import { parseTemplate, renderTemplate, isPlaceholder, inferNextName, renameFromH1, isTemplateTitlePlaceholder, renameFromTemplateTitleSlot } from '$lib/utils/placeholder';

describe('parseTemplate', () => {
  it('parses Untitled {N}', () => {
    const t = parseTemplate('Untitled {N}');
    expect(t).toEqual({
      raw: 'Untitled {N}',
      hasNumberSlot: true,
      prefix: 'Untitled ',
      suffix: '',
      hasTitleSlot: false,
      titleSlotPosition: null,
      forceStyle: null,
    });
  });
  it('parses {title} alone as a title-only template', () => {
    const t = parseTemplate('{title}');
    expect(t).toEqual({
      raw: '{title}',
      hasNumberSlot: false,
      prefix: '',
      suffix: '',
      hasTitleSlot: true,
      titleSlotPosition: null,
      forceStyle: null,
    });
  });
  it('rejects a template with no slot at all', () => {
    expect(parseTemplate('no number')).toBeNull();
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

  // Extended placeholder tokens for forced style / padding ({3N}, {CN}, {rN}).
  it('parses {2N} as Arabic width 2', () => {
    const t = parseTemplate('{2N}-{title}');
    expect(t?.forceStyle).toEqual({ kind: 'arabic', width: 2 });
  });
  it('parses {3N} as Arabic width 3', () => {
    const t = parseTemplate('Chapter {3N}');
    expect(t?.forceStyle).toEqual({ kind: 'arabic', width: 3 });
    expect(t?.prefix).toBe('Chapter ');
    expect(t?.suffix).toBe('');
  });
  it('parses {CN} as Chinese forced', () => {
    const t = parseTemplate('{CN}. {title}');
    expect(t?.forceStyle).toEqual({ kind: 'chinese-lower' });
  });
  it('parses {rN} as Roman forced', () => {
    expect(parseTemplate('Part {rN}')?.forceStyle).toEqual({ kind: 'roman-upper' });
  });
  it('rejects retired {cN} token', () => {
    expect(parseTemplate('{cN}. {title}')).toBeNull();
  });
  it('bare {N} has forceStyle null (natural)', () => {
    expect(parseTemplate('第{N}章')?.forceStyle).toBeNull();
  });
});

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

describe('inferNextName', () => {
  const defaultTemplate = parseTemplate('Untitled {N}')!;

  it('empty folder uses default template', () => {
    expect(inferNextName([], defaultTemplate)).toBe('Untitled 1.md');
  });

  it('user template applied to empty folder uses Arabic for {N}', () => {
    const t = parseTemplate('第{N}章')!;
    expect(inferNextName([], t)).toBe('第1章.md');
  });

  it('{CN} template on empty folder uses Chinese', () => {
    const t = parseTemplate('第{CN}章')!;
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

  it('{3N} template renders zero-padded width 3 on empty folder', () => {
    const t = parseTemplate('{3N}-{title}')!;
    expect(inferNextName([], t)).toBe('001-Untitled.md');
  });

  it('{3N} template continues series from existing files', () => {
    const t = parseTemplate('{3N}-{title}')!;
    expect(inferNextName(['001-intro.md', '002-rising.md'], t)).toBe('003-Untitled.md');
  });

  it('{2N} template: 09 → 10 keeps width', () => {
    const t = parseTemplate('{2N}-{title}')!;
    expect(inferNextName(['08-foo.md', '09-bar.md'], t)).toBe('10-Untitled.md');
  });

  it('{CN} template renders Chinese regardless of folder style', () => {
    const t = parseTemplate('{CN}. {title}')!;
    expect(inferNextName([], t)).toBe('一. Untitled.md');
    // Even with an Arabic-style sibling the forceStyle wins for new names
    expect(inferNextName(['1. foo.md'], t)).toBe('二. Untitled.md');
  });

  it('{rN} template renders Roman', () => {
    const t = parseTemplate('Chapter {rN}')!;
    expect(inferNextName([], t)).toBe('Chapter I.md');
    expect(inferNextName(['Chapter I.md', 'Chapter II.md'], t)).toBe('Chapter III.md');
  });

  it('avoids collision by bumping number', () => {
    expect(inferNextName(['第一章.md', '第二章.md', '第三章.md'], defaultTemplate))
      .toBe('第四章.md');
  });

  it('Untitled fallback bumps number on collision', () => {
    expect(inferNextName(['Untitled 1.md', 'Untitled 2.md'], defaultTemplate))
      .toBe('Untitled 3.md');
  });

  // Regression: a date-prefixed user template (e.g. `{date:YYMMDD}_{N}` resolved
  // to `260508_{N}`) must not have the generic `{N}_{title}` builtin family
  // misinterpret the date prefix as a chapter number — that would produce
  // `260509_Untitled.md` instead of `260508_3.md`.
  describe('date-prefixed user template — bug repro', () => {
    it('user template wins over builtin {N}_{title} when both match (same day)', () => {
      const t = parseTemplate('260508_{N}')!;
      expect(inferNextName(['260508_1.md', '260508_2.md'], t)).toBe('260508_3.md');
    });
    it('cross-day: date-prefixed template gets fresh N=1 even with prior-day siblings', () => {
      // May 9: user template resolved to `260509_{N}`, siblings only from May 8.
      const t = parseTemplate('260509_{N}')!;
      expect(inferNextName(['260508_1.md', '260508_2.md'], t)).toBe('260509_1.md');
    });
    it('user-renamed sibling with implausible date prefix does not derail today', () => {
      const t = parseTemplate('260508_Untitled {N}')!;
      // User has manually renamed an old file to a custom date — still in folder.
      expect(inferNextName(['261225_Special.md'], t)).toBe('260508_Untitled 1.md');
    });
    it('{date}_Untitled {N} same-day increments N, not date', () => {
      const t = parseTemplate('260508_Untitled {N}')!;
      expect(inferNextName(['260508_Untitled 1.md', '260508_Untitled 2.md'], t))
        .toBe('260508_Untitled 3.md');
    });
  });

  describe('title-only template', () => {
    it('empty folder renders Untitled.md', () => {
      const t = parseTemplate('{title}')!;
      expect(inferNextName([], t)).toBe('Untitled.md');
    });
    it('bumps the suffix on collision', () => {
      const t = parseTemplate('{title}')!;
      expect(inferNextName(['Untitled.md'], t)).toBe('Untitled 2.md');
      expect(inferNextName(['Untitled.md', 'Untitled 2.md'], t))
        .toBe('Untitled 3.md');
    });
    it('honors literal text around the title slot', () => {
      const t = parseTemplate('draft-{title}')!;
      expect(inferNextName([], t)).toBe('draft-Untitled.md');
    });
  });
});

describe('renderTemplate — title-only template', () => {
  it('renders the H1 directly when title is non-empty', () => {
    const t = parseTemplate('{title}')!;
    expect(renderTemplate(t, 0, { kind: 'arabic', width: 1 }, '开篇'))
      .toBe('开篇.md');
  });
  it('falls back to Untitled.md when title is empty', () => {
    const t = parseTemplate('{title}')!;
    expect(renderTemplate(t, 0, { kind: 'arabic', width: 1 }, null))
      .toBe('Untitled.md');
  });
});

describe('renameFromH1 — title-only template', () => {
  it('replaces a bare Untitled.md with the sanitized H1', () => {
    expect(renameFromH1('Untitled.md', '第一章 开端', []))
      .toBe('第一章 开端.md');
  });
});

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
  it('260508_Untitled 1.md + 开篇 → 260508_开篇.md (date prefix preserved)', () => {
    expect(renameFromH1('260508_Untitled 1.md', '开篇', [])).toBe('260508_开篇.md');
  });
  it('20260508-Untitled 3.md + Opening → 20260508-Opening.md', () => {
    expect(renameFromH1('20260508-Untitled 3.md', 'Opening', [])).toBe('20260508-Opening.md');
  });
  it('non-placeholder returns null even with a fresh H1 (body H1 must not rename)', () => {
    // Once the file has a real name, typing more H1s in the body must not
    // re-trigger auto-rename. isPlaceholder is the only gate.
    expect(renameFromH1('开篇.md', 'Second heading', [])).toBeNull();
    expect(renameFromH1('Chapter 3 开篇.md', 'Another', [])).toBeNull();
    expect(renameFromH1('03-开篇.md', 'Another', [])).toBeNull();
  });
});

describe('isTemplateTitlePlaceholder + renameFromTemplateTitleSlot', () => {
  // The production default template renders placeholders the static
  // PLACEHOLDER_PATTERNS list can't know about (第1章-Untitled.md). These
  // template-derived matchers are what make Path A work out of the box.
  const DEFAULT = '第{N}章-{title}';

  it('matches the default template placeholder form', () => {
    expect(isTemplateTitlePlaceholder('第1章-Untitled.md', DEFAULT)).toBe(true);
    expect(isTemplateTitlePlaceholder('第12章-Untitled.md', DEFAULT)).toBe(true);
    expect(isTemplateTitlePlaceholder('第二章-Untitled.md', DEFAULT)).toBe(true);
    expect(isTemplateTitlePlaceholder('第1章-Untitled 2.md', DEFAULT)).toBe(true); // collision bump
  });

  it('does not match titled or foreign names', () => {
    expect(isTemplateTitlePlaceholder('第1章-开篇.md', DEFAULT)).toBe(false);
    expect(isTemplateTitlePlaceholder('Untitled 1.md', DEFAULT)).toBe(false);
    expect(isTemplateTitlePlaceholder('第1章.md', DEFAULT)).toBe(false);
  });

  it('matches a title-only template placeholder', () => {
    expect(isTemplateTitlePlaceholder('draft-Untitled.md', 'draft-{title}')).toBe(true);
    expect(isTemplateTitlePlaceholder('draft-overview.md', 'draft-{title}')).toBe(false);
  });

  it('returns false for templates without a {title} slot', () => {
    expect(isTemplateTitlePlaceholder('Untitled 1.md', 'Untitled {N}')).toBe(false);
    expect(isTemplateTitlePlaceholder('第1章.md', '第{N}章')).toBe(false);
  });

  it('第1章-Untitled.md + 开篇 → 第1章-开篇.md', () => {
    expect(renameFromTemplateTitleSlot('第1章-Untitled.md', '开篇', DEFAULT, []))
      .toBe('第1章-开篇.md');
  });

  it('drops the collision counter when filling the title', () => {
    expect(renameFromTemplateTitleSlot('第1章-Untitled 2.md', '开篇', DEFAULT, []))
      .toBe('第1章-开篇.md');
  });

  it('bumps on sibling collision', () => {
    expect(renameFromTemplateTitleSlot('第1章-Untitled.md', '开篇', DEFAULT, ['第1章-开篇.md']))
      .toBe('第1章-开篇 2.md');
  });

  it('returns null when H1 sanitizes to empty or name is unchanged', () => {
    expect(renameFromTemplateTitleSlot('第1章-Untitled.md', '   ', DEFAULT, [])).toBeNull();
    expect(renameFromTemplateTitleSlot('第1章-Untitled.md', 'Untitled', DEFAULT, [])).toBeNull();
  });
});
