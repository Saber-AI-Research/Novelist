export function aiEventName(streamId: string) {
  return `ai-stream://${streamId}`;
}

export function claudeEventName(sessionId: string) {
  return `claude-stream://${sessionId}`;
}

export function normalizeLineForClaude(line: string) {
  return line.endsWith('\n') ? line : `${line}\n`;
}
