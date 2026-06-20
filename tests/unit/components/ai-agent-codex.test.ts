import { describe, it, expect, vi, beforeEach } from 'vitest';

const { codexCliDetect, codexCliTurn, codexCliKill, claudeCliDetect, claudeCliSpawn, claudeCliSend, claudeCliKill, listen } =
  vi.hoisted(() => ({
    codexCliDetect: vi.fn(),
    codexCliTurn: vi.fn(),
    codexCliKill: vi.fn(),
    claudeCliDetect: vi.fn(),
    claudeCliSpawn: vi.fn(),
    claudeCliSend: vi.fn(),
    claudeCliKill: vi.fn(),
    listen: vi.fn(),
  }));

vi.mock('$lib/ipc/commands', () => ({
  commands: { codexCliDetect, codexCliTurn, codexCliKill, claudeCliDetect, claudeCliSpawn, claudeCliSend, claudeCliKill },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

import { parseCodexLine, runCodexTurn } from '$lib/components/ai-agent/host';
import { runtimeFor, ClaudeRuntime, CodexRuntime } from '$lib/components/ai-agent/runtime';

beforeEach(() => {
  codexCliDetect.mockReset();
  codexCliTurn.mockReset();
  codexCliKill.mockReset();
  listen.mockReset();
});

describe('parseCodexLine', () => {
  it('returns null for blank / malformed lines', () => {
    expect(parseCodexLine('')).toBeNull();
    expect(parseCodexLine('   ')).toBeNull();
    expect(parseCodexLine('not json')).toBeNull();
    expect(parseCodexLine('{bad json')).toBeNull();
  });

  it('maps thread.started → session with the thread id', () => {
    const ev = parseCodexLine('{"type":"thread.started","thread_id":"abc-123-def-456"}');
    expect(ev).toEqual({ kind: 'session', threadId: 'abc-123-def-456' });
  });

  it('ignores thread.started without an id', () => {
    expect(parseCodexLine('{"type":"thread.started"}')).toBeNull();
  });

  it('ignores turn.started and unknown / partial event types', () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toBeNull();
    expect(parseCodexLine('{"type":"item.started","item":{}}')).toBeNull();
    expect(parseCodexLine('{"type":"something.else"}')).toBeNull();
  });

  it('maps an agent_message item to an assistant-block', () => {
    const ev = parseCodexLine('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello 世界"}}');
    expect(ev).toEqual({ kind: 'assistant-block', blocks: [{ type: 'text', text: 'Hello 世界' }] });
  });

  it('maps non-message items to tool-use cards (name = item.type)', () => {
    const cmd = parseCodexLine('{"type":"item.completed","item":{"type":"command_execution","command":"ls"}}');
    expect(cmd).toMatchObject({ kind: 'tool-use', name: 'command_execution' });
    const file = parseCodexLine('{"type":"item.completed","item":{"type":"file_change","path":"a.md"}}');
    expect(file).toMatchObject({ kind: 'tool-use', name: 'file_change' });
  });

  it('drops item.completed without a typed item', () => {
    expect(parseCodexLine('{"type":"item.completed"}')).toBeNull();
    expect(parseCodexLine('{"type":"item.completed","item":{}}')).toBeNull();
  });

  it('maps turn.completed → result carrying token usage', () => {
    const ev = parseCodexLine('{"type":"turn.completed","usage":{"input_tokens":21686,"output_tokens":26}}');
    expect(ev).toEqual({ kind: 'result', text: '', usage: { input: 21686, output: 26 } });
  });

  it('defaults usage to zero when fields are missing', () => {
    const ev = parseCodexLine('{"type":"turn.completed","usage":{}}');
    expect(ev).toEqual({ kind: 'result', text: '', usage: { input: 0, output: 0 } });
  });

  it('surfaces an error event as a result with a warning prefix', () => {
    const ev = parseCodexLine('{"type":"error","message":"boom"}');
    expect(ev).toEqual({ kind: 'result', text: '⚠️ boom' });
  });
});

describe('runCodexTurn arg mapping', () => {
  it('maps camelCase args to the snake_case CodexTurnRequest', async () => {
    codexCliTurn.mockResolvedValue({ status: 'ok', data: 's1' });
    await runCodexTurn({
      sessionUuid: 's1',
      prompt: 'hi',
      cwd: '/proj',
      cliPath: '/bin/codex',
      model: 'gpt-5-codex',
      sandbox: 'read-only',
      addDirs: ['/extra'],
      resumeThreadId: 'thread-9',
    });
    expect(codexCliTurn).toHaveBeenCalledWith({
      cli_path: '/bin/codex',
      cwd: '/proj',
      model: 'gpt-5-codex',
      sandbox: 'read-only',
      add_dirs: ['/extra'],
      prompt: 'hi',
      resume_thread_id: 'thread-9',
      session_uuid: 's1',
    });
  });

  it('nulls optional fields and defaults add_dirs when omitted', async () => {
    codexCliTurn.mockResolvedValue({ status: 'ok', data: 's1' });
    await runCodexTurn({ sessionUuid: 's1', prompt: 'hi' });
    expect(codexCliTurn).toHaveBeenCalledWith({
      cli_path: null,
      cwd: null,
      model: null,
      sandbox: null,
      add_dirs: [],
      prompt: 'hi',
      resume_thread_id: null,
      session_uuid: 's1',
    });
  });

  it('throws on an error result', async () => {
    codexCliTurn.mockResolvedValue({ status: 'error', error: 'nope' });
    await expect(runCodexTurn({ sessionUuid: 's1', prompt: 'hi' })).rejects.toThrow('nope');
  });
});

describe('runtimeFor', () => {
  it('selects the Codex runtime for codex sessions', () => {
    expect(runtimeFor('codex')).toBe(CodexRuntime);
    expect(runtimeFor('codex').capabilities.persistent).toBe(false);
    expect(typeof runtimeFor('codex').runTurn).toBe('function');
  });

  it('selects the persistent Claude runtime for claude sessions', () => {
    expect(runtimeFor('claude')).toBe(ClaudeRuntime);
    expect(runtimeFor('claude').capabilities.persistent).toBe(true);
    expect(ClaudeRuntime.runTurn).toBeUndefined();
  });

  it('Codex spawn/resume are no-ops returning the session uuid', async () => {
    await expect(CodexRuntime.spawn({ sessionUuid: 's7' })).resolves.toBe('s7');
    await expect(CodexRuntime.resume({ sessionUuid: 's7' })).resolves.toBe('s7');
  });
});
