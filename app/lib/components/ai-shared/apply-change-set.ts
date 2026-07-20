export type AiDiffLine = { kind: 'context' | 'added' | 'removed'; text: string };

export type AiDiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: AiDiffLine[];
};

export type AiFileChange = {
  path: string;
  status: 'modify' | 'create';
  originalText: string | null;
  proposedText: string;
  hunks: AiDiffHunk[];
  conflict?: string;
};

export type AiChangeSet = {
  id: string;
  sourceSessionId: string;
  sourceProjectDir?: string | null;
  createdAt: string;
  summary: string;
  files: AiFileChange[];
};

type ParseOptions = {
  sourceSessionId: string;
  sourceProjectDir?: string | null;
};

type ValidationResult = { ok: true } | { ok: false; reason: string };

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `changes-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function normalizeFile(raw: unknown): AiFileChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  if (typeof file.path !== 'string' || !file.path.trim()) return null;
  if (file.status !== 'modify' && file.status !== 'create') return null;
  if (typeof file.proposedText !== 'string') return null;
  const originalText = typeof file.originalText === 'string' ? file.originalText : null;
  return {
    path: file.path,
    status: file.status,
    originalText,
    proposedText: file.proposedText,
    hunks: Array.isArray(file.hunks) ? file.hunks as AiDiffHunk[] : buildLineDiff(originalText ?? '', file.proposedText),
  };
}

export function parseChangeSetsFromText(text: string, options: ParseOptions): AiChangeSet[] {
  const out: AiChangeSet[] = [];
  const re = /```novelist-change-set\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      const files = Array.isArray(raw.files)
        ? raw.files.map(normalizeFile).filter(Boolean) as AiFileChange[]
        : [];
      if (files.length === 0) continue;
      out.push({
        id: uuid(),
        sourceSessionId: options.sourceSessionId,
        sourceProjectDir: options.sourceProjectDir ?? null,
        createdAt: new Date().toISOString(),
        summary: typeof raw.summary === 'string' && raw.summary.trim()
          ? raw.summary
          : 'Proposed changes',
        files,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function buildLineDiff(original: string, proposed: string): AiDiffHunk[] {
  const a = original.replace(/\n$/, '').split('\n');
  const b = proposed.replace(/\n$/, '').split('\n');
  const lines: AiDiffLine[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      if (a[i] !== undefined) lines.push({ kind: 'context', text: a[i] });
    } else {
      if (a[i] !== undefined) lines.push({ kind: 'removed', text: a[i] });
      if (b[i] !== undefined) lines.push({ kind: 'added', text: b[i] });
    }
  }
  return [{
    oldStart: 1,
    oldLines: a.length,
    newStart: 1,
    newLines: b.length,
    lines,
  }];
}

export function validateFileChange(change: AiFileChange, latestText: string | null): ValidationResult {
  if (change.status === 'modify' && latestText == null) {
    return { ok: false, reason: 'Target file does not exist.' };
  }
  if (change.status === 'create' && latestText != null) {
    return { ok: false, reason: 'Target file already exists.' };
  }
  if (change.originalText != null && latestText != null && change.originalText !== latestText) {
    return { ok: false, reason: 'File changed since proposal was generated.' };
  }
  return { ok: true };
}
