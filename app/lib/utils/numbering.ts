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
  const cnLower = parseChineseLower(s);
  if (cnLower !== null) return { value: cnLower, style: { kind: 'chinese-lower' } };
  const cnUpper = parseChineseUpper(s);
  if (cnUpper !== null) return { value: cnUpper, style: { kind: 'chinese-upper' } };
  return null;
}

export function formatNumber(value: number, style: NumberStyle): string {
  if (style.kind === 'arabic') return String(value).padStart(style.width, '0');
  if (style.kind === 'chinese-lower') return formatChineseLower(value);
  if (style.kind === 'chinese-upper') return formatChineseUpper(value);
  throw new Error(`formatNumber: unsupported style ${style.kind}`);
}

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
  // Inside a hundreds context, 10–19 must be written as 一十 / 一十X (not bare 十 / 十X)
  if (rest < 20) {
    const ones = rest - 10;
    return CN_LOWER_DIGITS[hundreds] + '百一十' + (ones === 0 ? '' : CN_LOWER_DIGITS[ones]);
  }
  return CN_LOWER_DIGITS[hundreds] + '百' + formatChineseLower(rest);
}

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
