import { describe, it, expect } from 'vitest';
import { builtinThemes, getThemeById, themeToCSS, type Theme } from '$lib/themes';

describe('builtinThemes', () => {
  it('has at least light and dark themes', () => {
    const ids = builtinThemes.map(t => t.id);
    expect(ids).toContain('light');
    expect(ids).toContain('dark');
  });

  it('light theme is not dark', () => {
    const light = builtinThemes.find(t => t.id === 'light')!;
    expect(light.dark).toBe(false);
  });

  it('dark theme is dark', () => {
    const dark = builtinThemes.find(t => t.id === 'dark')!;
    expect(dark.dark).toBe(true);
  });

  it('all themes have required CSS variables', () => {
    const requiredVars = [
      '--novelist-bg',
      '--novelist-text',
      '--novelist-accent',
      '--novelist-border',
    ];
    for (const theme of builtinThemes) {
      for (const v of requiredVars) {
        expect(theme.vars[v], `${theme.id} missing ${v}`).toBeDefined();
      }
    }
  });

  it('all themes have unique IDs', () => {
    const ids = builtinThemes.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all themes have a name', () => {
    for (const theme of builtinThemes) {
      expect(theme.name.length).toBeGreaterThan(0);
    }
  });

  it('includes sepia, nord, github, dracula', () => {
    const ids = builtinThemes.map(t => t.id);
    expect(ids).toContain('sepia');
    expect(ids).toContain('nord');
    expect(ids).toContain('github');
    expect(ids).toContain('dracula');
  });
});

describe('getThemeById', () => {
  it('returns theme for valid id', () => {
    const theme = getThemeById('light');
    expect(theme).toBeDefined();
    expect(theme!.id).toBe('light');
  });

  it('returns undefined for unknown id', () => {
    expect(getThemeById('nonexistent')).toBeUndefined();
  });

  it('returns correct theme data', () => {
    const dark = getThemeById('dark')!;
    expect(dark.dark).toBe(true);
    expect(dark.name).toBe('Dark');
  });
});

describe('themeToCSS', () => {
  it('generates valid CSS with :root selector', () => {
    const theme: Theme = {
      id: 'test',
      name: 'Test',
      dark: false,
      vars: {
        '--novelist-bg': '#ffffff',
        '--novelist-text': '#000000',
      },
    };
    const css = themeToCSS(theme);
    expect(css).toContain(':root {');
    expect(css).toContain('--novelist-bg: #ffffff;');
    expect(css).toContain('--novelist-text: #000000;');
    expect(css).toContain('}');
  });

  it('includes all variables from theme', () => {
    const light = builtinThemes[0];
    const css = themeToCSS(light);
    for (const key of Object.keys(light.vars)) {
      expect(css).toContain(key);
    }
  });
});
