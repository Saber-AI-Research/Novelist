/**
 * CSS custom properties forwarded into plugin iframes on every `theme-update`.
 *
 * Colors keep plugin chrome in step with the host theme. The four
 * `--novelist-editor-*` vars are the user's Settings → Editor typography
 * (font, size, line-height and page width): plugins that render a document
 * body are part of the writing surface, so a width the user picked in
 * Settings has to reach them too — otherwise the literary-commentary editor
 * stays pinned at its own hard-coded column while the main editor moves.
 */
export const PLUGIN_THEME_VARS = [
  '--novelist-bg',
  '--novelist-bg-secondary',
  '--novelist-bg-tertiary',
  '--novelist-text',
  '--novelist-text-secondary',
  '--novelist-text-tertiary',
  '--novelist-accent',
  '--novelist-border',
  '--novelist-error',
  '--novelist-editor-font',
  '--novelist-editor-font-size',
  '--novelist-editor-line-height',
  '--novelist-editor-max-width',
] as const;

/** Read the forwarded vars off the host document root. */
export function collectPluginThemeVars(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const prop of PLUGIN_THEME_VARS) {
    vars[prop] = styles.getPropertyValue(prop);
  }
  return vars;
}
