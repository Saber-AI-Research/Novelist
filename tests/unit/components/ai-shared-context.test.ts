import { describe, expect, it, vi } from 'vitest';
import {
  buildContextPack,
  commandInstruction,
  contextPackToPrompt,
  parseMentions,
  parseSkillTokens,
  parseSlashCommand,
  resolveMentionContexts,
  skillAssetsForTokens,
  stripMentionTokens,
  stripSkillTokens,
  type AiContextItem,
} from '$lib/components/ai-shared/context';
import { commands } from '$lib/ipc/commands';
import { projectStore } from '$lib/stores/project.svelte';
import {
  attachmentToContextItem,
  buildPromptFromAttachments,
  createAttachmentFromContext,
  displayTextFromInput,
  searchAttachmentCandidates,
  type AiContextAttachment,
} from '$lib/components/ai-shared/attachments';

describe('[contract] AI shared context parsing', () => {
  it('parses supported mention tokens', () => {
    expect(parseMentions('Use @selection with @current and @file:chapter-1')).toEqual([
      { kind: 'selection', raw: '@selection' },
      { kind: 'current-file', raw: '@current' },
      { kind: 'project-file', raw: '@file:chapter-1', query: 'chapter-1' },
    ]);
  });

  it('parses a contiguous @file: token but drops one with a stray space', () => {
    // Composer inserts `@file:` without a trailing space so the user types the
    // path contiguously; this is the contract the menu insertion relies on.
    expect(parseMentions('See @file:book/第二章.md please')).toEqual([
      { kind: 'project-file', raw: '@file:book/第二章.md', query: 'book/第二章.md' },
    ]);
    // A space after the colon (the old trailing-space bug) yields no mention.
    expect(parseMentions('See @file: book/第二章.md')).toEqual([]);
  });

  it('strips mention and skill tokens from user text', () => {
    const text = 'Please /keep @current $plot-doctor tighten this';
    expect(stripMentionTokens(text)).toBe('Please /keep $plot-doctor tighten this');
    expect(stripSkillTokens(text)).toBe('Please /keep @current tighten this');
  });

  it('parses slash commands and leaves unknown commands alone', () => {
    expect(parseSlashCommand('/rewrite make it sharper')).toEqual({
      id: 'rewrite',
      raw: '/rewrite',
      rest: 'make it sharper',
    });
    expect(parseSlashCommand('/nope test')).toBeNull();
  });

  it('maps slash commands to built-in writing instructions', () => {
    const cmd = parseSlashCommand('/summarize @current');
    expect(commandInstruction(cmd)).toContain('Summarize');
    expect(commandInstruction(parseSlashCommand('/plan next'))).toBeNull();
  });

  it('parses a CJK project command and resolves its loaded instruction', () => {
    const projectCommand = {
      id: 'commands/甲项目命令.md',
      kind: 'command',
      path: '/项目甲/.novelist/ai/commands/甲项目命令.md',
      name: '甲项目命令',
      content: '只使用项目甲的命令指令。',
    };

    const parsed = parseSlashCommand('/甲项目命令 收紧第二章节奏', [projectCommand]);

    expect(parsed).toEqual({
      id: '甲项目命令',
      raw: '/甲项目命令',
      rest: '收紧第二章节奏',
      asset: projectCommand,
    });
    expect(commandInstruction(parsed)).toBe('只使用项目甲的命令指令。');
  });

  it('keeps built-in control commands ahead of colliding project commands', () => {
    const collidingCommand = {
      id: 'commands/Plan.md',
      kind: 'command',
      path: '/项目甲/.novelist/ai/commands/Plan.md',
      name: 'Plan',
      content: 'This project command must not replace the built-in control.',
    };

    const parsed = parseSlashCommand('/Plan outline the next scene', [collidingCommand]);

    expect(parsed).toEqual({ id: 'plan', raw: '/plan', rest: 'outline the next scene' });
    expect(commandInstruction(parsed)).toBeNull();
  });

  it('rejects project command names containing invisible format characters', () => {
    const deceptiveCommand = {
      id: 'commands/plan-hidden.md',
      kind: 'command',
      path: '/项目甲/.novelist/ai/commands/plan-hidden.md',
      name: 'plan\u200d',
      content: 'This deceptive command must not execute.',
    };

    expect(parseSlashCommand('/plan\u200d outline the next scene', [deceptiveCommand])).toBeNull();
  });

  it('resolves skill tokens against available prompt assets', () => {
    const assets = [
      { id: 'skills/plot-doctor/SKILL.md', kind: 'skill', path: '/p/SKILL.md', name: 'plot-doctor', content: 'plot' },
    ];
    expect(parseSkillTokens('$plot-doctor and $missing')).toEqual([
      { raw: '$plot-doctor', name: 'plot-doctor' },
      { raw: '$missing', name: 'missing' },
    ]);
    expect(skillAssetsForTokens(parseSkillTokens('$plot-doctor $missing'), assets)).toEqual([assets[0]]);
  });

  it('keeps shared resolution tolerant while strict Agent resolution rejects a typed read failure', async () => {
    const previousFiles = projectStore.files;
    projectStore.files = [{
      name: '第一章.md',
      path: '/project/第一章.md',
      is_dir: false,
      size: 120,
      expanded: false,
      loading: false,
      mtime: 1,
      ctime: 1,
    }];
    const read = vi.spyOn(commands, 'readFile').mockResolvedValue({
      status: 'error',
      error: '读取失败 Authorization: Bearer CONTEXT_SECRET',
    });

    try {
      await expect(resolveMentionContexts('@file:第一章 请继续')).resolves.toEqual([]);
      await expect(resolveMentionContexts(
        '@file:第一章 请继续',
        { rejectFileReadError: true },
      )).rejects.toThrow('读取失败');
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      projectStore.files = previousFiles;
    }
  });
});

