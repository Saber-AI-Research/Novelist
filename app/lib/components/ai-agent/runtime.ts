import {
  detectClaudeCli,
  detectCodexCli,
  killClaudeSession,
  killCodexSession,
  listenClaudeStream,
  listenCodexStream,
  parseClaudeLine,
  parseCodexLine,
  runCodexTurn,
  sendToClaude,
  spawnClaudeSession,
  userInputLine,
  type CodexTurnArgs,
  type ClaudeStreamEvent,
  type DetectedCli,
  type ParsedStreamEvent,
  type SpawnArgs,
} from './host';
import type { UnlistenFn } from '@tauri-apps/api/event';

export type AgentProviderId = 'claude' | 'codex';
export type AgentMode = 'act' | 'plan';

/** Args for one-shot providers (Codex). Persistent providers ignore `runTurn`. */
export type RunTurnArgs = CodexTurnArgs;

export type AgentRuntime = {
  providerId: AgentProviderId;
  /** `persistent`: spawn-once/send-many (Claude). Otherwise one-shot per turn (Codex). */
  capabilities: { persistent: boolean };
  detect(): Promise<DetectedCli | null>;
  spawn(args: SpawnArgs): Promise<string>;
  send(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  kill(sessionId: string): Promise<void>;
  resume(args: SpawnArgs): Promise<string>;
  listen(sessionId: string, handler: (event: ClaudeStreamEvent) => void): Promise<UnlistenFn>;
  parseEvent(line: string): ParsedStreamEvent | null;
  /** One-shot providers only — runs a full turn (spawn → stream → exit). */
  runTurn?(args: RunTurnArgs): Promise<void>;
};

export const ClaudeRuntime: AgentRuntime = {
  providerId: 'claude',
  capabilities: { persistent: true },
  detect: detectClaudeCli,
  spawn: spawnClaudeSession,
  send: (sessionId, text) => sendToClaude(sessionId, userInputLine(text)),
  cancel: killClaudeSession,
  kill: killClaudeSession,
  resume: spawnClaudeSession,
  listen: listenClaudeStream,
  parseEvent: parseClaudeLine,
};

export const CodexRuntime: AgentRuntime = {
  providerId: 'codex',
  capabilities: { persistent: false },
  detect: detectCodexCli,
  // Codex has no persistent process; `spawn`/`resume` are no-ops that just
  // hand back the caller's session id. The real work happens in `runTurn`.
  spawn: async (args) => args.sessionUuid,
  resume: async (args) => args.sessionUuid,
  send: (sessionId, text) => runCodexTurn({ sessionUuid: sessionId, prompt: text }),
  cancel: killCodexSession,
  kill: killCodexSession,
  listen: listenCodexStream,
  parseEvent: parseCodexLine,
  runTurn: runCodexTurn,
};

export function runtimeFor(providerId: AgentProviderId): AgentRuntime {
  return providerId === 'codex' ? CodexRuntime : ClaudeRuntime;
}
