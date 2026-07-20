import { commands } from '$lib/ipc/commands';
import { projectStore, type FileNode } from '$lib/stores/project.svelte';
import { tabsStore, getEditorView } from '$lib/stores/tabs.svelte';
import type { AiPromptAsset } from './persistence';

export type AiContextKind =
  | 'selection'
  | 'current-file'
  | 'open-tab'
  | 'project-file'
  | 'folder-summary'
  | 'outline'
  | 'manual-note';

export type AiContextItem = {
  id: string;
  kind: AiContextKind;
  label: string;
  path?: string;
  content: string;
  truncated?: boolean;
};

export type AiContextPack = {
  userText: string;
  items: AiContextItem[];
  estimatedChars: number;
};

export type MentionContextResolutionOptions = {
  rejectFileReadError?: boolean;
};

export type MentionToken =
  | { kind: 'selection'; raw: string }
  | { kind: 'current-file'; raw: string }
  | { kind: 'outline'; raw: string }
  | { kind: 'project-file'; raw: string; query: string }
  | { kind: 'folder-summary'; raw: string; query: string };

export type SlashCommandId =
  | 'rewrite'
  | 'summarize'
  | 'continue'
  | 'translate'
  | 'line-edit'
  | 'brainstorm'
  | 'compact'
  | 'clear'
  | 'save'
  | 'plan'
  | 'act';

export type ParsedSlashCommand = {
  id: string;
  raw: string;
  rest: string;
  asset?: AiPromptAsset;
};

export type SkillToken = {
  raw: string;
  name: string;
};

export const CONTEXT_CHAR_LIMIT = 60_000;

const SUPPORTED_CONTEXT_EXTENSIONS = new Set(['.md', '.txt', '.canvas', '.kanban']);

const SLASH_COMMANDS = new Set<SlashCommandId>([
  'rewrite',
  'summarize',
  'continue',
  'translate',
  'line-edit',
  'brainstorm',
  'compact',
  'clear',
  'save',
  'plan',
  'act',
]);

export const BUILTIN_AI_COMMANDS: Record<string, string> = {
  rewrite: 'Rewrite the attached text according to the user instruction. Return polished prose and avoid commentary unless asked.',
  summarize: 'Summarize the attached material. Preserve names, chronology, causality, and unresolved questions.',
  continue: 'Continue the attached prose in the same voice and point of view. Return only continuation text.',
  translate: 'Translate the attached material faithfully while preserving literary tone and rhythm.',
  'line-edit': 'Line edit the attached prose for clarity, rhythm, diction, and continuity. Prefer concrete edits.',
  brainstorm: 'Generate distinct creative options. Favor concrete story choices over abstract advice.',
};

export const BUILTIN_SKILLS: AiPromptAsset[] = [
  {
    id: 'builtin/line-editor',
    kind: 'skill',
    path: 'builtin',
    name: 'line-editor',
    content:
      '# Line Editor\n\nAct as a rigorous literary line editor. Preserve the author voice, point out rhythm issues, and offer direct replacement examples.',
  },
  {
    id: 'builtin/plot-doctor',
    kind: 'skill',
    path: 'builtin',
    name: 'plot-doctor',
    content:
      '# Plot Doctor\n\nAnalyze plot logic, stakes, causality, pacing, and character motivation. Return specific fixes and tradeoffs.',
  },
];

function truncateContent(content: string, limit: number): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  return {
    content: `${content.slice(0, limit)}\n\n[...truncated ${content.length - limit} chars...]`,
    truncated: true,
  };
}

function extension(path: string): string {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx).toLowerCase() : '';
}

