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

export type DisplayMessage = { role: 'user' | 'assistant'; content: string };

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
