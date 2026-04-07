/**
 * CJK-aware word count.
 * CJK characters: each counts as 1 word.
 * Latin text: whitespace-delimited words.
 * Mixed: sum of both.
 */
export function countWords(text: string): number {
  if (!text.trim()) return 0;

  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{30000}-\u{3134f}\u3000-\u303f\uff00-\uffef]/gu;

  const cjkMatches = text.match(cjkRegex);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  const withoutCjk = text.replace(cjkRegex, ' ');
  const latinWords = withoutCjk.split(/\s+/).filter(w => w.length > 0);

  return cjkCount + latinWords.length;
}
