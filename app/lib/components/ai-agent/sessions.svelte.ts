/**
 * Multi-session store for AI Agent. Each session owns its own Claude CLI
 * subprocess (tracked by `sessionUuid`), transcript of rendered turns,
 * and cost accounting.
 *
 * Storage: `novelist:ai-agent:sessions:v1` holds serializable metadata
 * and transcripts. The underlying CLI subprocesses are NOT persisted —
 * a session is "live" only for as long as the host process is alive.
 * Restoring the app reopens the transcript but marks sessions as not
 * live; the next `send()` re-spawns the CLI.
 *
 * Active-session id: `novelist:ai-agent:active-session:v1`.
 */

import { killClaudeSession, killCodexSession } from './host';
import { aiAgentSettings } from './settings.svelte';
import type { AiChangeSet } from '$lib/components/ai-shared/apply-change-set';

/** Kill both CLI bridges for a session uuid; each no-ops if it doesn't own it. */
function killBothBridges(sessionUuid: string): void {
  void killClaudeSession(sessionUuid).catch((error) => {
    console.warn(
      '[ai-agent] Claude bridge cleanup failed',
      sanitizeAgentTurnFailureMessage(error instanceof Error ? error.message : String(error)),
    );
  });
  void killCodexSession(sessionUuid).catch((error) => {
    console.warn(
      '[ai-agent] Codex bridge cleanup failed',
      sanitizeAgentTurnFailureMessage(error instanceof Error ? error.message : String(error)),
    );
  });
}

/**
 * `textOffset` records the length of the turn's accumulated `text` at the
 * moment the card was emitted, so the renderer can interleave assistant text
 * and cards in true chronological order (text before a tool call stays above
 * it; text streamed after stays below). Older persisted turns lack it — the
 * renderer falls back to text-then-cards for those.
 */
export type ToolCard = { kind: 'tool'; name: string; input: unknown; textOffset?: number };
export type ToolResultCard = { kind: 'tool-result'; content: string; status?: 'pending' | 'success' | 'error' | 'cancelled'; textOffset?: number };
export type ApplyChangesCard = {
  kind: 'apply-changes';
  changeSet: AiChangeSet;
  status?: 'pending' | 'accepted' | 'rejected' | 'conflict';
  textOffset?: number;
};
export type Card = ToolCard | ToolResultCard | ApplyChangesCard;

export type TurnAttachmentMeta = {
  id: string;
  label: string;
  kind: string;
  path?: string;
};

export type UserTurn = {
  role: 'user';
  /** Stable id shared with the assistant response for targeted retry/state. */
  turnId?: string;
  text: string;
  displayText?: string;
  /** Exact composer input used to re-resolve context after a pre-send failure. */
  sourceText?: string;
  /** Whether context bytes still need resolution before provider dispatch. */
  contextState?: 'pending' | 'resolved';
  attachments?: TurnAttachmentMeta[];
};

export type AssistantTurn = {
  role: 'assistant';
  /** Stable id shared with the user request for targeted retry/state. */
  turnId?: string;
  text: string;
  cards: Card[];
  status?: AgentTurnStatus;
  failure?: AgentTurnFailure;
  cost?: number;
  /** Codex token usage for the turn (Codex reports tokens, not USD cost). */
  usage?: { input: number; output: number };
};

export type Turn = UserTurn | AssistantTurn;

export type AgentTurnStatus = 'streaming' | 'complete' | 'failed' | 'stopped';
export type AgentTurnFailureStage = 'context' | 'send' | 'stream' | 'tool' | 'apply';
export type AgentTurnFailure = {
  stage: AgentTurnFailureStage;
  message: string;
};

export type AgentSession = {
  id: string;
  providerId: 'claude' | 'codex';
  mode: 'act' | 'plan';
  title: string;
  createdAt: number;
  updatedAt: number;
  /** UUID passed to Claude CLI as --session-id. Stable across restarts. */
  sessionUuid: string;
  turns: Turn[];
  /** Cumulative cost across the session ($USD, best-effort from result frames). */
  totalCost?: number;
  interrupted?: boolean;
  providerState?: Record<string, unknown>;
};

