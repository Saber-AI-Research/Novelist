export type DiffPart = {
  kind: 'same' | 'added' | 'removed';
  text: string;
};

// CJK prose has no spaces, so whitespace tokenization would turn a whole
// paragraph into one token (and one giant removed+added pair). Each CJK
// character / fullwidth punctuation mark is its own token instead.
const CJK = '\\u2E80-\\u2FFF\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFFEF';
const TOKEN_RE = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, 'g');

/** Above this many LCS cells, fall back to whitespace tokens to stay fast. */
const MAX_CELLS = 2_000_000;

function tokenize(text: string, fine: boolean): string[] {
  return (fine ? text.match(TOKEN_RE) : text.match(/\s+|[^\s]+/g)) ?? [];
}

/**
 * Character-level CJK diffs match stray common characters (的, 了, ，) inside
 * otherwise rewritten spans, which renders as confetti. Fold any 1-char
 * unchanged island that sits between two edits into the edit.
 */
function cleanup(parts: DiffPart[]): DiffPart[] {
  const changed = (p?: DiffPart) => p !== undefined && p.kind !== 'same';
  let out = parts;
  for (let pass = 0; pass < 4; pass++) {
    const next: DiffPart[] = [];
    let removed = '';
    let added = '';
    let dirty = false;
    const flush = () => {
      if (removed) next.push({ kind: 'removed', text: removed });
      if (added) next.push({ kind: 'added', text: added });
      removed = '';
      added = '';
    };
    for (let i = 0; i < out.length; i++) {
      const part = out[i];
      const island =
        part.kind === 'same' && [...part.text].length === 1 && changed(out[i - 1]) && changed(out[i + 1]);
      if (island) dirty = true;
      if (part.kind === 'removed' || island) removed += part.text;
      if (part.kind === 'added' || island) added += part.text;
      if (part.kind === 'same' && !island) {
        flush();
        next.push(part);
      }
    }
    flush();
    out = next;
    if (!dirty) break;
  }
  return out;
}

export function buildWordDiff(original: string, revised: string): DiffPart[] {
  let a = tokenize(original, true);
  let b = tokenize(revised, true);
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    a = tokenize(original, false);
    b = tokenize(revised, false);
  }
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('removed', a[i++]);
    } else {
      push('added', b[j++]);
    }
  }
  while (i < a.length) push('removed', a[i++]);
  while (j < b.length) push('added', b[j++]);
  return cleanup(parts);
}
