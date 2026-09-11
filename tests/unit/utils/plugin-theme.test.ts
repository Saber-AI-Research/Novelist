import { describe, it, expect, afterEach } from 'vitest';
import { PLUGIN_THEME_VARS, collectPluginThemeVars } from '$lib/utils/plugin-theme';

/**
 * Plugin iframes get their look from the host through a single `theme-update`
 * message. The editor typography vars were missing from that payload, so the
 * literary-commentary editor stayed pinned at its own hard-coded column while
 * Settings → Editor → Width moved the main editor.
 */
describe('[contract] plugin theme forwarding', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('forwards the editor typography vars, not just the palette', () => {
    expect(PLUGIN_THEME_VARS).toContain('--novelist-editor-max-width');
    expect(PLUGIN_THEME_VARS).toContain('--novelist-editor-font');
    expect(PLUGIN_THEME_VARS).toContain('--novelist-editor-font-size');
    expect(PLUGIN_THEME_VARS).toContain('--novelist-editor-line-height');
  });

  it('reads the live values off the document root', () => {
    const root = document.documentElement;
    root.style.setProperty('--novelist-editor-max-width', '960px');
    root.style.setProperty('--novelist-editor-font-size', '19px');
    root.style.setProperty('--novelist-bg', '#101014');

    const vars = collectPluginThemeVars();
    expect(vars['--novelist-editor-max-width']).toBe('960px');
    expect(vars['--novelist-editor-font-size']).toBe('19px');
    expect(vars['--novelist-bg']).toBe('#101014');
  });

  it('emits an entry for every declared var so a plugin never sees a gap', () => {
    const vars = collectPluginThemeVars();
    expect(Object.keys(vars).sort()).toEqual([...PLUGIN_THEME_VARS].sort());
  });
});
