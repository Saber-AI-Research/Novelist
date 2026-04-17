import type { Theme } from '$lib/themes';

/**
 * Parse a Typora CSS theme file and convert it to a Novelist Theme.
 *
 * Typora themes use standard CSS with:
 * - :root CSS custom properties (--bg-color, --text-color, --primary-color, etc.)
 * - Direct property values on selectors (body, #write, h1-h6, a, code, blockquote)
 *
 * We extract the relevant colors and map them to Novelist's CSS variable system.
 */

// ── CSS parsing helpers ──────────────────────────────────────

/** Extract all CSS custom properties from :root { ... } blocks */
function extractRootVars(css: string): Record<string, string> {
  const vars: Record<string, string> = {};
  // Match :root { ... } blocks (handle nested braces is unlikely in :root)
  const rootBlocks = css.matchAll(/:root\s*\{([^}]+)\}/g);
  for (const match of rootBlocks) {
    const block = match[1];
    const propMatches = block.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g);
    for (const prop of propMatches) {
      vars[prop[1].trim()] = prop[2].trim();
    }
  }
  return vars;
}

/** Extract property values for a given CSS selector */
function extractSelectorProps(css: string, selector: string): Record<string, string> {
  const props: Record<string, string> = {};
  // Match selector { ... } — handle compound selectors
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the selector at the start of a rule (possibly in a comma-separated list)
  const regex = new RegExp(`(?:^|[},])\\s*(?:[^{]*,\\s*)?${escaped}\\s*(?:,[^{]*)?\\{([^}]+)\\}`, 'gm');
  for (const match of css.matchAll(regex)) {
    const block = match[1];
    const propMatches = block.matchAll(/([\w-]+)\s*:\s*([^;]+)/g);
    for (const prop of propMatches) {
      props[prop[1].trim()] = prop[2].trim();
    }
  }
  // Also try simple selector match
  const simpleRegex = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 'gm');
  for (const match of css.matchAll(simpleRegex)) {
    const block = match[1];
    const propMatches = block.matchAll(/([\w-]+)\s*:\s*([^;]+)/g);
    for (const prop of propMatches) {
      if (!props[prop[1].trim()]) {
        props[prop[1].trim()] = prop[2].trim();
      }
    }
  }
  return props;
}

/** Resolve var(--name) references against a set of CSS variables */
function resolveVar(value: string, vars: Record<string, string>): string {
  return value.replace(/var\((--[\w-]+)\)/g, (_, name) => vars[name] || _);
}

/** Parse a color string and determine relative luminance (0=black, 1=white) */
function luminance(color: string): number {
  // Handle hex colors
  const hex = color.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  // Handle rgb/rgba
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) {
    return 0.2126 * (+rgb[1] / 255) + 0.7152 * (+rgb[2] / 255) + 0.0722 * (+rgb[3] / 255);
  }
  return 0.5; // unknown — assume middle
}

