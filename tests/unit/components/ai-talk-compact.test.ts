import { beforeEach, describe, expect, it } from 'vitest';
import { collectCompactionSummary } from '$lib/components/ai-talk/compact';
import type { AiStreamEvent } from '$lib/components/ai-talk/host';
import { aiTalkSessions, type DisplayMessage } from '$lib/components/ai-talk/sessions.svelte';

async function* stream(events: AiStreamEvent[]): AsyncGenerator<AiStreamEvent> {
  for (const ev of events) yield ev;
}

function chunk(content: string): AiStreamEvent {
  return { kind: 'chunk', data: JSON.stringify({ choices: [{ delta: { content } }] }) };
}

const history: DisplayMessage[] = [
  { role: 'user', content: '主角叫什么？' },
  { role: 'assistant', content: '林晚。' },
  { role: 'user', content: '她住在哪里？' },
];

describe('collectCompactionSummary', () => {
  it('returns the summary of a finished stream', async () => {
    const result = await collectCompactionSummary(stream([chunk('主角：林晚'), chunk('，住在江南。'), { kind: 'done' }]));
    expect(result).toEqual({ ok: true, summary: '主角：林晚，住在江南。' });
  });

  it('fails on an error event (401/429) even after partial output', async () => {
    const result = await collectCompactionSummary(
      stream([chunk('partial'), { kind: 'error', message: 'Too Many Requests', status: 429 }]),
    );
    expect(result).toEqual({ ok: false, reason: 'error', message: 'Too Many Requests', status: 429 });
  });

  it('fails when the user stops the stream', async () => {
    const result = await collectCompactionSummary(stream([{ kind: 'error', message: 'cancelled' }]));
    expect(result.ok).toBe(false);
  });

  it('fails on an empty reply instead of producing a placeholder summary', async () => {
    expect(await collectCompactionSummary(stream([chunk('  '), { kind: 'done' }]))).toEqual({ ok: false, reason: 'empty' });
  });

  it('fails when the stream ends without finishing', async () => {
    expect(await collectCompactionSummary(stream([chunk('half')]))).toEqual({ ok: false, reason: 'incomplete' });
  });
});

describe('aiTalkSessions.compact', () => {
  beforeEach(() => {
    aiTalkSessions.sessions = [];
    aiTalkSessions.activeId = null;
  });

  it('compacts the session it was started for, not whichever is active when the reply lands', () => {
    const compacted = aiTalkSessions.create();
    aiTalkSessions.updateMessages(compacted, history);
    const other = aiTalkSessions.create();
    aiTalkSessions.updateMessages(other, [{ role: 'user', content: 'other chat' }]);
    expect(aiTalkSessions.activeId).toBe(other);

    aiTalkSessions.compact(compacted, 'summary');

    expect(aiTalkSessions.sessions.find((s) => s.id === compacted)?.messages).toEqual([
      { role: 'system', content: 'summary' },
    ]);
    expect(aiTalkSessions.sessions.find((s) => s.id === other)?.messages).toEqual([
      { role: 'user', content: 'other chat' },
    ]);
  });

  it('ignores a session that no longer exists', () => {
    const kept = aiTalkSessions.create();
    aiTalkSessions.updateMessages(kept, history);
    aiTalkSessions.compact('gone', 'summary');
    expect(aiTalkSessions.sessions.find((s) => s.id === kept)?.messages).toEqual(history);
  });
});
