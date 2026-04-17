/**
 * Novelist Theme System
 *
 * Inspired by Typora / mweb pro — each theme is a set of CSS variable overrides.
 * The active theme is applied by setting CSS variables on :root.
 * "system" follows prefers-color-scheme and maps to light/dark automatically.
 */

export interface Theme {
  id: string;
  name: string;
  /** Whether this is a dark theme (for editor chrome decisions) */
  dark: boolean;
  vars: Record<string, string>;
}

export const builtinThemes: Theme[] = [
  {
    id: 'light',
    name: 'Light',
    dark: false,
    vars: {
      '--novelist-bg': '#fcfcfa',
      '--novelist-bg-secondary': '#f4f3ef',
      '--novelist-bg-tertiary': '#eae8e3',
      '--novelist-text': '#2c2c2c',
      '--novelist-text-secondary': '#8a8a8a',
      '--novelist-text-tertiary': '#b0b0b0',
      '--novelist-accent': '#5b7e9a',
      '--novelist-border': '#e8e6e1',
      '--novelist-border-subtle': '#f0eeea',
      '--novelist-heading-color': '#1a1a1a',
      '--novelist-link-color': '#5b7e9a',
      '--novelist-code-bg': '#f0eeea',
      '--novelist-blockquote-border': '#d0cec8',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    dark: true,
    vars: {
      '--novelist-bg': '#1c1c1e',
      '--novelist-bg-secondary': '#232326',
      '--novelist-bg-tertiary': '#2c2c2f',
      '--novelist-text': '#d4d4d4',
      '--novelist-text-secondary': '#808080',
      '--novelist-text-tertiary': '#5a5a5a',
      '--novelist-accent': '#7ba7c2',
      '--novelist-border': '#2e2e31',
      '--novelist-border-subtle': '#272729',
      '--novelist-heading-color': '#e8e8e8',
      '--novelist-link-color': '#7ba7c2',
      '--novelist-code-bg': '#28282b',
      '--novelist-blockquote-border': '#3e3e42',
    },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    dark: false,
    vars: {
      '--novelist-bg': '#f5f0e8',
      '--novelist-bg-secondary': '#ebe5d9',
      '--novelist-bg-tertiary': '#dfd8ca',
      '--novelist-text': '#3b3228',
      '--novelist-text-secondary': '#8c7e6e',
      '--novelist-text-tertiary': '#b3a694',
      '--novelist-accent': '#8b6914',
      '--novelist-border': '#d8d0c0',
      '--novelist-border-subtle': '#e8e0d2',
      '--novelist-heading-color': '#2a2118',
      '--novelist-link-color': '#7a5c1f',
      '--novelist-code-bg': '#ebe4d4',
      '--novelist-blockquote-border': '#c8bfa8',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    vars: {
      '--novelist-bg': '#2e3440',
      '--novelist-bg-secondary': '#3b4252',
      '--novelist-bg-tertiary': '#434c5e',
      '--novelist-text': '#d8dee9',
      '--novelist-text-secondary': '#7b88a1',
      '--novelist-text-tertiary': '#4c566a',
      '--novelist-accent': '#88c0d0',
      '--novelist-border': '#3b4252',
      '--novelist-border-subtle': '#353c4a',
      '--novelist-heading-color': '#eceff4',
      '--novelist-link-color': '#88c0d0',
      '--novelist-code-bg': '#3b4252',
      '--novelist-blockquote-border': '#4c566a',
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    dark: false,
    vars: {
      '--novelist-bg': '#ffffff',
      '--novelist-bg-secondary': '#f6f8fa',
      '--novelist-bg-tertiary': '#eef1f5',
      '--novelist-text': '#1f2328',
      '--novelist-text-secondary': '#656d76',
      '--novelist-text-tertiary': '#8b949e',
      '--novelist-accent': '#0969da',
      '--novelist-border': '#d0d7de',
      '--novelist-border-subtle': '#e8ecf0',
      '--novelist-heading-color': '#1f2328',
      '--novelist-link-color': '#0969da',
      '--novelist-code-bg': '#f6f8fa',
      '--novelist-blockquote-border': '#d0d7de',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    vars: {
      '--novelist-bg': '#282a36',
      '--novelist-bg-secondary': '#21222c',
      '--novelist-bg-tertiary': '#343746',
      '--novelist-text': '#f8f8f2',
      '--novelist-text-secondary': '#7a7c93',
      '--novelist-text-tertiary': '#545669',
      '--novelist-accent': '#bd93f9',
      '--novelist-border': '#343746',
      '--novelist-border-subtle': '#2e303e',
      '--novelist-heading-color': '#f8f8f2',
      '--novelist-link-color': '#8be9fd',
      '--novelist-code-bg': '#21222c',
      '--novelist-blockquote-border': '#44475a',
    },
  },
];

const THEME_KEY = 'novelist-theme';
const CUSTOM_THEMES_KEY = 'novelist-custom-themes';

export function loadThemeId(): string {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function saveThemeId(id: string) {
  localStorage.setItem(THEME_KEY, id);
}

/** Load custom (imported) themes from localStorage. */
export function loadCustomThemes(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

/** Save custom themes to localStorage. */
function saveCustomThemes(themes: Theme[]) {
  localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(themes));
}

/** Add an imported theme. Returns the theme (with potentially deduplicated id). */
export function addCustomTheme(theme: Theme): Theme {
  const customs = loadCustomThemes();
  customs.push(theme);
  saveCustomThemes(customs);
  return theme;
}

/** Remove a custom theme by id. */
export function removeCustomTheme(id: string) {
  const customs = loadCustomThemes().filter(t => t.id !== id);
  saveCustomThemes(customs);
}

/** Get all themes (builtin + custom). */
export function getAllThemes(): Theme[] {
  return [...builtinThemes, ...loadCustomThemes()];
}

export function getThemeById(id: string): Theme | undefined {
  return builtinThemes.find(t => t.id === id) || loadCustomThemes().find(t => t.id === id);
}

/**
 * Resolve "system" to actual light/dark theme.
 */
export function resolveTheme(id: string): Theme {
  if (id === 'system') {
    const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? builtinThemes[1] : builtinThemes[0];
  }
  return getThemeById(id) || loadCustomThemes().find(t => t.id === id) || builtinThemes[0];
}

/**
 * Apply theme CSS variables to :root.
 */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  // Derived variables that use color-mix
  root.style.setProperty('--novelist-accent-soft', `color-mix(in srgb, ${theme.vars['--novelist-accent']} 10%, transparent)`);
  root.style.setProperty('--novelist-sidebar-bg', theme.vars['--novelist-bg-secondary']);
  root.style.setProperty('--novelist-sidebar-text', theme.vars['--novelist-text']);
  root.style.setProperty('--novelist-sidebar-hover', `color-mix(in srgb, ${theme.vars['--novelist-accent']} 8%, ${theme.vars['--novelist-bg-secondary']})`);
  root.style.setProperty('--novelist-sidebar-active', `color-mix(in srgb, ${theme.vars['--novelist-accent']} 14%, ${theme.vars['--novelist-bg-secondary']})`);
  root.style.setProperty('--novelist-editor-bg', theme.vars['--novelist-bg']);

  // Set color-scheme for scrollbar theming
  root.style.setProperty('color-scheme', theme.dark ? 'dark' : 'light');
}

/**
 * Generate CSS string for HTML export with a specific theme.
 */
export function themeToCSS(theme: Theme): string {
  const lines = [':root {'];
  for (const [key, value] of Object.entries(theme.vars)) {
    lines.push(`  ${key}: ${value};`);
  }
  lines.push('}');
  return lines.join('\n');
}
