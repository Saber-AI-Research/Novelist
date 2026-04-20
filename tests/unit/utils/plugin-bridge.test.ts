import { describe, it, expect } from 'vitest';
import { aiEventName, claudeEventName, normalizeLineForClaude } from '$lib/utils/plugin-bridge';

describe('plugin bridge helpers', () => {
  it('builds ai stream event names from ids', () => {
    expect(aiEventName('abc123')).toBe('ai-stream://abc123');
  });

  it('builds claude stream event names from session ids', () => {
    expect(claudeEventName('sess-1')).toBe('claude-stream://sess-1');
  });

  it('ensures claude input lines end with a newline', () => {
    expect(normalizeLineForClaude('{"type":"user"}')).toBe('{"type":"user"}\n');
    expect(normalizeLineForClaude('{"type":"user"}\n')).toBe('{"type":"user"}\n');
  });
});
