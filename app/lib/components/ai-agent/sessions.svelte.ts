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
  void killClaudeSession(sessionUuid).catch(() => {});
  void killCodexSession(sessionUuid).catch(() => {});
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
  text: string;
  displayText?: string;
  attachments?: TurnAttachmentMeta[];
};

export type AssistantTurn = {
  role: 'assistant';
  text: string;
  cards: Card[];
  cost?: number;
  /** Codex token usage for the turn (Codex reports tokens, not USD cost). */
  usage?: { input: number; output: number };
};

export type Turn = UserTurn | AssistantTurn;

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

export function deriveAgentTitle(turns: Turn[]): string {
  const firstUser = turns.find((t) => t.role === 'user') as UserTurn | undefined;
  if (!firstUser) return 'New agent';
  const first = (firstUser.displayText ?? firstUser.text).trim().split(/\n/)[0];
  return first.length > MAX_TITLE_LENGTH
    ? first.slice(0, MAX_TITLE_LENGTH - 1) + '…'
    : first || 'New agent';
}

function loadSessions(): AgentSession[] {
  return safeParse<AgentSession[]>(localStorage.getItem(SESSIONS_KEY), []).map((s) => ({
    ...s,
    providerId: s.providerId ?? 'claude',
    mode: s.mode ?? 'act',
    providerState: s.providerState ?? {},
  }));
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

  replaceAll(sessions: AgentSession[], activeId?: string | null) {
    this.sessions = sessions.map((s) => ({
      ...s,
      providerId: s.providerId ?? 'claude',
      mode: s.mode ?? 'act',
      providerState: s.providerState ?? {},
    }));
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
    this.sessions = this.sessions.map((s) =>
      s.id === this.activeId
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
