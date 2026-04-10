import { describe, it, expect } from 'vitest';
import { convertTyporaTheme } from './typora-theme';

describe('convertTyporaTheme', () => {
  it('extracts background from :root --bg-color', () => {
    const css = `:root { --bg-color: #fafafa; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-bg']).toBe('#fafafa');
  });

  it('extracts text color from :root --text-color', () => {
    const css = `:root { --text-color: #333333; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-text']).toBe('#333333');
  });

  it('extracts accent from :root --primary-color', () => {
    const css = `:root { --primary-color: #0969da; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-accent']).toBe('#0969da');
  });

  it('extracts sidebar bg from --side-bar-bg-color', () => {
    const css = `:root { --side-bar-bg-color: #f0f0f0; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-bg-secondary']).toBe('#f0f0f0');
  });

  it('extracts body background-color from selector', () => {
    const css = `body { background-color: #1e1e1e; color: #d4d4d4; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-bg']).toBe('#1e1e1e');
    expect(theme.vars['--novelist-text']).toBe('#d4d4d4');
  });

  it('extracts heading color from h1 selector', () => {
    const css = `h1 { color: #111111; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-heading-color']).toBe('#111111');
  });

  it('extracts link color from a selector', () => {
    const css = `a { color: #4183c4; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-link-color']).toBe('#4183c4');
  });

  it('extracts code background from code selector', () => {
    const css = `code { background-color: #f0f0f0; }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-code-bg']).toBe('#f0f0f0');
  });

  it('detects dark theme by background luminance', () => {
    const css = `:root { --bg-color: #1e1e1e; }`;
    const theme = convertTyporaTheme(css, 'Dark Test');
    expect(theme.dark).toBe(true);
  });

  it('detects light theme by background luminance', () => {
    const css = `:root { --bg-color: #fafafa; }`;
    const theme = convertTyporaTheme(css, 'Light Test');
    expect(theme.dark).toBe(false);
  });

  it('resolves var() references', () => {
    const css = `:root { --primary-color: #0969da; }
    a { color: var(--primary-color); }`;
    const theme = convertTyporaTheme(css, 'Test');
    expect(theme.vars['--novelist-link-color']).toBe('#0969da');
  });

  it('sets theme name and id correctly', () => {
    const theme = convertTyporaTheme(':root {}', 'My Theme');
    expect(theme.name).toBe('My Theme');
    expect(theme.id).toMatch(/^typora-/);
  });

  it('produces all required Novelist CSS variables', () => {
    const theme = convertTyporaTheme(':root {}', 'Test');
    const requiredVars = [
      '--novelist-bg',
      '--novelist-bg-secondary',
      '--novelist-bg-tertiary',
      '--novelist-text',
      '--novelist-text-secondary',
      '--novelist-text-tertiary',
      '--novelist-accent',
      '--novelist-border',
      '--novelist-border-subtle',
      '--novelist-heading-color',
      '--novelist-link-color',
      '--novelist-code-bg',
      '--novelist-blockquote-border',
    ];
    for (const v of requiredVars) {
      expect(theme.vars).toHaveProperty(v);
      expect(theme.vars[v]).toBeTruthy();
    }
  });

  it('handles a full Typora theme CSS', () => {
    const css = `
:root {
  --bg-color: #fafafa;
  --text-color: #333333;
  --side-bar-bg-color: #f0f0f0;
  --control-text-color: #777777;
  --primary-color: #428bca;
}
body { background-color: var(--bg-color); color: var(--text-color); }
#write { max-width: 750px; }
h1, h2, h3 { color: #111111; }
a { color: var(--primary-color); }
blockquote { border-left: 4px solid #ddd; color: #666; }
code { background: #f5f5f5; }
    `;
    const theme = convertTyporaTheme(css, 'Full Theme');
    expect(theme.vars['--novelist-bg']).toBe('#fafafa');
    expect(theme.vars['--novelist-text']).toBe('#333333');
    expect(theme.vars['--novelist-bg-secondary']).toBe('#f0f0f0');
    expect(theme.vars['--novelist-accent']).toBe('#428bca');
    expect(theme.vars['--novelist-heading-color']).toBe('#111111');
    expect(theme.vars['--novelist-link-color']).toBe('#428bca');
    expect(theme.vars['--novelist-code-bg']).toBe('#f5f5f5');
    expect(theme.dark).toBe(false);
  });
});
