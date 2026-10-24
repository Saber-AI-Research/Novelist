import { describe, expect, it } from 'vitest';
import { aiTalkSessions, type TalkSession } from '$lib/components/ai-talk/sessions.svelte';

function session(id: string, content: string): TalkSession {
  return { id, title: content, createdAt: 1, updatedAt: 1, messages: [{ role: 'user', content }] };
}

describe('AI Talk project scope', () => {
  it('a project without saved chats starts empty instead of inheriting the previous project', () => {
    aiTalkSessions.enterScope('/projects/A', [session('a1', 'A secret plot')], null);
    expect(aiTalkSessions.ownsProject('/projects/A')).toBe(true);

    const carryOver = aiTalkSessions.releaseScope();
    expect(carryOver).toEqual([]);
    expect(aiTalkSessions.ownsProject('/projects/A')).toBe(false);

    aiTalkSessions.enterScope('/projects/B', carryOver, 'a1');
    expect(aiTalkSessions.sessions).toHaveLength(1);
    expect(aiTalkSessions.sessions[0].messages).toEqual([]);
    expect(aiTalkSessions.sessions.some((s) => s.id === 'a1')).toBe(false);
    expect(aiTalkSessions.ownsProject('/projects/B')).toBe(true);
    expect(aiTalkSessions.ownsProject('/projects/A')).toBe(false);
  });

  it('owns nothing mid-switch, so no project receives the chats on disk', () => {
    aiTalkSessions.enterScope('/projects/A', [session('a1', 'x')], null);
    aiTalkSessions.releaseScope();
    expect(aiTalkSessions.ownsProject('/projects/A')).toBe(false);
    expect(aiTalkSessions.ownsProject(null)).toBe(false);
  });

  it('restores the preferred active chat when the project has it', () => {
    aiTalkSessions.releaseScope();
    aiTalkSessions.enterScope('/projects/A', [session('a1', 'one'), session('a2', 'two')], 'a2');
    expect(aiTalkSessions.activeId).toBe('a2');
  });

  it('offers chats begun with no project open to the next project', () => {
    aiTalkSessions.releaseScope();
    aiTalkSessions.enterScope(null, [], null);
    const scratch = aiTalkSessions.activeId!;
    aiTalkSessions.updateMessages(scratch, [{ role: 'user', content: 'no-project idea' }]);
    const carryOver = aiTalkSessions.releaseScope();
    expect(carryOver.map((s) => s.id)).toEqual([scratch]);
  });

  it('defers a "new chat" request until the panel has loaded the project', () => {
    aiTalkSessions.releaseScope();
    aiTalkSessions.requestNewSession();
    expect(aiTalkSessions.sessions).toEqual([]);
    const detach = aiTalkSessions.attach();
    aiTalkSessions.enterScope('/projects/A', [session('a1', 'old')], 'a1');
    expect(aiTalkSessions.sessions).toHaveLength(2);
    expect(aiTalkSessions.active?.messages).toEqual([]);
    // Once loaded, a request creates the chat immediately.
    aiTalkSessions.requestNewSession();
    expect(aiTalkSessions.sessions).toHaveLength(3);
    detach();
  });
});
