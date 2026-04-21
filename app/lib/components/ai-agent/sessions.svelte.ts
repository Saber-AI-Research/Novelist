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

import { killClaudeSession } from './host';

export type ToolCard = { kind: 'tool'; name: string; input: unknown };
export type ToolResultCard = { kind: 'tool-result'; content: string };
export type Card = ToolCard | ToolResultCard;

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; cards: Card[]; cost?: number };

export type AgentSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** UUID passed to Claude CLI as --session-id. Stable across restarts. */
  sessionUuid: string;
  turns: Turn[];
  /** Cumulative cost across the session ($USD, best-effort from result frames). */
  totalCost?: number;
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
  const firstUser = turns.find((t) => t.role === 'user') as
    | { role: 'user'; text: string }
    | undefined;
  if (!firstUser) return 'New agent';
  const first = firstUser.text.trim().split(/\n/)[0];
  return first.length > MAX_TITLE_LENGTH
    ? first.slice(0, MAX_TITLE_LENGTH - 1) + '…'
    : first || 'New agent';
}

function loadSessions(): AgentSession[] {
  return safeParse<AgentSession[]>(localStorage.getItem(SESSIONS_KEY), []);
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
    void killClaudeSession(target.sessionUuid).catch(() => {});
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
    void killClaudeSession(target.sessionUuid).catch(() => {});
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            turns: [],
            title: 'New agent',
            sessionUuid: uuid(),
            totalCost: undefined,
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