/** Darken a hex color by a factor (0-1) */
function darken(color: string, amount: number): string {
  const hex = color.match(/^#([0-9a-fA-F]{6})$/);
  if (!hex) return color;
  const h = hex[1];
  const r = Math.max(0, Math.round(parseInt(h.substring(0, 2), 16) * (1 - amount)));
  const g = Math.max(0, Math.round(parseInt(h.substring(2, 4), 16) * (1 - amount)));
  const b = Math.max(0, Math.round(parseInt(h.substring(4, 6), 16) * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Lighten a hex color by a factor (0-1) */
function lighten(color: string, amount: number): string {
  const hex = color.match(/^#([0-9a-fA-F]{6})$/);
  if (!hex) return color;
  const h = hex[1];
  const r = Math.min(255, Math.round(parseInt(h.substring(0, 2), 16) + (255 - parseInt(h.substring(0, 2), 16)) * amount));
  const g = Math.min(255, Math.round(parseInt(h.substring(2, 4), 16) + (255 - parseInt(h.substring(2, 4), 16)) * amount));
  const b = Math.min(255, Math.round(parseInt(h.substring(4, 6), 16) + (255 - parseInt(h.substring(4, 6), 16)) * amount));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ── Main converter ───────────────────────────────────────────

export function convertTyporaTheme(css: string, themeName?: string): Theme {
  const rootVars = extractRootVars(css);
  const bodyProps = extractSelectorProps(css, 'body');
  const writeProps = extractSelectorProps(css, '#write');
  const h1Props = extractSelectorProps(css, 'h1');
  const aProps = extractSelectorProps(css, 'a');
  const codeProps = extractSelectorProps(css, 'code');
  const preProps = extractSelectorProps(css, 'pre');
  const bqProps = extractSelectorProps(css, 'blockquote');

  // Resolve var() references in extracted properties
  const resolve = (v: string) => resolveVar(v, rootVars);

  // ── Extract background color ──
  const bgRaw =
    rootVars['--bg-color'] ||
    rootVars['--body-color'] ||
    bodyProps['background-color'] ||
    bodyProps['background'] ||
    writeProps['background-color'] ||
    writeProps['background'];
  const bg = bgRaw ? resolve(bgRaw).split(/\s/)[0] : '#ffffff';

  // ── Extract text color ──
  const textRaw =
    rootVars['--text-color'] ||
    bodyProps['color'] ||
    writeProps['color'];
  const text = textRaw ? resolve(textRaw) : '#333333';

  // ── Detect dark/light ──
  const isDark = luminance(bg) < 0.4;

  // ── Extract sidebar / secondary background ──
  const bgSecondaryRaw = rootVars['--side-bar-bg-color'];
  const bgSecondary = bgSecondaryRaw
    ? resolve(bgSecondaryRaw)
    : isDark ? lighten(bg, 0.05) : darken(bg, 0.03);

  const bgTertiary = isDark ? lighten(bg, 0.1) : darken(bg, 0.06);

  // ── Extract accent / primary color ──
  const accentRaw =
    rootVars['--primary-color'] ||
    rootVars['--select-text-bg-color'] ||
    aProps['color'];
  const accent = accentRaw ? resolve(accentRaw) : (isDark ? '#7ba7c2' : '#5b7e9a');

  // ── Extract heading color ──
  const headingRaw = h1Props['color'];
  const headingColor = headingRaw
    ? resolve(headingRaw)
    : isDark ? lighten(text, 0.15) : darken(text, 0.15);

  // ── Extract link color ──
  const linkRaw = aProps['color'];
  const linkColor = linkRaw ? resolve(linkRaw) : accent;

  // ── Extract code background ──
  const codeRaw =
    codeProps['background-color'] ||
    codeProps['background'] ||
    preProps['background-color'] ||
    preProps['background'];
  const codeBg = codeRaw
    ? resolve(codeRaw).split(/\s/)[0]
    : isDark ? lighten(bg, 0.08) : darken(bg, 0.04);

  // ── Extract secondary text color ──
  const textSecondaryRaw = rootVars['--control-text-color'];
  const textSecondary = textSecondaryRaw
    ? resolve(textSecondaryRaw)
    : isDark ? '#808080' : '#8a8a8a';

  const textTertiary = isDark ? '#5a5a5a' : '#b0b0b0';

  // ── Extract border color ──
  const borderRaw =
    bqProps['border-left']?.match(/#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)/)?.[0] ||
    rootVars['--border-color'];
  const border = borderRaw
    ? resolve(borderRaw)
    : isDark ? lighten(bg, 0.12) : darken(bg, 0.1);
  const borderSubtle = isDark ? lighten(bg, 0.06) : darken(bg, 0.05);

  // ── Extract blockquote border ──
  const bqBorderRaw = bqProps['border-left']?.match(/#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)/)?.[0];
  const bqBorder = bqBorderRaw ? resolve(bqBorderRaw) : border;

  // ── Build theme name from CSS filename or detect from CSS ──
  const id = `typora-${Date.now()}`;
  const name = themeName || 'Imported Theme';

  return {
    id,
    name,
    dark: isDark,
    vars: {
      '--novelist-bg': bg,
      '--novelist-bg-secondary': bgSecondary,
      '--novelist-bg-tertiary': bgTertiary,
      '--novelist-text': text,
      '--novelist-text-secondary': textSecondary,
      '--novelist-text-tertiary': textTertiary,
      '--novelist-accent': accent,
      '--novelist-border': border,
      '--novelist-border-subtle': borderSubtle,
      '--novelist-heading-color': headingColor,
      '--novelist-link-color': linkColor,
      '--novelist-code-bg': codeBg,
      '--novelist-blockquote-border': bqBorder,
    },
  };
}