const SESSIONS_KEY = 'novelist:ai-agent:sessions:v1';
const ACTIVE_KEY = 'novelist:ai-agent:active-session:v1';
const MAX_SESSIONS = 30;
const MAX_TITLE_LENGTH = 40;
const MAX_FAILURE_CODE_POINTS = 512;
const MAX_PROVIDER_PAYLOAD_DEPTH = 32;
const MAX_PROVIDER_PAYLOAD_VALUES = 2048;
const REDACTED_CREDENTIAL_VALUE = '[REDACTED]';
const REDACTED_AUTHORIZATION_PLACEHOLDER = '\uE000novelist-redacted-authorization\uE001';
const REDACTED_AUTHORIZATION = /Authorization:\s*\[REDACTED\]/giu;
const PROVIDER_CREDENTIAL_KEYS = new Set([
  'password',
  'passwd',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'api_secret',
  'client_secret',
  'secret',
  'credential',
  'credentials',
  'authorization',
  'proxy_authorization',
  'cookie',
  'cookies',
  'set_cookie',
  'aws_access_key_id',
  'aws_secret_access_key',
  'aws_session_token',
]);
const CREDENTIAL_SEPARATOR = '(?:[_\\s-]|[\\p{Cc}\\p{Cf}])*';
const ASSIGNMENT_PADDING = '(?:\\s|[\\p{Cc}\\p{Cf}])*';
const AUTHORIZATION_PADDING = '(?:[ \\t]|[\\p{Cf}]|[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F])*';
const CONTROL_FORMAT_PADDING = '(?:[\\p{Cc}\\p{Cf}])*';

function controlTolerantCredentialName(name: string): string {
  return name
    .split('_')
    .map((part) => Array.from(part).join(CONTROL_FORMAT_PADDING))
    .join(CREDENTIAL_SEPARATOR);
}

