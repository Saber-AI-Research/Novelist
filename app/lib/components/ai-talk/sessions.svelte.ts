/**
 * Multi-session chat store for AI Talk. Each session owns its message
 * history, timestamps, and an optional preset prompt override.
 *
 * Storage:
 *   novelist:ai-talk:sessions:v1     — array of sessions
 *   novelist:ai-talk:active-session:v1 — id of the last-active session
 *
 * Migration: the legacy `novelist:ai-talk:history:v1` key (flat array
 * of DisplayMessage) is converted into a single "Imported" session on
 * first load. The legacy key is then deleted so the migration doesn't
 * run twice.
 */

import type { SuggestionStatus } from '$lib/components/ai-shared/edit-suggestions';

export type DisplayMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Chain-of-thought streamed by reasoning models (DeepSeek `reasoning_content`,
   * OpenRouter `reasoning`). Rendered in a collapsible block and persisted.
   */
  reasoning?: string;
  /** Wall-clock duration of the reasoning phase, shown as "Reasoned 4.8s". */
  reasoningMs?: number;
  /** Accept/reject state of parsed ```novelist-edit suggestions, by id. */
  suggestionStatus?: Record<string, SuggestionStatus>;
};

export type TalkSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: DisplayMessage[];
  /** Optional preset id applied to this session (overrides panel default). */
  presetId?: string;
};

const SESSIONS_KEY = 'novelist:ai-talk:sessions:v1';
const ACTIVE_KEY = 'novelist:ai-talk:active-session:v1';
const LEGACY_HISTORY_KEY = 'novelist:ai-talk:history:v1';
const MAX_SESSIONS = 50;
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

export function deriveSessionTitle(messages: DisplayMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const first = firstUser.content.trim().split(/\n/)[0];
  return first.length > MAX_TITLE_LENGTH
    ? first.slice(0, MAX_TITLE_LENGTH - 1) + '…'
    : first || 'New chat';
}

function loadSessions(): TalkSession[] {
  const raw = localStorage.getItem(SESSIONS_KEY);
  if (raw) return safeParse<TalkSession[]>(raw, []);

  // Legacy migration: one-shot, preserves old history as a session.
  const legacy = safeParse<DisplayMessage[]>(
    localStorage.getItem(LEGACY_HISTORY_KEY),
    [],
  );
  if (legacy.length > 0) {
    const now = Date.now();
    const migrated: TalkSession[] = [
      {
        id: uuid(),
        title: deriveSessionTitle(legacy),
        createdAt: now,
        updatedAt: now,
        messages: legacy,
      },
    ];
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch {
      /* ignore */
    }
    return migrated;
  }
  return [];
}

function persist(sessions: TalkSession[]) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    /* quota exceeded — drop silently */
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

class AiTalkSessionStore {
  sessions = $state<TalkSession[]>(loadSessions());
  activeId = $state<string | null>(null);
  /**
   * Which project the in-memory sessions belong to: a project dir, `null`
   * for "no project open", or `undefined` while none is loaded (the
   * localStorage cache at startup, or mid-switch). Only the owner project
   * may receive these sessions on disk.
   */
  #owner: string | null | undefined = undefined;
  /** Mounted AI Talk panels; sessions are only usable while one is. */
  #attached = 0;
  /** A "new chat" request that arrived before the panel finished loading. */
  #pendingNewSession = false;

  constructor() {
    const stored = localStorage.getItem(ACTIVE_KEY);
    if (stored && this.sessions.some((s) => s.id === stored)) {
      this.activeId = stored;
    } else if (this.sessions.length > 0) {
      this.activeId = this.sessions[0].id;
      persistActive(this.activeId);
    }
  }

  get active(): TalkSession | null {
    if (!this.activeId) return null;
    return this.sessions.find((s) => s.id === this.activeId) ?? null;
  }

  /** Create a new empty session and make it active. Returns its id. */
  create(initialPresetId?: string): string {
    const now = Date.now();
    const session: TalkSession = {
      id: uuid(),
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      presetId: initialPresetId,
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

  delete(id: string) {
    const existed = this.sessions.some((s) => s.id === id);
    if (!existed) return;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) {
      this.activeId = this.sessions[0]?.id ?? null;
      persistActive(this.activeId);
    }
    persist(this.sessions);
  }

  /** Replace messages in a session. Auto-derives title if still default. */
  updateMessages(id: string, messages: DisplayMessage[]) {
    this.sessions = this.sessions.map((s) => {
      if (s.id !== id) return s;
      const title = s.title === 'New chat' || s.title === 'Untitled'
        ? deriveSessionTitle(messages)
        : s.title;
      return { ...s, messages, title, updatedAt: Date.now() };
    });
    persist(this.sessions);
  }

  setPreset(id: string, presetId: string | undefined) {
    this.sessions = this.sessions.map((s) =>
      s.id === id ? { ...s, presetId, updatedAt: Date.now() } : s,
    );
    persist(this.sessions);
  }

  clearMessages(id: string) {
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? { ...s, messages: [], title: 'New chat', updatedAt: Date.now() }
        : s,
    );
    persist(this.sessions);
  }

  /** Called by the panel on mount; the returned function detaches it. */
  attach(): () => void {
    this.#attached += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#attached -= 1;
    };
  }

  /**
   * "New chat" from a command. If the panel is closed or still loading the
   * project's chats, the session is created once loading finishes, so the
   * load does not throw it away.
   */
  requestNewSession(): void {
    if (this.#attached > 0 && this.#owner !== undefined) {
      this.create();
      return;
    }
    this.#pendingNewSession = true;
  }

  /** True when the in-memory sessions belong to `projectDir`. */
  ownsProject(projectDir: string | null): boolean {
    return projectDir !== null && this.#owner === projectDir;
  }

  /**
   * Drop the sessions before switching project. Returns the chats started
   * with no project open, so the next project can adopt them if it has none
   * of its own; another project's chats are never carried over.
   */
  releaseScope(): TalkSession[] {
    const carryOver = this.#owner === null ? this.sessions.filter((s) => s.messages.length > 0) : [];
    this.#owner = undefined;
    this.sessions = [];
    this.activeId = null;
    persist(this.sessions);
    return carryOver;
  }

  /** Install the sessions of `projectDir` (null = no project) and make it the owner. */
  enterScope(projectDir: string | null, sessions: TalkSession[], preferredActiveId: string | null) {
    this.#owner = projectDir;
    this.sessions = sessions.slice(0, MAX_SESSIONS);
    this.activeId = preferredActiveId && this.sessions.some((s) => s.id === preferredActiveId)
      ? preferredActiveId
      : this.sessions[0]?.id ?? null;
    persist(this.sessions);
    persistActive(this.activeId);
    if (this.#pendingNewSession) {
      this.#pendingNewSession = false;
      this.create();
    } else {
      this.ensureOne();
    }
  }

  /** Replace one session's history with a summary. No-op if the session is gone. */
  compact(id: string, summary: string): void {
    if (!this.sessions.some((s) => s.id === id)) return;
    this.sessions = this.sessions.map((s) =>
      s.id === id
        ? {
            ...s,
            messages: [{ role: 'system', content: summary }],
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

  /** Ensure there's at least one active session. */
  ensureOne(initialPresetId?: string): string {
    if (this.activeId && this.active) return this.activeId;
    return this.create(initialPresetId);
  }
}

export const aiTalkSessions = new AiTalkSessionStore();
