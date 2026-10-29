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
  createAttachmentFromContext,
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
    expect(parseSlashCommand('/plan outline the next scene')).toBeNull();
    expect(parseSlashCommand('/act now')).toBeNull();
  });

  it('maps slash commands to built-in writing instructions', () => {
    const cmd = parseSlashCommand('/summarize @current');
    expect(commandInstruction(cmd)).toContain('Summarize');
    expect(commandInstruction(parseSlashCommand('/compact next'))).toBeNull();
  });

  it('normalizes built-in command names to their canonical id', () => {
    const parsed = parseSlashCommand('/Compact keep the outline');

    expect(parsed).toEqual({ id: 'compact', raw: '/compact', rest: 'keep the outline' });
    expect(commandInstruction(parsed)).toBeNull();
  });

  it('rejects built-in names containing invisible format characters', () => {
    expect(parseSlashCommand('/compact\u200d keep the outline')).toBeNull();
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

  it('skips a mentioned file whose read fails instead of throwing', async () => {
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
      expect(read).toHaveBeenCalledTimes(1);
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

  it('maps manual-note asset items to skill and memory attachments', () => {
    const skill = createAttachmentFromContext({
      id: 'skill:skills/plot-doctor/SKILL.md',
      kind: 'manual-note',
      label: 'Skill: plot-doctor',
      path: '/项目甲/.novelist/ai/skills/plot-doctor/SKILL.md',
      content: '检查情节因果。',
    });
    const memory = createAttachmentFromContext({
      id: 'memory',
      kind: 'manual-note',
      label: 'Project memory',
      path: '/项目甲/.novelist/ai/memory.md',
      content: '语气笔记',
    });

    expect(skill.kind).toBe('skill');
    expect(skill.source).toBe('ai-assets');
    expect(memory.kind).toBe('memory');
    expect(memory.source).toBe('ai-assets');
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
