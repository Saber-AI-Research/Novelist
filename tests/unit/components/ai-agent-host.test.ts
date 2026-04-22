import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claudeCliDetect, claudeCliSpawn, claudeCliSend, claudeCliKill, listen } = vi.hoisted(() => ({
  claudeCliDetect: vi.fn(),
  claudeCliSpawn: vi.fn(),
  claudeCliSend: vi.fn(),
  claudeCliKill: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('$lib/ipc/commands', () => ({
  commands: { claudeCliDetect, claudeCliSpawn, claudeCliSend, claudeCliKill },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen }));

import {
  parseClaudeLine,
  userInputLine,
  detectClaudeCli,
  spawnClaudeSession,
  sendToClaude,
  killClaudeSession,
  listenClaudeStream,
} from '$lib/components/ai-agent/host';

beforeEach(() => {
  claudeCliDetect.mockReset();
  claudeCliSpawn.mockReset();
  claudeCliSend.mockReset();
  claudeCliKill.mockReset();
  listen.mockReset();
});

describe('ai-agent stream-json parser', () => {
  it('returns null for blank lines', () => {
    expect(parseClaudeLine('')).toBeNull();
    expect(parseClaudeLine('   ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseClaudeLine('not json')).toBeNull();
  });

  it('extracts a text-delta from a partial-message stream_event', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    expect(parseClaudeLine(line)).toEqual({ kind: 'text-delta', text: 'Hello' });
  });

  it('extracts text + tool_use blocks from a structured assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Sure, running ls.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: 'assistant-block',
      blocks: [
        { type: 'text', text: 'Sure, running ls.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    });
  });

  it('surfaces a tool_result inside a user-shaped message', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', content: 'file1\nfile2' }],
      },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: 'tool-result',
      content: 'file1\nfile2',
    });
  });

  it('parses a final result envelope with cost', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'All done.',
      total_cost_usd: 0.0123,
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: 'result',
      text: 'All done.',
      cost: 0.0123,
    });
  });

  it('falls through unknown stream_event subtypes', () => {
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'unknown' } });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('builds a stream-json user input envelope', () => {
    const line = userInputLine('hello world');
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello world' }],
      },
    });
  });

  it('user message with no tool_result falls through to null', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('system message passes through data verbatim', () => {
    const msg = { type: 'system', subtype: 'init', tools: ['Read'] };
    const parsed = parseClaudeLine(JSON.stringify(msg));
    expect(parsed).toEqual({ kind: 'system', data: msg });
  });

  it('result with non-string result field falls back to empty text', () => {
    const parsed = parseClaudeLine(JSON.stringify({ type: 'result', result: null }));
    expect(parsed).toEqual({ kind: 'result', text: '', cost: undefined });
  });

  it('returns null for unknown top-level types', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'mystery' }))).toBeNull();
  });

  it('serializes non-string tool_result content as JSON', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: { ok: true } }] },
    });
    expect(parseClaudeLine(line)).toEqual({
      kind: 'tool-result',
      content: '{"ok":true}',
    });
  });
});

describe('[contract] host bridge wrappers', () => {
  it('detectClaudeCli returns the payload or null', async () => {
    claudeCliDetect.mockResolvedValueOnce({ path: '/bin/claude', version: '1.0' });
    await expect(detectClaudeCli()).resolves.toEqual({ path: '/bin/claude', version: '1.0' });
    claudeCliDetect.mockResolvedValueOnce(undefined);
    await expect(detectClaudeCli()).resolves.toBeNull();
  });

  it('spawnClaudeSession maps camelCase args to snake_case and returns the session id', async () => {
    claudeCliSpawn.mockResolvedValue({ status: 'ok', data: 'sess-42' });
    const id = await spawnClaudeSession({
      sessionUuid: 'uuid-1',
      cwd: '/proj',
      cliPath: '/bin/claude',
      systemPrompt: 'hi',
      model: 'opus',
      permissionMode: 'acceptEdits',
      addDirs: ['/a', '/b'],
    });
    expect(id).toBe('sess-42');
    expect(claudeCliSpawn).toHaveBeenCalledWith({
      cli_path: '/bin/claude',
      cwd: '/proj',
      system_prompt: 'hi',
      add_dirs: ['/a', '/b'],
      permission_mode: 'acceptEdits',
      model: 'opus',
      session_uuid: 'uuid-1',
      extra_args: [],
    });
  });

  it('spawnClaudeSession defaults optional args to null / empty', async () => {
    claudeCliSpawn.mockResolvedValue({ status: 'ok', data: 'sess-x' });
    await spawnClaudeSession({ sessionUuid: 'uuid-x' });
    expect(claudeCliSpawn).toHaveBeenCalledWith({
      cli_path: null,
      cwd: null,
      system_prompt: null,
      add_dirs: [],
      permission_mode: null,
      model: null,
      session_uuid: 'uuid-x',
      extra_args: [],
    });
  });

  it('spawnClaudeSession throws when Rust returns an error', async () => {
    claudeCliSpawn.mockResolvedValue({ status: 'error', error: 'not installed' });
    await expect(spawnClaudeSession({ sessionUuid: 'u' })).rejects.toThrow('not installed');
  });

  it('sendToClaude resolves on ok and throws on error', async () => {
    claudeCliSend.mockResolvedValue({ status: 'ok', data: null });
    await expect(sendToClaude('s', 'line')).resolves.toBeUndefined();
    claudeCliSend.mockResolvedValue({ status: 'error', error: 'pipe closed' });
    await expect(sendToClaude('s', 'line')).rejects.toThrow('pipe closed');
  });

  it('killClaudeSession resolves on ok and throws on error', async () => {
    claudeCliKill.mockResolvedValue({ status: 'ok', data: null });
    await expect(killClaudeSession('s')).resolves.toBeUndefined();
    claudeCliKill.mockResolvedValue({ status: 'error', error: 'gone' });
    await expect(killClaudeSession('s')).rejects.toThrow('gone');
  });

  it('listenClaudeStream subscribes to the per-session channel and unwraps the payload', async () => {
    const unlisten = vi.fn();
    let captured: any = null;
    listen.mockImplementation(async (_channel: string, cb: any) => {
      captured = cb;
      return unlisten;
    });
    const handler = vi.fn();
    const result = await listenClaudeStream('sess-7', handler);
    expect(listen).toHaveBeenCalledWith('claude-stream://sess-7', expect.any(Function));
    // Simulate a streamed event — callback unwraps .payload.
    captured({ payload: { kind: 'stdout-line', data: 'hello' } });
    expect(handler).toHaveBeenCalledWith({ kind: 'stdout-line', data: 'hello' });
    expect(result).toBe(unlisten);
  });
});
