import type { TemplateInfo } from '$lib/ipc/commands';
import { t } from '$lib/i18n';

/**
 * Look up the display label for a template category. Built-in categories
 * (`general / fiction / non-fiction / personal / custom / literary-study`) resolve to their
 * i18n key `template.category.<cat>`; any unknown category falls through
 * to the raw category string so user-authored templates with custom
 * categories still render.
 */
export function categoryLabel(cat: string): string {
  const key = `template.category.${cat}`;
  const translated = t(key);
  return translated === key ? cat : translated;
}

/**
 * Display name for a template card. Built-in templates go through i18n
 * (`template.<id>.name`); user-authored templates (`builtin: false`) use
 * the `name` from their `template.toml` verbatim — those are single-
 * language by design. If an i18n key is missing, fall back to the
 * Rust-provided English string on the `TemplateInfo`.
 */
export function templateName(tpl: TemplateInfo): string {
  if (!tpl.builtin) return tpl.name;
  const key = `template.${tpl.id}.name`;
  const translated = t(key);
  return translated === key ? tpl.name : translated;
}

/**
 * Description text for a template. Same rules as `templateName` —
 * built-in goes through i18n, user-authored passes through.
 */
export function templateDescription(tpl: TemplateInfo): string {
  if (!tpl.builtin) return tpl.description;
  const key = `template.${tpl.id}.description`;
  const translated = t(key);
  return translated === key ? tpl.description : translated;
}
