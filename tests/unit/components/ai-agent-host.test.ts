import { describe, it, expect } from 'vitest';
import {
  parseClaudeLine,
  userInputLine,
} from '$lib/components/ai-agent/host';

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
});
