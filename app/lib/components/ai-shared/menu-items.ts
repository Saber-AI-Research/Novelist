/**
 * Pure data + filtering for the composer's `/` command and `@` mention
 * popup menus. Lives outside the .svelte components so AiComposer can own
 * keyboard selection (ArrowUp/Down + Tab/Enter) over the same filtered
 * lists the menus render, and so the filtering is unit-testable.
 */

import type { AiContextAttachment } from './attachments';
import { searchAttachmentCandidates } from './attachments';
import {
  isInvocableProjectCommandName,
  normalizeSlashCommandName,
  type SlashCommandId,
} from './context';
import type { AiPromptAsset } from './persistence';

export type SlashMenuItem = { id: string; label: string; hint: string };

export const SLASH_MENU_COMMANDS: SlashMenuItem[] = [
  { id: 'rewrite', label: '/rewrite', hint: 'rewrite selected or attached prose' },
  { id: 'summarize', label: '/summarize', hint: 'summarize attached context' },
  { id: 'continue', label: '/continue', hint: 'continue in the same voice' },
  { id: 'translate', label: '/translate', hint: 'translate literary prose' },
  { id: 'line-edit', label: '/line-edit', hint: 'line edit with concrete changes' },
  { id: 'brainstorm', label: '/brainstorm', hint: 'generate story options' },
  { id: 'compact', label: '/compact', hint: 'compress conversation' },
  { id: 'clear', label: '/clear', hint: 'reset current session' },
  { id: 'save', label: '/save', hint: 'save transcript to project' },
  { id: 'plan', label: '/plan', hint: 'switch agent to plan mode' },
  { id: 'act', label: '/act', hint: 'switch agent to act mode' },
];

export function filterSlashCommands(
  query: string,
  projectCommands: readonly AiPromptAsset[] = [],
): SlashMenuItem[] {
  const q = normalizeSlashCommandName(query);
  const seen = new Set(SLASH_MENU_COMMANDS.map((command) => normalizeSlashCommandName(command.id)));
  const dynamic: SlashMenuItem[] = [];
  for (const asset of projectCommands) {
    const key = normalizeSlashCommandName(asset.name);
    if (!isInvocableProjectCommandName(asset.name) || seen.has(key)) continue;
    seen.add(key);
    dynamic.push({ id: asset.name, label: `/${asset.name}`, hint: 'project command' });
  }
  return [...SLASH_MENU_COMMANDS, ...dynamic]
    .filter((command) => normalizeSlashCommandName(`${command.label} ${command.hint}`).includes(q));
}

export type MentionMenuItem = {
  token: string;
  label: string;
  hint: string;
  attachment?: AiContextAttachment;
};

const STATIC_MENTIONS: MentionMenuItem[] = [
  { token: '@selection', label: '@selection', hint: 'selected editor text' },
  { token: '@current', label: '@current', hint: 'current file contents' },
  { token: '@outline', label: '@outline', hint: 'current file heading outline' },
  { token: '@file:', label: '@file:path', hint: 'attach first matching file' },
  { token: '@folder:', label: '@folder:path', hint: 'attach folder summary' },
];

export const MENTION_MENU_LIMIT = 8;

export function filterMentionItems(
  query: string,
  candidates: readonly AiContextAttachment[] = [],
): MentionMenuItem[] {
  const q = query.toLowerCase();
  const dynamic = searchAttachmentCandidates(candidates, query).map((item) => ({
    token: `@${item.id}`,
    label: item.label,
    hint: item.path ?? item.kind,
    attachment: item,
  }));
  return [
    ...STATIC_MENTIONS.filter((m) => `${m.label} ${m.hint}`.toLowerCase().includes(q)),
    ...dynamic,
  ].slice(0, MENTION_MENU_LIMIT);
}
