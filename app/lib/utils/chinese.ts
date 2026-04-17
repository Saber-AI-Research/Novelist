/**
 * Chinese text utilities: Simplified/Traditional conversion and Pinyin generation.
 * All dependencies are lazy-loaded via dynamic import() to avoid bundling
 * large dictionaries upfront.
 */

// --- Simplified <-> Traditional conversion (opencc-js) ---

let openccLoaded = false;
let converterS2T: ((text: string) => string) | null = null;
let converterT2S: ((text: string) => string) | null = null;

async function ensureOpenCC(): Promise<void> {
  if (openccLoaded) return;
  const OpenCC = await import('opencc-js');
  converterS2T = OpenCC.Converter({ from: 'cn', to: 'tw' });
  converterT2S = OpenCC.Converter({ from: 'tw', to: 'cn' });
  openccLoaded = true;
}

/** Convert Simplified Chinese text to Traditional Chinese. */
export async function simplifiedToTraditional(text: string): Promise<string> {
  await ensureOpenCC();
  return converterS2T!(text);
}

/** Convert Traditional Chinese text to Simplified Chinese. */
export async function traditionalToSimplified(text: string): Promise<string> {
  await ensureOpenCC();
  return converterT2S!(text);
}

// --- Pinyin generation (pinyin-pro) ---

/** Generate Pinyin with tone marks for the given Chinese text. */
export async function toPinyin(text: string): Promise<string> {
  const { pinyin } = await import('pinyin-pro');
  return pinyin(text, { toneType: 'symbol', type: 'string' });
}
