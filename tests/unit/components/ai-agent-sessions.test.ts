import { describe, expect, it, beforeEach, vi } from 'vitest';

const { killClaudeSession, killCodexSession } = vi.hoisted(() => ({
  killClaudeSession: vi.fn().mockResolvedValue(undefined),
  killCodexSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/components/ai-agent/host', () => ({
  killClaudeSession,
  killCodexSession,
}));

import {
  aiAgentSessions,
  sanitizeAgentProviderPayload,
  sanitizeAgentTurnFailureMessage,
} from '$lib/components/ai-agent/sessions.svelte';
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

  it('compacts the requested session even when another session is active', () => {
    const sourceId = aiAgentSessions.create();
    aiAgentSessions.updateTurns(sourceId, [
      { role: 'user', text: 'source question' },
      { role: 'assistant', text: 'source answer', cards: [] },
    ]);
    const otherId = aiAgentSessions.create();
    aiAgentSessions.updateTurns(otherId, [{ role: 'user', text: 'other session' }]);

    aiAgentSessions.compact(sourceId, 'source summary');

    expect(aiAgentSessions.sessions.find((session) => session.id === sourceId)?.turns).toEqual([
      { role: 'assistant', text: 'source summary', cards: [] },
    ]);
    expect(aiAgentSessions.activeId).toBe(otherId);
    expect(aiAgentSessions.active?.turns).toEqual([{ role: 'user', text: 'other session' }]);
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

  it('keeps failures on two turns independent and retries only the selected turn', () => {
    const sessionId = aiAgentSessions.create();
    const firstTurnId = aiAgentSessions.startTurn(sessionId, {
      text: 'first outbound prompt',
      displayText: '第一轮',
    });
    const secondTurnId = aiAgentSessions.startTurn(sessionId, {
      text: 'second outbound prompt',
      displayText: '第二轮',
    });

    aiAgentSessions.failTurn(sessionId, firstTurnId, 'stream', '第一轮流失败');
    aiAgentSessions.failTurn(sessionId, secondTurnId, 'tool', '第二轮工具失败');

    const retryRequest = aiAgentSessions.retryTurn(sessionId, firstTurnId);
    const firstAssistant = aiAgentSessions.active?.turns.find(
      (turn) => turn.role === 'assistant' && turn.turnId === firstTurnId,
    );
    const secondAssistant = aiAgentSessions.active?.turns.find(
      (turn) => turn.role === 'assistant' && turn.turnId === secondTurnId,
    );

    expect(retryRequest).toMatchObject({
      role: 'user',
      turnId: firstTurnId,
      text: 'first outbound prompt',
      displayText: '第一轮',
    });
    expect(firstAssistant).toMatchObject({
      role: 'assistant',
      turnId: firstTurnId,
      status: 'streaming',
      text: '',
      cards: [],
    });
    expect(firstAssistant).not.toHaveProperty('failure');
    expect(secondAssistant).toMatchObject({
      role: 'assistant',
      turnId: secondTurnId,
      status: 'failed',
      failure: { stage: 'tool', message: '第二轮工具失败' },
    });
  });

  it('replaces one pending-context request in place before retry without duplicating prior turns', () => {
    const sessionId = aiAgentSessions.create();
    const completedTurnId = aiAgentSessions.startTurn(sessionId, {
      text: '先前成功的出站提示',
      displayText: '先前成功轮次',
    });
    aiAgentSessions.completeTurn(sessionId, completedTurnId);
    const sourceText = '@file:Chapter 请保留这段中文重试提示。';
    const pendingTurnId = aiAgentSessions.startTurn(sessionId, {
      text: sourceText,
      displayText: sourceText,
      sourceText,
      contextState: 'pending',
    });
    aiAgentSessions.failTurn(
      sessionId,
      pendingTurnId,
      'context',
      '读取失败 Authorization: Bearer CONTEXT_SECRET 后续中文',
    );
    const failedSerialized = JSON.stringify(aiAgentSessions.snapshot());
    expect(failedSerialized).toContain(sourceText);
    expect(failedSerialized).not.toContain('CONTEXT_SECRET');
    expect(failedSerialized).toContain('[REDACTED]');

    const retried = aiAgentSessions.retryTurn(sessionId, pendingTurnId, {
      text: '## Context 1: Chapter 1\n\n当前权威正文\n\n## User request\n请保留这段中文重试提示。',
      displayText: '请保留这段中文重试提示。',
      sourceText,
      contextState: 'resolved',
      attachments: [{
        id: 'file:/project/Chapter 1.md',
        label: 'File: Chapter 1.md',
        kind: 'project-file',
        path: '/project/Chapter 1.md',
      }],
    });

    expect(retried).toMatchObject({
      role: 'user',
      turnId: pendingTurnId,
      text: expect.stringContaining('当前权威正文'),
      displayText: '请保留这段中文重试提示。',
      sourceText,
      contextState: 'resolved',
    });
    expect(aiAgentSessions.active?.turns).toHaveLength(4);
    expect(aiAgentSessions.active?.turns[0]).toMatchObject({
      role: 'user',
      turnId: completedTurnId,
      text: '先前成功的出站提示',
    });
    expect(aiAgentSessions.active?.turns[1]).toMatchObject({
      role: 'assistant',
      turnId: completedTurnId,
      status: 'complete',
    });
    expect(aiAgentSessions.active?.turns[3]).toMatchObject({
      role: 'assistant',
      turnId: pendingTurnId,
      status: 'streaming',
      cards: [],
    });
    expect(aiAgentSessions.active?.turns[3]).not.toHaveProperty('failure');
    const serialized = JSON.stringify(aiAgentSessions.snapshot());
    expect(serialized).toContain(sourceText);
    expect(serialized).not.toContain('CONTEXT_SECRET');
  });

  it('marks only the active turn as stopped and leaves completed turns intact', () => {
    const sessionId = aiAgentSessions.create();
    const completedTurnId = aiAgentSessions.startTurn(sessionId, { text: 'done' });
    aiAgentSessions.completeTurn(sessionId, completedTurnId);
    const stoppedTurnId = aiAgentSessions.startTurn(sessionId, { text: 'stop me' });

    aiAgentSessions.stopTurn(sessionId, stoppedTurnId);

    expect(aiAgentSessions.active?.turns.find(
      (turn) => turn.role === 'assistant' && turn.turnId === completedTurnId,
    )).toMatchObject({ status: 'complete' });
    expect(aiAgentSessions.active?.turns.find(
      (turn) => turn.role === 'assistant' && turn.turnId === stoppedTurnId,
    )).toMatchObject({ status: 'stopped' });
  });

  it('restores persisted streaming turns as stopped after the runtime is gone', () => {
    aiAgentSessions.replaceAll([{
      id: 'restored-session',
      providerId: 'claude',
      mode: 'act',
      title: 'Interrupted draft',
      createdAt: 1,
      updatedAt: 2,
      sessionUuid: 'restored-uuid',
      turns: [
        { role: 'user', turnId: 'turn-1', text: 'continue' },
        {
          role: 'assistant',
          turnId: 'turn-1',
          text: 'partial response',
          cards: [],
          status: 'streaming',
        },
      ],
    }], 'restored-session');

    expect(aiAgentSessions.active?.turns[1]).toMatchObject({
      role: 'assistant',
      turnId: 'turn-1',
      text: 'partial response',
      status: 'stopped',
    });
  });

  it('sanitizes new failure excerpts while preserving ordinary CJK text', () => {
    const sessionId = aiAgentSessions.create();
    const turnId = aiAgentSessions.startTurn(sessionId, { text: '测试' });

    aiAgentSessions.failTurn(
      sessionId,
      turnId,
      'stream',
      '连接失败：权限不足\u0000 Bearer abc.def.ghi token=secret123 https://alice:pass@example.com/?api_key=hidden',
    );

    const failure = aiAgentSessions.active?.turns.find(
      (turn) => turn.role === 'assistant' && turn.turnId === turnId,
    );
    expect(failure).toMatchObject({
      failure: {
        stage: 'stream',
        message: expect.stringContaining('连接失败：权限不足'),
      },
    });
    const message = failure?.role === 'assistant' ? failure.failure?.message ?? '' : '';
    expect(message).not.toContain('\u0000');
    expect(message).not.toContain('abc.def.ghi');
    expect(message).not.toContain('secret123');
    expect(message).not.toContain('alice:pass');
    expect(message).not.toContain('hidden');
    expect(message).toContain('[REDACTED]');
  });

  it('redacts quoted JSON credential fields in new failure excerpts', () => {
    const sanitized = sanitizeAgentTurnFailureMessage(
      '{"token":"secret123","api_key":"hidden","message":"普通错误"}',
    );

    expect(sanitized).not.toContain('secret123');
    expect(sanitized).not.toContain('hidden');
    expect(sanitized).toContain('普通错误');
    expect(sanitized.match(/\[REDACTED\]/gu)).toHaveLength(2);
  });

  it('redacts quoted and control-split credentials without losing CJK context', () => {
    const excerpts = [
      sanitizeAgentTurnFailureMessage('{"token":"json-secret","message":"普通错误"}'),
      sanitizeAgentTurnFailureMessage("{'api_key':'single-secret','message':'普通错误'}"),
      sanitizeAgentTurnFailureMessage('请求失败 Bearer x\u0000actual-secret 后续中文'),
      sanitizeAgentTurnFailureMessage('认证失败 Basic x\nbase64-secret 后续中文'),
    ];

    expect(excerpts.every((message) => message.includes('[REDACTED]'))).toBe(true);
    expect(excerpts.every((message) => message.includes('普通错误') || message.includes('后续中文'))).toBe(true);
    expect(excerpts.join('\n')).not.toMatch(/json-secret|single-secret|actual-secret|base64-secret/u);
  });

  it('redacts credential names split by control and format characters', () => {
    const message = sanitizeAgentTurnFailureMessage(
      '读取失败 to\u200Bken=TEXT_SECRET Authoriz\u0000ation=AUTH_SECRET 后续中文',
    );
    const payload = sanitizeAgentProviderPayload({
      'to\u200Bken': 'PAYLOAD_TOKEN_SECRET',
      'Authoriz\u0000ation': 'PAYLOAD_AUTH_SECRET',
    }) as Record<string, unknown>;

    expect(message).toContain('后续中文');
    expect(message).not.toMatch(/TEXT_SECRET|AUTH_SECRET/u);
    expect(payload['to\u200Bken']).toBe('[REDACTED]');
    expect(payload['Authoriz\u0000ation']).toBe('[REDACTED]');
  });

  it('redacts control and format separated credential forms before persistence', () => {
    const cases = [
      { input: '写入失败 token=part1\u0000part2 后续中文', forbidden: ['part1', 'part2'] },
      { input: '请求失败 ?api_key=part1\u0000part2&mode=test 后续中文', forbidden: ['part1', 'part2'] },
      { input: '认证失败 api_key=abc\ndef 后续中文', forbidden: ['abc def'] },
      { input: '连接失败 https://alice:pa\u0000ss@example.com/ 后续中文', forbidden: ['alice', 'ss@example.com'] },
      { input: '模型失败 API key: sk-example-secret 后续中文', forbidden: ['sk-example-secret'] },
      { input: '认证失败 Bearer\u200Bexample-secret 后续中文', forbidden: ['example-secret'] },
      { input: '发布失败 Ghost token: example-secret 后续中文', forbidden: ['example-secret'] },
      { input: '{"token":"part1\\\"part2","message":"普通错误"}', forbidden: ['part1', 'part2'] },
      { input: '认证失败 client\u200B_secret=client\u0000secret 后续中文', forbidden: ['_secret=client', 'client secret'] },
    ];

    const sessionId = aiAgentSessions.create();
    for (const [index, testCase] of cases.entries()) {
      const sanitized = sanitizeAgentTurnFailureMessage(testCase.input);
      expect(sanitized).toContain('[REDACTED]');
      expect(sanitized).toMatch(/后续中文|普通错误/u);
      for (const fragment of testCase.forbidden) expect(sanitized).not.toContain(fragment);

      const turnId = aiAgentSessions.startTurn(sessionId, { text: `case-${index}` });
      aiAgentSessions.failTurn(sessionId, turnId, 'stream', testCase.input);
    }

    const serialized = JSON.stringify(aiAgentSessions.snapshot());
    for (const testCase of cases) {
      for (const fragment of testCase.forbidden) expect(serialized).not.toContain(fragment);
    }
    const restored = JSON.parse(serialized) as ReturnType<typeof aiAgentSessions.snapshot>;
    aiAgentSessions.replaceAll(restored.sessions, restored.activeId);
    const restoredSerialized = JSON.stringify(aiAgentSessions.snapshot());
    for (const testCase of cases) {
      for (const fragment of testCase.forbidden) expect(restoredSerialized).not.toContain(fragment);
    }
  });

  it('redacts authorization headers, separator controls, and unterminated quoted values', () => {
    const cases = [
      { input: 'Authorization: Bearer actual-secret', forbidden: ['actual-secret'] },
      { input: 'Authorization: Basic base64-secret', forbidden: ['base64-secret'] },
      { input: 'Authorization: Token actual-secret', forbidden: ['actual-secret'] },
      { input: 'Authorization: Ghost actual-secret', forbidden: ['actual-secret'] },
      { input: 'api_key\u0000=part1\u0000part2', forbidden: ['part1', 'part2'] },
      { input: 'token="secret with-space', forbidden: ['secret', 'with-space'] },
    ];

    const sessionId = aiAgentSessions.create();
    for (const [index, testCase] of cases.entries()) {
      const sanitized = sanitizeAgentTurnFailureMessage(testCase.input);
      expect(sanitized).toContain('[REDACTED]');
      for (const fragment of testCase.forbidden) expect(sanitized).not.toContain(fragment);

      const turnId = aiAgentSessions.startTurn(sessionId, { text: `final-case-${index}` });
      aiAgentSessions.failTurn(sessionId, turnId, 'stream', testCase.input);
    }

    const serialized = JSON.stringify(aiAgentSessions.snapshot());
    for (const testCase of cases) {
      for (const fragment of testCase.forbidden) expect(serialized).not.toContain(fragment);
    }
    const restored = JSON.parse(serialized) as ReturnType<typeof aiAgentSessions.snapshot>;
    aiAgentSessions.replaceAll(restored.sessions, restored.activeId);
    const restoredSerialized = JSON.stringify(aiAgentSessions.snapshot());
    for (const testCase of cases) {
      for (const fragment of testCase.forbidden) expect(restoredSerialized).not.toContain(fragment);
    }
  });

  it('redacts whole Authorization values and punctuation-bearing assignments before persistence', () => {
    const cases = [
      {
        input: 'Authorization: Digest username=alice, response=SECRET_RESPONSE',
        expected: 'Authorization: [REDACTED]',
        forbidden: ['Digest', 'alice', 'SECRET_RESPONSE'],
      },
      {
        input: 'Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE, Signature=SECRET_SIGNATURE',
        expected: 'Authorization: [REDACTED]',
        forbidden: ['AWS4-HMAC-SHA256', 'AKIAEXAMPLE', 'SECRET_SIGNATURE'],
      },
      {
        input: 'password=!SuperSecret; 后续中文',
        expected: 'password=[REDACTED]; 后续中文',
        forbidden: ['!SuperSecret'],
      },
      {
        input: 'token="abc!SECRET_TAIL',
        expected: 'token="[REDACTED]"',
        forbidden: ['abc', 'SECRET_TAIL'],
      },
    ];

    const sessionId = aiAgentSessions.create();
    for (const [index, testCase] of cases.entries()) {
      const sanitized = sanitizeAgentTurnFailureMessage(testCase.input);
      expect.soft(sanitized).toBe(testCase.expected);
      for (const fragment of testCase.forbidden) expect.soft(sanitized).not.toContain(fragment);

      const turnId = aiAgentSessions.startTurn(sessionId, { text: `boundary-case-${index}` });
      aiAgentSessions.failTurn(sessionId, turnId, 'stream', testCase.input);
    }

    const snapshot = aiAgentSessions.snapshot();
    const persistedMessages = snapshot.sessions
      .find((session) => session.id === sessionId)?.turns
      .flatMap((turn) => turn.role === 'assistant' && turn.failure ? [turn.failure.message] : []) ?? [];
    expect(persistedMessages).toEqual(cases.map((testCase) => testCase.expected));

    const restored = JSON.parse(JSON.stringify(snapshot)) as ReturnType<typeof aiAgentSessions.snapshot>;
    aiAgentSessions.replaceAll(restored.sessions, restored.activeId);
    const restoredMessages = aiAgentSessions.snapshot().sessions
      .find((session) => session.id === sessionId)?.turns
      .flatMap((turn) => turn.role === 'assistant' && turn.failure ? [turn.failure.message] : []) ?? [];
    expect(restoredMessages).toEqual(cases.map((testCase) => testCase.expected));
  });

  it('redacts split and folded Authorization plus no-whitespace delimiter secrets after restore', () => {
    const cases = [
      {
        input: 'Authoriz\u200Bation: Digest username=alice, response=ZWSP_RESPONSE_SECRET',
        expected: 'Authorization: [REDACTED]',
      },
      {
        input: [
          'Authorization: AWS4-HMAC-SHA256 Credential=AKIAFOLDED',
          ' Signature=FOLDED_SIGNATURE_SECRET',
          '后续中文',
        ].join('\n'),
        expected: 'Authorization: [REDACTED] 后续中文',
      },
      {
        input: 'password=abc;SECRET_TAIL',
        expected: 'password=[REDACTED]',
      },
    ];

    const sessionId = aiAgentSessions.create();
    for (const [index, testCase] of cases.entries()) {
      expect.soft(sanitizeAgentTurnFailureMessage(testCase.input)).toBe(testCase.expected);
      const turnId = aiAgentSessions.startTurn(sessionId, { text: `folded-boundary-${index}` });
      aiAgentSessions.failTurn(sessionId, turnId, 'stream', testCase.input);
    }

    const snapshot = aiAgentSessions.snapshot();
    const persistedMessages = snapshot.sessions
      .find((session) => session.id === sessionId)?.turns
      .flatMap((turn) => turn.role === 'assistant' && turn.failure ? [turn.failure.message] : []) ?? [];
    expect.soft(persistedMessages).toEqual(cases.map((testCase) => testCase.expected));

    const restored = JSON.parse(JSON.stringify(snapshot)) as ReturnType<typeof aiAgentSessions.snapshot>;
    aiAgentSessions.replaceAll(restored.sessions, restored.activeId);
    const restoredMessages = aiAgentSessions.snapshot().sessions
      .find((session) => session.id === sessionId)?.turns
      .flatMap((turn) => turn.role === 'assistant' && turn.failure ? [turn.failure.message] : []) ?? [];
    expect.soft(restoredMessages).toEqual(cases.map((testCase) => testCase.expected));
  });

  it('fully redacts long unterminated quoted credentials through a clear delimiter or end', () => {
    const cases = [513, 700].flatMap((length) => {
      const credential = 'x'.repeat(length);
      return [
        {
          input: `token="${credential}`,
          expected: 'token="[REDACTED]"',
        },
        {
          input: `token="${credential}; 后续中文`,
          expected: 'token="[REDACTED]"; 后续中文',
        },
      ];
    });

    const sessionId = aiAgentSessions.create();
    for (const [index, testCase] of cases.entries()) {
      const sanitized = sanitizeAgentTurnFailureMessage(testCase.input);
      expect.soft(sanitized).toBe(testCase.expected);
      expect.soft(sanitized).not.toContain('x');
      expect.soft(Array.from(sanitized).length).toBeLessThanOrEqual(512);

      const turnId = aiAgentSessions.startTurn(sessionId, { text: `long-boundary-${index}` });
      aiAgentSessions.failTurn(sessionId, turnId, 'stream', testCase.input);
    }

    const serialized = JSON.stringify(aiAgentSessions.snapshot());
    expect.soft(serialized).not.toContain('x'.repeat(32));
    expect.soft(serialized.match(/后续中文/gu)).toHaveLength(2);
    const restored = JSON.parse(serialized) as ReturnType<typeof aiAgentSessions.snapshot>;
    aiAgentSessions.replaceAll(restored.sessions, restored.activeId);
    const restoredSerialized = JSON.stringify(aiAgentSessions.snapshot());
    expect.soft(restoredSerialized).not.toContain('x'.repeat(32));
    expect.soft(restoredSerialized.match(/后续中文/gu)).toHaveLength(2);
  });

  it('bounds failure excerpts to 512 Unicode code points including the ellipsis', () => {
    const source = `${'🙂'.repeat(510)}${'秘密'.repeat(20)}`;
    const sanitized = sanitizeAgentTurnFailureMessage(source);

    expect(Array.from(sanitized)).toHaveLength(512);
    expect(sanitized.endsWith('…')).toBe(true);
    expect(sanitized).not.toContain('\uFFFD');
  });

  it('recursively sanitizes provider payload strings while preserving JSON shape and CJK', () => {
    const sanitized = sanitizeAgentProviderPayload({
      type: 'command_execution',
      command: 'curl -H "Authorization: Bearer COMMAND_SECRET" https://example.com',
      args: [
        '普通参数',
        {
          password: 'password=abc;NESTED_SECRET_TAIL',
          endpoint: 'https://alice:URL_PASSWORD@example.com/?api_key=QUERY_SECRET',
        },
      ],
      metadata: {
        json: '{"token":"JSON_SECRET","message":"后续中文"}',
        ok: false,
        exitCode: 7,
        empty: null,
      },
    });

    expect(sanitized).toEqual({
      type: 'command_execution',
      command: 'curl -H "Authorization: [REDACTED]',
      args: [
        '普通参数',
        {
          password: '[REDACTED]',
          endpoint: 'https://[REDACTED]@example.com/?api_key=[REDACTED]',
        },
      ],
      metadata: {
        json: '{"token":"[REDACTED]","message":"后续中文"}',
        ok: false,
        exitCode: 7,
        empty: null,
      },
    });
  });

  it('redacts bare credential-key values without matching safe lookalikes', () => {
    const sanitized = sanitizeAgentProviderPayload({
      password: 'BARE_PASSWORD',
      passwd: 12345,
      token: false,
      access_token: ['BARE_ACCESS_TOKEN'],
      api_key: { raw: 'BARE_API_KEY' },
      clientSecret: 'BARE_CLIENT_SECRET',
      secret: 'BARE_SECRET',
      credential: { raw: 'BARE_CREDENTIAL' },
      credentials: null,
      AWS_SECRET_ACCESS_KEY: 'BARE_AWS_SECRET',
      Authorization: 'BARE_AUTHORIZATION',
      cookie: 'BARE_COOKIE',
      token_count: 42,
      tokenizer: '普通 tokenizer',
      password_hint: '普通密码提示',
      api_key_name: '普通键名',
      secret_count: 3,
      credential_status: '普通状态',
    });

    expect(sanitized).toEqual({
      password: '[REDACTED]',
      passwd: '[REDACTED]',
      token: '[REDACTED]',
      access_token: '[REDACTED]',
      api_key: '[REDACTED]',
      clientSecret: '[REDACTED]',
      secret: '[REDACTED]',
      credential: '[REDACTED]',
      credentials: '[REDACTED]',
      AWS_SECRET_ACCESS_KEY: '[REDACTED]',
      Authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      token_count: 42,
      tokenizer: '普通 tokenizer',
      password_hint: '普通密码提示',
      api_key_name: '普通键名',
      secret_count: 3,
      credential_status: '普通状态',
    });
  });

  it('bounds deep, wide, and cyclic provider payloads without retaining omitted secrets', () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 80; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.secret = 'Authorization: Bearer DEEP_PROVIDER_SECRET';

    const cyclic: Record<string, unknown> = {
      message: 'password=CYCLIC_PROVIDER_SECRET',
    };
    cyclic.self = cyclic;
    const wide = Array.from(
      { length: 3000 },
      (_, index) => index === 2999 ? 'token=WIDE_PROVIDER_SECRET' : `普通-${index}`,
    );

    const sanitized = sanitizeAgentProviderPayload({ wide, deep, cyclic });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toMatch(/DEEP_PROVIDER_SECRET|CYCLIC_PROVIDER_SECRET|WIDE_PROVIDER_SECRET/u);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized.length).toBeLessThan(40_000);
  });

  it('sanitizes restored diagnostics while preserving prose and Apply file text', () => {
    const historical = 'Bearer historical-secret';
    aiAgentSessions.replaceAll([{
      id: 'history',
      providerId: 'claude',
      mode: 'act',
      title: 'History',
      createdAt: 1,
      updatedAt: 1,
      sessionUuid: 'history-uuid',
      turns: [{
        role: 'user',
        turnId: 'history-user',
        text: '用户 password=原文密码',
        displayText: '用户显示 token=原文令牌',
      }, {
        role: 'assistant',
        turnId: 'history-turn',
        text: '助手原文 password=不可改写',
        cards: [
          {
            kind: 'tool',
            name: 'legacy',
            input: { password: 'historical-bare-password', token_count: 7 },
          },
          { kind: 'tool-result', content: historical, status: 'success' },
          {
            kind: 'apply-changes',
            changeSet: {
              id: 'history-change',
              sourceSessionId: 'history',
              createdAt: '2026-07-17T00:00:00.000Z',
              summary: 'Apply 原文',
              files: [{
                path: '/tmp/chapter.md',
                status: 'modify',
                originalText: 'password=原始文件内容',
                proposedText: 'token=建议文件内容',
                hunks: [],
              }],
            },
          },
        ],
        status: 'failed',
        failure: { stage: 'tool', message: historical },
      }],
    }], 'history');

    const restored = aiAgentSessions.active;
    expect(restored?.turns[0]).toMatchObject({
      text: '用户 password=原文密码',
      displayText: '用户显示 token=原文令牌',
    });
    expect(restored?.turns[1]).toMatchObject({
      text: '助手原文 password=不可改写',
      failure: { message: 'Bearer [REDACTED]' },
      cards: [
        { kind: 'tool', input: { password: '[REDACTED]', token_count: 7 } },
        { kind: 'tool-result', content: 'Bearer [REDACTED]' },
        {
          kind: 'apply-changes',
          changeSet: {
            files: [{
              originalText: 'password=原始文件内容',
              proposedText: 'token=建议文件内容',
            }],
          },
        },
      ],
    });
  });

  it('drops unknown restored fields and duplicate session identities', () => {
    const base = {
      id: 'restored-safe-id',
      providerId: 'claude',
      mode: 'act',
      title: 'Restored',
      createdAt: 1,
      updatedAt: 2,
      sessionUuid: 'restored-safe-uuid',
      providerState: { 'to\u200Bken': 'PROVIDER_STATE_SECRET' },
      unknownCredential: 'SESSION_UNKNOWN_SECRET',
      turns: [{
        role: 'user',
        turnId: 'restored-turn',
        text: '普通用户原文',
        unknownCredential: 'TURN_UNKNOWN_SECRET',
      }],
    };
    const duplicateId = {
      ...base,
      sessionUuid: 'duplicate-id-uuid',
      title: 'Duplicate id',
    };
    const duplicateUuid = {
      ...base,
      id: 'duplicate-uuid-id',
      title: 'Duplicate uuid',
    };

    aiAgentSessions.replaceAll(
      [base, duplicateId, duplicateUuid] as Parameters<typeof aiAgentSessions.replaceAll>[0],
      base.id,
    );

    expect(aiAgentSessions.sessions).toHaveLength(1);
    expect(aiAgentSessions.activeId).toBe(base.id);
    expect(aiAgentSessions.active?.providerState).toEqual({ 'to\u200Bken': '[REDACTED]' });
    const serialized = JSON.stringify(aiAgentSessions.snapshot());
    expect(serialized).not.toMatch(/PROVIDER_STATE_SECRET|SESSION_UNKNOWN_SECRET|TURN_UNKNOWN_SECRET/u);
    expect(serialized).not.toContain('unknownCredential');
  });

  it('sanitizes bridge cleanup errors before logging', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    killClaudeSession.mockRejectedValueOnce(new Error('token=BRIDGE_CLEANUP_SECRET'));
    const sessionId = aiAgentSessions.create();

    try {
      await aiAgentSessions.delete(sessionId);
      await vi.waitFor(() => expect(warning).toHaveBeenCalled());
      expect(warning).toHaveBeenCalledWith(
        '[ai-agent] Claude bridge cleanup failed',
        'token=[REDACTED]',
      );
    } finally {
      warning.mockRestore();
    }
  });
});
