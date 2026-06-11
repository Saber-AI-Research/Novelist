import { describe, it, expect } from 'vitest';
import {
  filterSlashCommands,
  filterMentionItems,
  MENTION_MENU_LIMIT,
  SLASH_MENU_COMMANDS,
} from '$lib/components/ai-shared/menu-items';
import type { AiContextAttachment } from '$lib/components/ai-shared/attachments';

function fileCandidate(path: string, label: string): AiContextAttachment {
  return {
    id: `file:${path}`,
    kind: 'project-file',
    label,
    path,
    source: 'project',
    mode: 'full',
    content: '',
    estimatedChars: 0,
    truncated: false,
  };
}

describe('ai-shared menu-items — slash commands', () => {
  it('returns every command for an empty query', () => {
    expect(filterSlashCommands('')).toHaveLength(SLASH_MENU_COMMANDS.length);
  });

  it('filters by label substring, case-insensitive', () => {
    const ids = filterSlashCommands('RE').map((c) => c.id);
    expect(ids).toContain('rewrite');
    expect(ids).not.toContain('save');
  });

  it('returns empty for a query that matches nothing', () => {
    expect(filterSlashCommands('zzz')).toEqual([]);
  });
});

describe('ai-shared menu-items — mentions', () => {
  it('lists static mentions first for an empty query', () => {
    const items = filterMentionItems('');
    expect(items[0].token).toBe('@selection');
    expect(items.length).toBeLessThanOrEqual(MENTION_MENU_LIMIT);
  });

  it('includes matching dynamic candidates with @-prefixed tokens', () => {
    const items = filterMentionItems('第二章', [fileCandidate('book/第二章.md', '第二章.md')]);
    const dynamic = items.find((m) => m.attachment);
    expect(dynamic?.token).toBe('@file:book/第二章.md');
    expect(dynamic?.label).toBe('第二章.md');
  });

  it('caps the list at the menu limit', () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      fileCandidate(`chapter-${i}.md`, `chapter-${i}.md`),
    );
    expect(filterMentionItems('chapter', candidates)).toHaveLength(MENTION_MENU_LIMIT);
  });
});
