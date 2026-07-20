import { describe, it, expect } from 'vitest';
import {
  filterSlashCommands,
  filterMentionItems,
  MENTION_MENU_LIMIT,
  SLASH_MENU_COMMANDS,
} from '$lib/components/ai-shared/menu-items';
import type { AiContextAttachment } from '$lib/components/ai-shared/attachments';
import type { AiPromptAsset } from '$lib/components/ai-shared/persistence';

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

function projectCommand(project: string, name: string, content: string): AiPromptAsset {
  return {
    id: `commands/${name}.md`,
    kind: 'command',
    path: `${project}/.novelist/ai/commands/${name}.md`,
    name,
    content,
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

  it('includes loaded CJK project commands without replacing built-ins', () => {
    const commandA = projectCommand('/项目甲', '甲项目命令', '项目甲指令');
    const collision = projectCommand('/项目甲', 'plan', '不得替换内置 plan');
    const invisible = projectCommand('/项目甲', 'plan\u200d', '不得显示的欺骗命令');

    const all = filterSlashCommands('', [commandA, collision, invisible]);
    const matches = filterSlashCommands('甲项目', [commandA, collision]);

    expect(all.filter((item) => item.id === 'plan')).toHaveLength(1);
    expect(all.some((item) => item.id === invisible.name)).toBe(false);
    expect(matches).toEqual([{
      id: '甲项目命令',
      label: '/甲项目命令',
      hint: 'project command',
    }]);
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