function flattenNodes(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const visit = (n: FileNode) => {
    out.push(n);
    n.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

function activeDoc(): { path: string | null; content: string; from: number; to: number; text: string } | null {
  const tab = tabsStore.activeTab;
  if (!tab) return null;
  const view = getEditorView(tab.id);
  const content = view?.state.doc.toString() ?? tab.content ?? '';
  const sel = view?.state.selection.main;
  const from = sel?.from ?? tab.cursorPosition ?? 0;
  const to = sel?.to ?? from;
  return { path: tab.filePath, content, from, to, text: content.slice(from, to) };
}

export function getSelectionContext(): AiContextItem | null {
  const doc = activeDoc();
  if (!doc || !doc.text.trim()) return null;
  const clipped = truncateContent(doc.text, 12_000);
  return {
    id: 'selection',
    kind: 'selection',
    label: `Selection (${doc.text.length} chars)`,
    path: doc.path ?? undefined,
    content: clipped.content,
    truncated: clipped.truncated,
  };
}

export function getCurrentFileContext(): AiContextItem | null {
  const doc = activeDoc();
  if (!doc || !doc.content.trim()) return null;
  const clipped = truncateContent(doc.content, 24_000);
  return {
    id: `current:${doc.path ?? 'untitled'}`,
    kind: 'current-file',
    label: doc.path ? `Current file: ${doc.path.split('/').pop()}` : 'Current file',
    path: doc.path ?? undefined,
    content: clipped.content,
    truncated: clipped.truncated,
  };
}

export function getOutlineContext(): AiContextItem | null {
  const doc = activeDoc();
  if (!doc || !doc.content.trim()) return null;
  const headings = doc.content
    .split('\n')
    .map((line) => /^(#{1,6})\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((m) => ({ level: m![1].length, text: m![2].trim() }));
  if (headings.length === 0) return null;
  return {
    id: `outline:${doc.path ?? 'untitled'}`,
    kind: 'outline',
    label: 'Current outline',
    path: doc.path ?? undefined,
    content: headings.map((h) => `${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`).join('\n'),
  };
}

export function getOpenTabContexts(): AiContextItem[] {
  const activeId = tabsStore.activeTabId;
  return tabsStore.panes.flatMap((pane) =>
    pane.tabs
      .filter((tab) => tab.id !== activeId && tab.content.trim())
      .map((tab) => {
        const clipped = truncateContent(tab.content, 8_000);
        return {
          id: `tab:${tab.id}`,
          kind: 'open-tab' as const,
          label: `Open tab: ${tab.fileName}`,
          path: tab.filePath,
          content: clipped.content,
          truncated: clipped.truncated,
        };
      }),
  );
}

export function parseMentions(input: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  const re = /(^|\s)@(selection|current|outline|file:[^\s]+|folder:[^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const raw = `@${m[2]}`;
    if (raw === '@selection') tokens.push({ kind: 'selection', raw });
    else if (raw === '@current') tokens.push({ kind: 'current-file', raw });
    else if (raw === '@outline') tokens.push({ kind: 'outline', raw });
    else if (raw.startsWith('@file:')) {
      tokens.push({ kind: 'project-file', raw, query: raw.slice('@file:'.length) });
    } else if (raw.startsWith('@folder:')) {
      tokens.push({ kind: 'folder-summary', raw, query: raw.slice('@folder:'.length) });
    }
  }
  return tokens;
}

export function stripMentionTokens(input: string): string {
  return input.replace(/(^|\s)@(selection|current|outline|file:[^\s]+|folder:[^\s]+)/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeSlashCommandName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function isInvocableProjectCommandName(name: string): boolean {
  return name.length > 0
    && name.trim() === name
    && !/[\s/\\\p{Cc}\p{Cf}\p{Cs}]/u.test(name);
}

export function isBuiltinSlashCommandName(name: string): boolean {
  return SLASH_COMMANDS.has(normalizeSlashCommandName(name) as SlashCommandId);
}

export function parseSlashCommand(
  input: string,
  projectCommands: readonly AiPromptAsset[] = [],
): ParsedSlashCommand | null {
  const trimmed = input.trimStart();
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const name = m[1];
  const normalizedName = normalizeSlashCommandName(name);
  const builtinId = normalizedName as SlashCommandId;
  if (isBuiltinSlashCommandName(name)) {
    return { id: builtinId, raw: `/${builtinId}`, rest: m[2] ?? '' };
  }
  if (!isInvocableProjectCommandName(name)) return null;
  const asset = projectCommands.find((candidate) =>
    isInvocableProjectCommandName(candidate.name)
      && normalizeSlashCommandName(candidate.name) === normalizedName,
  );
  if (!asset) return null;
  return { id: asset.name, raw: `/${asset.name}`, rest: m[2] ?? '', asset };
}

export function parseSkillTokens(input: string): SkillToken[] {
  const tokens: SkillToken[] = [];
  const re = /(^|\s)\$([a-zA-Z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    tokens.push({ raw: `$${m[2]}`, name: m[2] });
  }
  return tokens;
}

export function stripSkillTokens(input: string): string {
  return input.replace(/(^|\s)\$([a-zA-Z0-9_-]+)/g, ' ').replace(/\s+/g, ' ').trim();
}

function findNodesByQuery(query: string): FileNode[] {
  const q = query.toLowerCase();
  return flattenNodes(projectStore.files).filter((n) => {
    if (!q) return false;
    return n.path.toLowerCase().includes(q) || n.name.toLowerCase().includes(q);
  });
}

export async function resolveProjectFileContext(
  query: string,
  options: MentionContextResolutionOptions = {},
): Promise<AiContextItem | null> {
  const match = findNodesByQuery(query).find((n) => !n.is_dir && SUPPORTED_CONTEXT_EXTENSIONS.has(extension(n.path)));
  if (!match) return null;
  const result = await commands.readFile(match.path);
  if (result.status === 'error') {
    if (options.rejectFileReadError) throw new Error(String(result.error));
    return null;
  }
  const clipped = truncateContent(result.data, 18_000);
  return {
    id: `file:${match.path}`,
    kind: 'project-file',
    label: `File: ${match.name}`,
    path: match.path,
    content: clipped.content,
    truncated: clipped.truncated,
  };
}

export async function resolveFolderSummaryContext(query: string): Promise<AiContextItem | null> {
  const folder = findNodesByQuery(query).find((n) => n.is_dir);
  if (!folder) return null;
  const prefix = folder.path.endsWith('/') ? folder.path : `${folder.path}/`;
  const children = flattenNodes(projectStore.files)
    .filter((n) => !n.is_dir && n.path.startsWith(prefix) && SUPPORTED_CONTEXT_EXTENSIONS.has(extension(n.path)))
    .slice(0, 40);
  const content = children.map((n) => `- ${n.path.slice(prefix.length)} (${n.size ?? 0} bytes)`).join('\n');
  return {
    id: `folder:${folder.path}`,
    kind: 'folder-summary',
    label: `Folder: ${folder.name}`,
    path: folder.path,
    content: content || '(No loaded supported files in this folder.)',
  };
}

export async function resolveMentionContexts(
  input: string,
  options: MentionContextResolutionOptions = {},
): Promise<AiContextItem[]> {
  const out: AiContextItem[] = [];
  for (const token of parseMentions(input)) {
    if (token.kind === 'selection') {
      const item = getSelectionContext();
      if (item) out.push(item);
    } else if (token.kind === 'current-file') {
      const item = getCurrentFileContext();
      if (item) out.push(item);
    } else if (token.kind === 'outline') {
      const item = getOutlineContext();
      if (item) out.push(item);
    } else if (token.kind === 'project-file') {
      const item = await resolveProjectFileContext(token.query, options);
      if (item) out.push(item);
    } else if (token.kind === 'folder-summary') {
      const item = await resolveFolderSummaryContext(token.query);
      if (item) out.push(item);
    }
  }
  return dedupeContextItems(out);
}

export function dedupeContextItems(items: AiContextItem[]): AiContextItem[] {
  const seen = new Set<string>();
  const out: AiContextItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.path ?? item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function buildContextPack(userText: string, items: AiContextItem[], limit = CONTEXT_CHAR_LIMIT): AiContextPack {
  const packed: AiContextItem[] = [];
  let used = userText.length;
  for (const item of dedupeContextItems(items)) {
    const remaining = Math.max(0, limit - used);
    if (remaining <= 0) break;
    const clipped = truncateContent(item.content, remaining);
    packed.push({ ...item, content: clipped.content, truncated: item.truncated || clipped.truncated });
    used += clipped.content.length;
  }
  return {
    userText,
    items: packed,
    estimatedChars: used,
  };
}

export function contextPackToPrompt(pack: AiContextPack): string {
  if (pack.items.length === 0) return pack.userText;
  const sections = pack.items.map((item, idx) => {
    const path = item.path ? `\nPath: ${item.path}` : '';
    const truncated = item.truncated ? '\nNote: content was truncated.' : '';
    return `## Context ${idx + 1}: ${item.label}\nKind: ${item.kind}${path}${truncated}\n\n${item.content}`;
  });
  return `${sections.join('\n\n')}\n\n## User request\n${pack.userText}`;
}

export function skillAssetsForTokens(tokens: SkillToken[], assets: AiPromptAsset[]): AiPromptAsset[] {
  const lower = new Map(assets.map((asset) => [asset.name.toLowerCase(), asset]));
  return tokens.map((token) => lower.get(token.name.toLowerCase())).filter(Boolean) as AiPromptAsset[];
}

export function commandInstruction(command: ParsedSlashCommand | null): string | null {
  if (!command) return null;
  if (command.asset) return command.asset.content;
  return BUILTIN_AI_COMMANDS[command.id] ?? null;
}