const AUTHORIZATION_KEY = controlTolerantCredentialName('Authorization');
const CREDENTIAL_KEY = `(?:${[
  'access_token',
  'api_key',
  'client_secret',
  'ghost_token',
  'apikey',
  'password',
  'passwd',
  'secret',
  'credential',
  'authorization',
  'token',
].map(controlTolerantCredentialName).join('|')})`;
const CREDENTIAL_ASSIGNMENT = new RegExp(`(["']?${CREDENTIAL_KEY}["']?${ASSIGNMENT_PADDING}[:=]${ASSIGNMENT_PADDING})`, 'giu');
const AUTHORIZATION_HEADER = new RegExp(
  `\\b${AUTHORIZATION_KEY}${AUTHORIZATION_PADDING}:${AUTHORIZATION_PADDING}[^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*`,
  'giu',
);
const CREDENTIAL_CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const UNQUOTED_CREDENTIAL_DELIMITER = /[\s&"'{}[\]]/u;
const CLEAR_DELIMITER_FOLLOWER = /[\s,;&"'{}[\]]/u;
const UNTERMINATED_CREDENTIAL_DELIMITER = /[,;{}[\]]/u;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

function isUnquotedCredentialCodeUnit(message: string, index: number): boolean {
  const value = message[index];
  if (CREDENTIAL_CONTROL_OR_FORMAT.test(value)) return true;
  if (value === ',' || value === ';') {
    const next = message[index + 1];
    return next !== undefined && !CLEAR_DELIMITER_FOLLOWER.test(next);
  }
  return !UNQUOTED_CREDENTIAL_DELIMITER.test(value);
}

function isUnterminatedCredentialCodeUnit(value: string): boolean {
  return !UNTERMINATED_CREDENTIAL_DELIMITER.test(value);
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function redactCredentialAssignments(message: string): string {
  let result = '';
  let cursor = 0;
  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = CREDENTIAL_ASSIGNMENT.exec(message))) {
    const valueStart = CREDENTIAL_ASSIGNMENT.lastIndex;
    const quote = message[valueStart] === '"' || message[valueStart] === "'"
      ? message[valueStart]
      : null;
    let valueEnd = valueStart;

    if (quote) {
      let closed = false;
      valueEnd += 1;
      while (valueEnd < message.length) {
        if (message[valueEnd] === '\\' && valueEnd + 1 < message.length) {
          valueEnd += 2;
        } else if (message[valueEnd] === quote) {
          valueEnd += 1;
          closed = true;
          break;
        } else {
          valueEnd += 1;
        }
      }
      if (!closed) {
        valueEnd = valueStart + 1;
        while (
          valueEnd < message.length &&
          isUnterminatedCredentialCodeUnit(message[valueEnd])
        ) {
          valueEnd += 1;
        }
      }
    } else {
      while (
        valueEnd < message.length &&
        isUnquotedCredentialCodeUnit(message, valueEnd)
      ) {
        valueEnd += 1;
      }
    }

    if (valueEnd === valueStart || (quote && valueEnd === valueStart + 1)) continue;
    result += message.slice(cursor, match.index);
    result += `${match[1]}${quote ?? ''}[REDACTED]${quote ?? ''}`;
    cursor = valueEnd;
    CREDENTIAL_ASSIGNMENT.lastIndex = valueEnd;
  }

  return `${result}${message.slice(cursor)}`;
}

export function sanitizeAgentTurnFailureMessage(message: string): string {
  const protectedMessage = message.replace(
    REDACTED_AUTHORIZATION,
    REDACTED_AUTHORIZATION_PLACEHOLDER,
  );
  const normalized = redactCredentialAssignments(
    protectedMessage.replace(AUTHORIZATION_HEADER, 'Authorization: [REDACTED]'),
  )
    .replace(
      /\b(Bearer|Basic|Token|Ghost)(?:\s|[\p{Cc}\p{Cf}])+[A-Za-z0-9._~+/=-]+(?:[\p{Cc}\p{Cf}]+[A-Za-z0-9._~+/=-]+)*/giu,
      '$1 [REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@\p{Cc}\p{Cf}]|[\p{Cc}\p{Cf}])+@/giu, '$1[REDACTED]@')
    .replace(CONTROL_OR_FORMAT, ' ')
    .replace(/\b(Bearer|Basic|Token|Ghost)\s+[^\s,;]+/giu, '$1 [REDACTED]');
  const sanitized = redactCredentialAssignments(normalized)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu, '$1[REDACTED]@')
    .replace(/\s+/gu, ' ')
    .trim()
    .replaceAll(REDACTED_AUTHORIZATION_PLACEHOLDER, 'Authorization: [REDACTED]');
  const codePoints = Array.from(sanitized);
  if (codePoints.length <= MAX_FAILURE_CODE_POINTS) return sanitized;
  return `${codePoints.slice(0, MAX_FAILURE_CODE_POINTS - 1).join('')}…`;
}

type ProviderPayloadContainer = unknown[] | Record<string, unknown>;

function isProviderCredentialKey(key: string): boolean {
  const normalized = key
    .replace(CONTROL_OR_FORMAT, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return PROVIDER_CREDENTIAL_KEYS.has(normalized);
}

function createProviderPayloadContainer(value: object): ProviderPayloadContainer {
  return Array.isArray(value) ? [] : {};
}

function setProviderPayloadValue(
  target: ProviderPayloadContainer,
  key: string,
  value: unknown,
): void {
  if (Array.isArray(target)) target[Number(key)] = value;
  else target[key] = value;
}

export function sanitizeAgentProviderPayload(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeAgentTurnFailureMessage(value);
  if (value === null || typeof value !== 'object') return value;

  const root = createProviderPayloadContainer(value);
  const seen = new WeakSet<object>([value]);
  const pending: Array<{
    source: object;
    target: ProviderPayloadContainer;
    depth: number;
  }> = [{ source: value, target: root, depth: 0 }];
  let processedValues = 0;

  while (pending.length > 0 && processedValues < MAX_PROVIDER_PAYLOAD_VALUES) {
    const frame = pending.pop();
    if (!frame) break;
    const entries: Array<[string, unknown]> = Array.isArray(frame.source)
      ? frame.source.map((item, index) => [String(index), item])
      : Object.entries(frame.source as Record<string, unknown>);

    for (const [key, child] of entries) {
      if (processedValues >= MAX_PROVIDER_PAYLOAD_VALUES) break;
      processedValues += 1;
      if (!Array.isArray(frame.source) && isProviderCredentialKey(key)) {
        setProviderPayloadValue(frame.target, key, REDACTED_CREDENTIAL_VALUE);
      } else if (typeof child === 'string') {
        setProviderPayloadValue(frame.target, key, sanitizeAgentTurnFailureMessage(child));
      } else if (child === null || typeof child !== 'object') {
        setProviderPayloadValue(frame.target, key, child);
      } else if (seen.has(child)) {
        setProviderPayloadValue(frame.target, key, null);
      } else {
        const next = createProviderPayloadContainer(child);
        setProviderPayloadValue(frame.target, key, next);
        if (frame.depth + 1 < MAX_PROVIDER_PAYLOAD_DEPTH) {
          seen.add(child);
          pending.push({ source: child, target: next, depth: frame.depth + 1 });
        }
      }
    }
  }

  return root;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeRestoredHunks(value: unknown): AiChangeSet['files'][number]['hunks'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rawHunk): AiChangeSet['files'][number]['hunks'] => {
    if (!rawHunk || typeof rawHunk !== 'object') return [];
    const hunk = rawHunk as Record<string, unknown>;
    const oldStart = optionalFiniteNumber(hunk.oldStart);
    const oldLines = optionalFiniteNumber(hunk.oldLines);
    const newStart = optionalFiniteNumber(hunk.newStart);
    const newLines = optionalFiniteNumber(hunk.newLines);
    if (oldStart == null || oldLines == null || newStart == null || newLines == null) return [];
    const lines = Array.isArray(hunk.lines)
      ? hunk.lines.flatMap((rawLine): AiChangeSet['files'][number]['hunks'][number]['lines'] => {
          if (!rawLine || typeof rawLine !== 'object') return [];
          const line = rawLine as Record<string, unknown>;
          if (
            (line.kind !== 'context' && line.kind !== 'added' && line.kind !== 'removed')
            || typeof line.text !== 'string'
          ) return [];
          return [{ kind: line.kind, text: line.text }];
        })
      : [];
    return [{ oldStart, oldLines, newStart, newLines, lines }];
  });
}

function normalizeRestoredCard(value: unknown, sessionId: string): Card | null {
  if (!value || typeof value !== 'object') return null;
  const card = value as Record<string, unknown>;
  const textOffset = optionalFiniteNumber(card.textOffset);
  if (card.kind === 'tool' && typeof card.name === 'string') {
    return {
      kind: 'tool',
      name: card.name,
      input: sanitizeAgentProviderPayload(card.input),
      ...(textOffset == null ? {} : { textOffset }),
    };
  }
  if (card.kind === 'tool-result' && typeof card.content === 'string') {
    const status = ['pending', 'success', 'error', 'cancelled'].includes(String(card.status))
      ? card.status as ToolResultCard['status']
      : undefined;
    return {
      kind: 'tool-result',
      content: sanitizeAgentTurnFailureMessage(card.content),
      ...(status == null ? {} : { status }),
      ...(textOffset == null ? {} : { textOffset }),
    };
  }
  if (card.kind !== 'apply-changes' || !card.changeSet || typeof card.changeSet !== 'object') return null;
  const rawChangeSet = card.changeSet as Record<string, unknown>;
  const files = Array.isArray(rawChangeSet.files)
    ? rawChangeSet.files.flatMap((value): AiChangeSet['files'] => {
        if (!value || typeof value !== 'object') return [];
        const file = value as Record<string, unknown>;
        if (
          typeof file.path !== 'string'
          || (file.status !== 'modify' && file.status !== 'create')
          || typeof file.proposedText !== 'string'
        ) return [];
        return [{
          path: file.path,
          status: file.status,
          originalText: typeof file.originalText === 'string' ? file.originalText : null,
          proposedText: file.proposedText,
          hunks: normalizeRestoredHunks(file.hunks),
          ...(typeof file.conflict === 'string' ? { conflict: file.conflict } : {}),
        }];
      })
    : [];
  if (files.length === 0) return null;
  const status = ['pending', 'accepted', 'rejected', 'conflict'].includes(String(card.status))
    ? card.status as ApplyChangesCard['status']
    : undefined;
  return {
    kind: 'apply-changes',
    changeSet: {
      id: optionalString(rawChangeSet.id) ?? uuid(),
      sourceSessionId: sessionId,
      sourceProjectDir: optionalString(rawChangeSet.sourceProjectDir) ?? null,
      createdAt: optionalString(rawChangeSet.createdAt) ?? new Date(0).toISOString(),
      summary: optionalString(rawChangeSet.summary) ?? 'Proposed changes',
      files,
    },
    ...(status == null ? {} : { status }),
    ...(textOffset == null ? {} : { textOffset }),
  };
}

function normalizeRestoredTurn(value: unknown, sessionId: string): Turn | null {
  if (!value || typeof value !== 'object') return null;
  const turn = value as Record<string, unknown>;
  if (turn.role === 'user' && typeof turn.text === 'string') {
    const contextState = turn.contextState === 'pending' || turn.contextState === 'resolved'
      ? turn.contextState
      : undefined;
    const attachments = Array.isArray(turn.attachments)
      ? turn.attachments.flatMap((value): TurnAttachmentMeta[] => {
          if (!value || typeof value !== 'object') return [];
          const attachment = value as Record<string, unknown>;
          if (
            typeof attachment.id !== 'string'
            || typeof attachment.label !== 'string'
            || typeof attachment.kind !== 'string'
          ) return [];
          return [{
            id: attachment.id,
            label: attachment.label,
            kind: attachment.kind,
            ...(typeof attachment.path === 'string' ? { path: attachment.path } : {}),
          }];
        })
      : undefined;
    return {
      role: 'user',
      text: turn.text,
      ...(typeof turn.turnId === 'string' ? { turnId: turn.turnId } : {}),
      ...(typeof turn.displayText === 'string' ? { displayText: turn.displayText } : {}),
      ...(typeof turn.sourceText === 'string' ? { sourceText: turn.sourceText } : {}),
      ...(contextState == null ? {} : { contextState }),
      ...(attachments == null ? {} : { attachments }),
    };
  }
  if (turn.role !== 'assistant' || typeof turn.text !== 'string') return null;
  const status = ['streaming', 'complete', 'failed', 'stopped'].includes(String(turn.status))
    ? turn.status as AgentTurnStatus
    : undefined;
  const failure = turn.failure && typeof turn.failure === 'object'
    ? turn.failure as Record<string, unknown>
    : null;
  const failureStage = failure && ['context', 'send', 'stream', 'tool', 'apply'].includes(String(failure.stage))
    ? failure.stage as AgentTurnFailureStage
    : null;
  const usage = turn.usage && typeof turn.usage === 'object'
    ? turn.usage as Record<string, unknown>
    : null;
  const input = optionalFiniteNumber(usage?.input);
  const output = optionalFiniteNumber(usage?.output);
  return {
    role: 'assistant',
    text: turn.text,
    cards: Array.isArray(turn.cards)
      ? turn.cards.map((card) => normalizeRestoredCard(card, sessionId)).filter((card): card is Card => card !== null)
      : [],
    ...(typeof turn.turnId === 'string' ? { turnId: turn.turnId } : {}),
    ...(status == null ? {} : { status: status === 'streaming' ? 'stopped' : status }),
    ...(failureStage == null || typeof failure?.message !== 'string' ? {} : {
      failure: {
        stage: failureStage,
        message: sanitizeAgentTurnFailureMessage(failure.message),
      },
    }),
    ...(optionalFiniteNumber(turn.cost) == null ? {} : { cost: optionalFiniteNumber(turn.cost) }),
    ...(input == null || output == null ? {} : { usage: { input, output } }),
  };
}

function normalizeRestoredSession(value: unknown): AgentSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Record<string, unknown>;
  if (
    typeof session.id !== 'string'
    || !session.id
    || typeof session.sessionUuid !== 'string'
    || !session.sessionUuid
  ) return null;
  const sessionId = session.id;
  const providerState = sanitizeAgentProviderPayload(session.providerState ?? {});
  return {
    id: sessionId,
    providerId: session.providerId === 'codex' ? 'codex' : 'claude',
    mode: session.mode === 'plan' ? 'plan' : 'act',
    title: typeof session.title === 'string' ? session.title : 'New agent',
    createdAt: optionalFiniteNumber(session.createdAt) ?? Date.now(),
    updatedAt: optionalFiniteNumber(session.updatedAt) ?? Date.now(),
    sessionUuid: session.sessionUuid,
    turns: Array.isArray(session.turns)
      ? session.turns.map((turn) => normalizeRestoredTurn(turn, sessionId)).filter((turn): turn is Turn => turn !== null)
      : [],
    ...(optionalFiniteNumber(session.totalCost) == null ? {} : { totalCost: optionalFiniteNumber(session.totalCost) }),
    ...(typeof session.interrupted === 'boolean' ? { interrupted: session.interrupted } : {}),
    providerState: providerState && typeof providerState === 'object' && !Array.isArray(providerState)
      ? providerState as Record<string, unknown>
      : {},
  };
}

