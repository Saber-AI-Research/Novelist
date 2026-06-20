import { describe, expect, it, beforeEach, vi } from 'vitest';

const { killClaudeSession, killCodexSession } = vi.hoisted(() => ({
  killClaudeSession: vi.fn().mockResolvedValue(undefined),
  killCodexSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/components/ai-agent/host', () => ({
  killClaudeSession,
  killCodexSession,
}));

import { aiAgentSessions } from '$lib/components/ai-agent/sessions.svelte';
import { aiAgentSettings } from '$lib/components/ai-agent/settings.svelte';

function resetStore() {
  localStorage.clear();
  aiAgentSessions.sessions = [];
  aiAgentSessions.activeId = null;
  aiAgentSettings.reset();
  killClaudeSession.mockClear();
  killCodexSession.mockClear();
}

describe('[contract] aiAgentSessions store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('creates Claude act sessions by default', () => {
    const id = aiAgentSessions.create();
    expect(aiAgentSessions.activeId).toBe(id);
    expect(aiAgentSessions.active?.providerId).toBe('claude');
    expect(aiAgentSessions.active?.mode).toBe('act');
    expect(aiAgentSessions.active?.turns).toEqual([]);
  });

  it('switches agent mode without changing the session uuid', () => {
    const id = aiAgentSessions.create();
    const uuid = aiAgentSessions.active?.sessionUuid;
    aiAgentSessions.setMode(id, 'plan');
    expect(aiAgentSessions.active?.mode).toBe('plan');
    expect(aiAgentSessions.active?.sessionUuid).toBe(uuid);
  });

  it('forks transcript into a new session with provider state', () => {
    const id = aiAgentSessions.create();
    aiAgentSessions.updateTurns(id, [
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two', cards: [] },
      { role: 'user', text: 'three' },
    ]);
    const forkId = aiAgentSessions.fork(id, 1);
    expect(forkId).toBeTruthy();
    expect(aiAgentSessions.activeId).toBe(forkId);
    expect(aiAgentSessions.active?.turns).toHaveLength(2);
    expect(aiAgentSessions.active?.providerState).toEqual({ forkedFrom: id });
    expect(aiAgentSessions.active?.sessionUuid).not.toBe(
      aiAgentSessions.sessions.find((s) => s.id === id)?.sessionUuid,
    );
  });

  it('compacts the active transcript into a single assistant summary', () => {
    const id = aiAgentSessions.create();
    aiAgentSessions.updateTurns(id, [
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'answer', cards: [] },
    ]);
    aiAgentSessions.compactActive('summary');
    expect(aiAgentSessions.active?.turns).toEqual([
      { role: 'assistant', text: 'summary', cards: [] },
    ]);
  });

  it('clearTurns resets transcript and rotates Claude session uuid', () => {
    const id = aiAgentSessions.create();
    const uuid = aiAgentSessions.active?.sessionUuid;
    aiAgentSessions.updateTurns(id, [{ role: 'user', text: 'hello' }]);
    aiAgentSessions.clearTurns(id);
    expect(aiAgentSessions.active?.turns).toEqual([]);
    expect(aiAgentSessions.active?.sessionUuid).not.toBe(uuid);
    expect(killClaudeSession).toHaveBeenCalledWith(uuid);
  });

  it('keeps display text separate from outbound prompt metadata', () => {
    const id = aiAgentSessions.create();
    aiAgentSessions.updateTurns(id, [{
      role: 'user',
      text: '## Context 1: hidden\n\n## User request\nsummarize',
      displayText: 'summarize',
      attachments: [{ id: 'current:/p/a.md', label: 'Current file: a.md', kind: 'current-file' }],
    }]);
    expect(aiAgentSessions.active?.turns[0]).toMatchObject({
      role: 'user',
      text: '## Context 1: hidden\n\n## User request\nsummarize',
      displayText: 'summarize',
    });
    expect(aiAgentSessions.active?.title).toBe('summarize');
  });

  it('stamps the provider from settings onto new sessions', () => {
    aiAgentSettings.update({ providerId: 'codex' });
    const id = aiAgentSessions.create();
    expect(aiAgentSessions.sessions.find((s) => s.id === id)?.providerId).toBe('codex');
  });

  it('clearTurns kills both bridges and drops the Codex thread id', () => {
    const id = aiAgentSessions.create();
    const uuid = aiAgentSessions.active?.sessionUuid;
    aiAgentSessions.patchProviderState(id, { codexThreadId: 'thread-77' });
    aiAgentSessions.clearTurns(id);
    expect(aiAgentSessions.active?.providerState).toEqual({});
    expect(killClaudeSession).toHaveBeenCalledWith(uuid);
    expect(killCodexSession).toHaveBeenCalledWith(uuid);
  });

  it('delete kills both bridges (provider-agnostic)', async () => {
    const id = aiAgentSessions.create();
    const uuid = aiAgentSessions.active?.sessionUuid;
    await aiAgentSessions.delete(id);
    expect(killClaudeSession).toHaveBeenCalledWith(uuid);
    expect(killCodexSession).toHaveBeenCalledWith(uuid);
  });
});
