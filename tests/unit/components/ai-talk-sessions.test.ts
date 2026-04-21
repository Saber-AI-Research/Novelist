import { describe, it, expect, beforeEach } from 'vitest';
import { aiTalkSessions } from '$lib/components/ai-talk/sessions.svelte';

function resetStore() {
  localStorage.clear();
  aiTalkSessions.sessions = [];
  aiTalkSessions.activeId = null;
}

describe('aiTalkSessions store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts empty after reset', () => {
    expect(aiTalkSessions.sessions).toEqual([]);
    expect(aiTalkSessions.activeId).toBeNull();
  });

  it('create() pushes a new session to the top and activates it', () => {
    const id = aiTalkSessions.create();
    expect(aiTalkSessions.sessions).toHaveLength(1);
    expect(aiTalkSessions.sessions[0].id).toBe(id);
    expect(aiTalkSessions.activeId).toBe(id);
    expect(aiTalkSessions.active?.title).toBe('New chat');
    expect(aiTalkSessions.active?.messages).toEqual([]);
  });

  it('updateMessages auto-derives title from the first user message', () => {
    const id = aiTalkSessions.create();
    aiTalkSessions.updateMessages(id, [
      { role: 'user', content: 'Title comes from here.\nSecond line ignored.' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(aiTalkSessions.active?.title).toBe('Title comes from here.');
  });

  it('rename() respects the max length', () => {
    const id = aiTalkSessions.create();
    aiTalkSessions.rename(id, 'a'.repeat(100));
    expect(aiTalkSessions.active?.title).toHaveLength(40);
  });

  it('delete() picks a new active id when deleting the current one', () => {
    const a = aiTalkSessions.create();
    const b = aiTalkSessions.create();
    expect(aiTalkSessions.activeId).toBe(b);
    aiTalkSessions.delete(b);
    expect(aiTalkSessions.activeId).toBe(a);
  });

  it('delete() nulls activeId when no sessions remain', () => {
    const a = aiTalkSessions.create();
    aiTalkSessions.delete(a);
    expect(aiTalkSessions.activeId).toBeNull();
    expect(aiTalkSessions.sessions).toHaveLength(0);
  });

  it('activateNext / activatePrev cycle through sessions', () => {
    const a = aiTalkSessions.create();
    const b = aiTalkSessions.create();
    const c = aiTalkSessions.create();
    // [c, b, a] with c active
    aiTalkSessions.activateNext(); // → b
    expect(aiTalkSessions.activeId).toBe(b);
    aiTalkSessions.activateNext(); // → a
    expect(aiTalkSessions.activeId).toBe(a);
    aiTalkSessions.activateNext(); // wrap → c
    expect(aiTalkSessions.activeId).toBe(c);
    aiTalkSessions.activatePrev(); // → a
    expect(aiTalkSessions.activeId).toBe(a);
  });

  it('setPreset persists a preset id on the session', () => {
    const id = aiTalkSessions.create();
    aiTalkSessions.setPreset(id, 'builtin:editor');
    expect(aiTalkSessions.active?.presetId).toBe('builtin:editor');
    aiTalkSessions.setPreset(id, undefined);
    expect(aiTalkSessions.active?.presetId).toBeUndefined();
  });

  it('ensureOne creates a session when empty, reuses existing one otherwise', () => {
    const first = aiTalkSessions.ensureOne();
    expect(aiTalkSessions.sessions).toHaveLength(1);
    const second = aiTalkSessions.ensureOne();
    expect(second).toBe(first);
    expect(aiTalkSessions.sessions).toHaveLength(1);
  });

  it('clearMessages resets content + title to "New chat"', () => {
    const id = aiTalkSessions.create();
    aiTalkSessions.updateMessages(id, [
      { role: 'user', content: 'something' },
    ]);
    expect(aiTalkSessions.active?.title).toBe('something');
    aiTalkSessions.clearMessages(id);
    expect(aiTalkSessions.active?.title).toBe('New chat');
    expect(aiTalkSessions.active?.messages).toHaveLength(0);
  });
});
