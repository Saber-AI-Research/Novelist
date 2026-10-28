import type { AiContextItem, AiContextKind } from './context';

export type AiContextAttachmentKind =
  | 'selection'
  | 'current-file'
  | 'outline'
  | 'open-tab'
  | 'project-file'
  | 'folder-summary'
  | 'memory'
  | 'skill'
  | 'session';

export type AiContextAttachment = {
  id: string;
  kind: AiContextAttachmentKind;
  label: string;
  path?: string;
  source: 'editor' | 'project' | 'ai-assets' | 'session';
  mode: 'full' | 'excerpt' | 'outline' | 'summary';
  content: string;
  estimatedChars: number;
  truncated: boolean;
};

const EDITOR_KINDS = new Set<AiContextAttachmentKind>(['selection', 'current-file', 'outline', 'open-tab']);
const ASSET_KINDS = new Set<AiContextAttachmentKind>(['memory', 'skill']);

function sourceForKind(kind: AiContextAttachmentKind): AiContextAttachment['source'] {
  if (EDITOR_KINDS.has(kind)) return 'editor';
  if (ASSET_KINDS.has(kind)) return 'ai-assets';
  if (kind === 'session') return 'session';
  return 'project';
}

function modeForKind(kind: AiContextAttachmentKind): AiContextAttachment['mode'] {
  if (kind === 'outline' || kind === 'folder-summary') return 'outline';
  if (kind === 'memory' || kind === 'session') return 'summary';
  if (kind === 'selection' || kind === 'open-tab') return 'excerpt';
  return 'full';
}

export function createAttachmentFromContext(item: AiContextItem): AiContextAttachment {
  const kind: AiContextAttachmentKind = item.kind === 'manual-note'
    ? item.id === 'memory' ? 'memory' : 'skill'
    : item.kind;
  return {
    id: item.id,
    kind,
    label: item.label,
    path: item.path,
    source: sourceForKind(kind),
    mode: modeForKind(kind),
    content: item.content,
    estimatedChars: item.content.length,
    truncated: item.truncated ?? false,
  };
}

export function attachmentToContextItem(attachment: AiContextAttachment): AiContextItem {
  const kind: AiContextKind = attachment.kind === 'memory'
    || attachment.kind === 'skill'
    || attachment.kind === 'session'
    ? 'manual-note'
    : attachment.kind;
  return {
    id: attachment.id,
    kind,
    label: attachment.label,
    path: attachment.path,
    content: attachment.content,
    truncated: attachment.truncated,
  };
}

export function dedupeAttachments(items: readonly AiContextAttachment[]): AiContextAttachment[] {
  const seen = new Set<string>();
  const out: AiContextAttachment[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.path ?? item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function searchAttachmentCandidates(
  candidates: readonly AiContextAttachment[],
  query: string,
): AiContextAttachment[] {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  const unique = dedupeAttachments(candidates);
  if (!q) return unique;
  return unique
    .map((item, index) => ({ item, index, score: scoreCandidate(item, q) }))
    .filter((entry) => entry.score < Number.POSITIVE_INFINITY)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

function scoreCandidate(item: AiContextAttachment, query: string): number {
  const label = item.label.toLowerCase();
  const path = item.path?.toLowerCase() ?? '';
  const kind = item.kind.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  if (path.startsWith(query)) return 2;
  if (path.includes(query)) return 3;
  if (kind.includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}