function normalizeRestoredSessions(value: unknown): AgentSession[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const sessionUuids = new Set<string>();
  const sessions: AgentSession[] = [];
  for (const raw of value) {
    const session = normalizeRestoredSession(raw);
    if (!session || ids.has(session.id) || sessionUuids.has(session.sessionUuid)) continue;
    ids.add(session.id);
    sessionUuids.add(session.sessionUuid);
    sessions.push(session);
  }
  return sessions;
}

export function deriveAgentTitle(turns: Turn[]): string {
  const firstUser = turns.find((t) => t.role === 'user') as UserTurn | undefined;
  if (!firstUser) return 'New agent';
  const first = (firstUser.displayText ?? firstUser.text).trim().split(/\n/)[0];
  return first.length > MAX_TITLE_LENGTH
    ? first.slice(0, MAX_TITLE_LENGTH - 1) + '…'
    : first || 'New agent';
}

function loadSessions(): AgentSession[] {
  return normalizeRestoredSessions(safeParse<unknown>(localStorage.getItem(SESSIONS_KEY), []));
}

function persist(sessions: AgentSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    /* ignore */
  }
}

function persistActive(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

class AiAgentSessionStore {
  sessions = $state<AgentSession[]>(loadSessions());
  activeId = $state<string | null>(null);

  constructor() {
    const stored = localStorage.getItem(ACTIVE_KEY);
    if (stored && this.sessions.some((s) => s.id === stored)) {
      this.activeId = stored;
    } else if (this.sessions.length > 0) {
      this.activeId = this.sessions[0].id;
      persistActive(this.activeId);
    }
  }

  get active(): AgentSession | null {
    if (!this.activeId) return null;
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  create(): string {
    const now = Date.now();
    const session: AgentSession = {
      id: uuid(),
      providerId: aiAgentSettings.value.providerId,
      mode: 'act',
      title: 'New agent',
      createdAt: now,
      updatedAt: now,
      sessionUuid: uuid(),
      turns: [],
    };
    this.sessions = [session, ...this.sessions].slice(0, MAX_SESSIONS);
    this.activeId = session.id;
    persist(this.sessions);
    persistActive(this.activeId);
    return session.id;
  }

  setMode(id: string, mode: 'act' | 'plan') {
    this.sessions = this.sessions.map((s) =>
      s.id === id ? { ...s, mode, updatedAt: Date.now() } : s,
    );
    persist(this.sessions);
  }

  /** Merge keys into a session's providerState (e.g. claudeStarted). */
  patchProviderState(id: string, patch: Record<string, unknown>) {
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? { ...s, providerState: { ...(s.providerState ?? {}), ...patch }, updatedAt: Date.now() }
        : s,
    );
    persist(this.sessions);
  }

  markInterrupted(id: string) {
    this.sessions = this.sessions.map((s) =>
      s.id === id ? { ...s, interrupted: true, updatedAt: Date.now() } : s,
    );
    persist(this.sessions);
  }

  fork(id: string, throughTurnIndex?: number): string | null {
    const source = this.sessions.find((s) => s.id === id);
    if (!source) return null;
    const now = Date.now();
    const turns = throughTurnIndex == null ? source.turns : source.turns.slice(0, throughTurnIndex + 1);
    const session: AgentSession = {
      ...source,
      id: uuid(),
      sessionUuid: uuid(),
      title: `${source.title} fork`,
      createdAt: now,
      updatedAt: now,
      turns,
      totalCost: undefined,
      interrupted: false,
      providerState: { forkedFrom: source.id },
    };
    this.sessions = [session, ...this.sessions].slice(0, MAX_SESSIONS);
    this.activeId = session.id;
    persist(this.sessions);
    persistActive(this.activeId);
    return session.id;
  }

  replaceAll(sessions: unknown[], activeId?: string | null) {
    this.sessions = normalizeRestoredSessions(sessions);
    this.activeId = activeId && this.sessions.some((s) => s.id === activeId)
      ? activeId
      : this.sessions[0]?.id ?? null;
    persist(this.sessions);
    persistActive(this.activeId);
  }

  snapshot(): { sessions: AgentSession[]; activeId: string | null } {
    return {
      sessions: this.sessions,
      activeId: this.activeId,
    };
  }

  compactActive(summary: string): void {
    if (!this.activeId) return;
    this.compact(this.activeId, summary);
  }

  compact(id: string, summary: string): void {
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            turns: [{ role: 'assistant', text: summary, cards: [] }],
            updatedAt: Date.now(),
          }
        : s,
    );
    persist(this.sessions);
  }

  setActive(id: string) {
    if (this.sessions.some((s) => s.id === id)) {
      this.activeId = id;
      persistActive(id);
    }
  }

  rename(id: string, title: string) {
    const cleaned = title.trim().slice(0, MAX_TITLE_LENGTH) || 'Untitled';
    this.sessions = this.sessions.map((s) =>
      s.id === id ? { ...s, title: cleaned, updatedAt: Date.now() } : s,
    );
    persist(this.sessions);
  }

  restoreRenameIfOwned(id: string, applied: AgentSession, previous: AgentSession): boolean {
    const current = this.sessions.find((session) => session.id === id);
    if (!current || current.title !== applied.title) return false;
    this.sessions = this.sessions.map((session) =>
      session.id === id
        ? {
            ...session,
            title: previous.title,
            updatedAt: session.updatedAt === applied.updatedAt
              ? previous.updatedAt
              : session.updatedAt,
          }
        : session,
    );
    persist(this.sessions);
    return true;
  }

  restoreSessionIfOwned(id: string, applied: AgentSession, previous: AgentSession): boolean {
    const current = this.sessions.find((session) => session.id === id);
    if (current !== applied) return false;
    this.sessions = this.sessions.map((session) => session.id === id ? previous : session);
    persist(this.sessions);
    return true;
  }

  removeCreatedSession(id: string, previousActiveId: string | null): boolean {
    if (!this.sessions.some((session) => session.id === id)) return false;
    this.sessions = this.sessions.filter((session) => session.id !== id);
    if (this.activeId === id) {
      this.activeId = previousActiveId && this.sessions.some((session) => session.id === previousActiveId)
        ? previousActiveId
        : this.sessions[0]?.id ?? null;
      persistActive(this.activeId);
    }
    persist(this.sessions);
    return true;
  }

  reinsertDeletedSession(
    session: AgentSession,
    index: number,
    activeBeforeDelete: string | null,
    activeAfterDelete: string | null,
  ): boolean {
    if (this.sessions.some((candidate) => candidate.id === session.id)) return false;
    const next = [...this.sessions];
    next.splice(Math.min(index, next.length), 0, session);
    this.sessions = next;
    if (this.activeId === activeAfterDelete && activeBeforeDelete === session.id) {
      this.activeId = session.id;
      persistActive(this.activeId);
    }
    persist(this.sessions);
    return true;
  }

  /** Delete a session and kill its Claude CLI subprocess (best effort). */
  async delete(id: string): Promise<void> {
    const target = this.sessions.find((s) => s.id === id);
    if (!target) return;
    // Fire-and-forget: if the CLI process never existed, this no-ops.
    killBothBridges(target.sessionUuid);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = this.sessions[0]?.id ?? null;
      persistActive(this.activeId);
    }
    persist(this.sessions);
  }

  updateTurns(id: string, turns: Turn[], cost?: number) {
    this.sessions = this.sessions.map((s) => {
      if (s.id !== id) return s;
      const title = s.title === 'New agent' || s.title === 'Untitled'
        ? deriveAgentTitle(turns)
        : s.title;
      return {
        ...s,
        turns,
        title,
        totalCost: cost != null ? (s.totalCost ?? 0) + cost : s.totalCost,
        updatedAt: Date.now(),
      };
    });
    persist(this.sessions);
  }

  startTurn(id: string, request: Omit<UserTurn, 'role' | 'turnId'>): string {
    const turnId = uuid();
    const session = this.sessions.find((candidate) => candidate.id === id);
    if (!session) return turnId;
    this.updateTurns(id, [
      ...session.turns,
      { role: 'user', turnId, ...request },
      { role: 'assistant', turnId, text: '', cards: [], status: 'streaming' },
    ]);
    return turnId;
  }

  updateAssistantTurn(
    id: string,
    turnId: string,
    update: (turn: AssistantTurn) => AssistantTurn,
    cost?: number,
  ): void {
    const session = this.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    let found = false;
    const turns = session.turns.map((turn) => {
      if (turn.role !== 'assistant' || turn.turnId !== turnId) return turn;
      found = true;
      return update(turn);
    });
    if (found) this.updateTurns(id, turns, cost);
  }

  failTurn(
    id: string,
    turnId: string,
    stage: AgentTurnFailureStage,
    message: string,
    terminal = true,
  ): void {
    this.updateAssistantTurn(id, turnId, (turn) => ({
      ...turn,
      status: terminal ? 'failed' : turn.status,
      failure: { stage, message: sanitizeAgentTurnFailureMessage(message) },
    }));
  }

  completeTurn(id: string, turnId: string): void {
    this.updateAssistantTurn(id, turnId, (turn) => ({
      ...turn,
      status: turn.failure ? 'failed' : 'complete',
    }));
  }

  stopTurn(id: string, turnId: string): void {
    this.updateAssistantTurn(id, turnId, (turn) => ({
      ...turn,
      status: 'stopped',
    }));
  }

  retryTurn(
    id: string,
    turnId: string,
    replacement?: Omit<UserTurn, 'role' | 'turnId'>,
  ): UserTurn | null {
    const session = this.sessions.find((candidate) => candidate.id === id);
    const request = session?.turns.find(
      (turn): turn is UserTurn => turn.role === 'user' && turn.turnId === turnId,
    );
    if (!request) return null;
    const retryRequest: UserTurn = replacement
      ? { role: 'user', turnId, ...replacement }
      : request;
    this.updateTurns(id, session!.turns.map((turn) => {
      if (turn.role === 'user' && turn.turnId === turnId) return retryRequest;
      if (turn.role === 'assistant' && turn.turnId === turnId) {
        return {
          role: 'assistant',
          turnId,
          text: '',
          cards: [],
          status: 'streaming',
        };
      }
      return turn;
    }));
    return retryRequest;
  }

  clearTurns(id: string): void {
    const target = this.sessions.find((s) => s.id === id);
    if (!target) return;
    // Also kill the CLI subprocess so the NEXT send gets a fresh session.
    killBothBridges(target.sessionUuid);
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            turns: [],
            title: 'New agent',
            sessionUuid: uuid(),
            totalCost: undefined,
            // Fresh uuid → fresh CLI conversation; drop resume markers.
            providerState: {},
            updatedAt: Date.now(),
          }
        : s,
    );
    persist(this.sessions);
  }

  activateNext() {
    if (this.sessions.length < 2) return;
    const idx = this.sessions.findIndex((s) => s.id === this.activeId);
    const next = this.sessions[(idx + 1) % this.sessions.length];
    this.setActive(next.id);
  }

  activatePrev() {
    if (this.sessions.length < 2) return;
    const idx = this.sessions.findIndex((s) => s.id === this.activeId);
    const prev = this.sessions[(idx - 1 + this.sessions.length) % this.sessions.length];
    this.setActive(prev.id);
  }

  ensureOne(): string {
    if (this.activeId && this.active) return this.activeId;
    return this.create();
  }
}

export const aiAgentSessions = new AiAgentSessionStore();