describe('[contract] AI context packs', () => {
  it('dedupes and truncates context items within the character budget', () => {
    const items: AiContextItem[] = [
      { id: 'a', kind: 'current-file', label: 'A', path: '/a.md', content: 'a'.repeat(30) },
      { id: 'a-copy', kind: 'current-file', label: 'A copy', path: '/a.md', content: 'duplicate' },
      { id: 'b', kind: 'manual-note', label: 'B', content: 'b'.repeat(50) },
    ];
    const pack = buildContextPack('ask', items, 40);
    expect(pack.items).toHaveLength(2);
    expect(pack.items[0].content).toBe('a'.repeat(30));
    expect(pack.items[1].truncated).toBe(true);
    expect(pack.estimatedChars).toBeGreaterThanOrEqual(40);
  });

  it('renders context packs as a prompt with labels and paths', () => {
    const prompt = contextPackToPrompt({
      userText: 'help',
      estimatedChars: 4,
      items: [{ id: 'x', kind: 'selection', label: 'Selection', path: '/x.md', content: 'text' }],
    });
    expect(prompt).toContain('## Context 1: Selection');
    expect(prompt).toContain('Path: /x.md');
    expect(prompt).toContain('## User request\nhelp');
  });
});

describe('[contract] AI context attachments', () => {
  const base: AiContextAttachment[] = [
    {
      id: 'file:/project/Chapter 1.md',
      kind: 'project-file',
      label: 'Chapter 1.md',
      path: '/project/Chapter 1.md',
      source: 'project',
      mode: 'full',
      content: '# Chapter 1\n\nOpening text',
      estimatedChars: 24,
      truncated: false,
    },
    {
      id: 'memory',
      kind: 'memory',
      label: 'Project memory',
      path: '/project/.novelist/ai/memory.md',
      source: 'ai-assets',
      mode: 'summary',
      content: 'Tone notes',
      estimatedChars: 10,
      truncated: false,
    },
  ];

  it('searches attachment candidates by label and path', () => {
    expect(searchAttachmentCandidates(base, 'chap').map((x) => x.id)).toEqual(['file:/project/Chapter 1.md']);
    expect(searchAttachmentCandidates(base, 'memory').map((x) => x.id)).toEqual(['memory']);
  });

  it('builds outbound prompt without replacing visible text', () => {
    const packed = buildPromptFromAttachments('summarize this', base, 2000);
    expect(packed.visibleText).toBe('summarize this');
    expect(packed.outboundText).toContain('## Context 1: Chapter 1.md');
    expect(packed.outboundText).toContain('## User request\nsummarize this');
  });

  it('strips mention and skill tokens only for display text when requested', () => {
    expect(displayTextFromInput('@current $plot-doctor summarize this')).toBe('summarize this');
  });

  it('round-trips legacy context items through attachments', () => {
    const attachment = createAttachmentFromContext({
      id: 'selection',
      kind: 'selection',
      label: 'Selection',
      path: '/project/a.md',
      content: 'selected text',
    });
    expect(attachment.source).toBe('editor');
    expect(attachmentToContextItem(attachment)).toMatchObject({
      id: 'selection',
      kind: 'selection',
      label: 'Selection',
      content: 'selected text',
    });
  });

  it('preserves project commands as command attachments', () => {
    const attachment = createAttachmentFromContext({
      id: 'command:commands/甲项目命令.md',
      kind: 'manual-note',
      label: 'Command: 甲项目命令',
      path: '/项目甲/.novelist/ai/commands/甲项目命令.md',
      content: '只使用项目甲的命令指令。',
    });

    expect(attachment.kind).toBe('command');
    expect(attachment.source).toBe('ai-assets');
  });

  it('ranks label prefix matches before path-only matches', () => {
    const candidates: AiContextAttachment[] = [
      {
        id: 'file:/project/Notes/outline.md',
        kind: 'project-file',
        label: 'outline.md',
        path: '/project/Chapter notes/outline.md',
        source: 'project',
        mode: 'full',
        content: 'outline',
        estimatedChars: 7,
        truncated: false,
      },
      {
        id: 'file:/project/Chapter 1.md',
        kind: 'project-file',
        label: 'Chapter 1.md',
        path: '/project/Chapter 1.md',
        source: 'project',
        mode: 'full',
        content: 'chapter',
        estimatedChars: 7,
        truncated: false,
      },
    ];
    expect(searchAttachmentCandidates(candidates, 'chap').map((x) => x.label)).toEqual([
      'Chapter 1.md',
      'outline.md',
    ]);
  });
});
