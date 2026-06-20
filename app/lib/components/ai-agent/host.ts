/**
 * Host-side helpers for the Claude CLI bridge. Wraps the Rust commands and
 * Tauri event channel into a tighter API for the AI Agent panel.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { commands } from '$lib/ipc/commands';

export type DetectedCli = { path: string; version: string | null };

export type ClaudeStreamEvent =
  | { kind: 'stdout-line'; data: string }
  | { kind: 'stderr-line'; data: string }
  | { kind: 'exit'; code: number | null }
  | { kind: 'error'; message: string };

export async function detectClaudeCli(): Promise<DetectedCli | null> {
  const result = await commands.claudeCliDetect();
  return result ?? null;
}

export type SpawnArgs = {
  sessionUuid: string;
  cwd?: string | null;
  cliPath?: string;
  systemPrompt?: string;
  model?: string;
  permissionMode?: string;
  addDirs?: string[];
  /**
   * Resume the CLI conversation stored under `sessionUuid` instead of
   * creating a new one. Must be true whenever this uuid has produced
   * output before — the CLI rejects already-used `--session-id` values.
   */
  resume?: boolean;
};

export async function spawnClaudeSession(args: SpawnArgs): Promise<string> {
  const result = await commands.claudeCliSpawn({
    cli_path: args.cliPath || null,
    cwd: args.cwd || null,
    system_prompt: args.systemPrompt || null,
    add_dirs: args.addDirs ?? [],
    permission_mode: args.permissionMode || null,
    model: args.model || null,
    session_uuid: args.sessionUuid,
    resume: args.resume ?? false,
    extra_args: [],
  });
  if (result.status === 'error') throw new Error(result.error);
  return result.data;
}

export async function sendToClaude(sessionId: string, line: string): Promise<void> {
  const result = await commands.claudeCliSend(sessionId, line);
  if (result.status === 'error') throw new Error(result.error);
}

export async function killClaudeSession(sessionId: string): Promise<void> {
  const result = await commands.claudeCliKill(sessionId);
  if (result.status === 'error') throw new Error(result.error);
}

export function listenClaudeStream(
  sessionId: string,
  handler: (event: ClaudeStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<ClaudeStreamEvent>(`claude-stream://${sessionId}`, (event) => {
    handler(event.payload);
  });
}

// ----------------------------- stream-json -----------------------------

export type ToolUseBlock = { type: 'tool_use'; name: string; input: unknown };
export type TextBlock = { type: 'text'; text: string };

/**
 * Best-effort extraction of human-readable bits from one stream-JSON line.
 * Returns one of:
 *  - { kind: 'text-delta', text } — append to current assistant turn buffer
 *  - { kind: 'assistant-block', blocks } — replace current turn with full content
 *  - { kind: 'tool-use', name, input } — render a tool use card
 *  - { kind: 'result', text } — final assistant text + costs
 *  - { kind: 'system', data } — passthrough
 *  - null — unknown / ignored
 */
export type TokenUsage = { input: number; output: number };

export type ParsedStreamEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'assistant-block'; blocks: Array<TextBlock | ToolUseBlock> }
  | { kind: 'tool-use'; name: string; input: unknown }
  | { kind: 'tool-result'; content: string }
  | { kind: 'result'; text: string; cost?: number; usage?: TokenUsage }
  | { kind: 'system'; data: unknown }
  // Codex emits its conversation/thread id mid-turn; the caller persists it
  // to resume the conversation on the next turn.
  | { kind: 'session'; threadId: string };

export function parseClaudeLine(line: string): ParsedStreamEvent | null {
  if (!line.trim()) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }

  // Partial message deltas (with --include-partial-messages)
  if (msg.type === 'stream_event') {
    const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
      return { kind: 'text-delta', text: ev.delta.text };
    }
    return null;
  }

  // Final/structured assistant message
  if (msg.type === 'assistant') {
    const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content ?? [];
    const blocks: Array<TextBlock | ToolUseBlock> = [];
    for (const b of content) {
      if (b.type === 'text' && typeof b.text === 'string') {
        blocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        blocks.push({ type: 'tool_use', name: b.name, input: b.input });
      }
    }
    return { kind: 'assistant-block', blocks };
  }

  // Tool result (sent back to the model; we surface compact view in the UI)
  if (msg.type === 'user') {
    const message = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content ?? [];
    for (const b of content) {
      if (b.type === 'tool_result') {
        const c = b.content;
        const text = typeof c === 'string' ? c : JSON.stringify(c);
        return { kind: 'tool-result', content: text };
      }
    }
    return null;
  }

  if (msg.type === 'result') {
    return {
      kind: 'result',
      text: typeof msg.result === 'string' ? msg.result : '',
      cost: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
    };
  }

  if (msg.type === 'system') {
    return { kind: 'system', data: msg };
  }

  return null;
}

/**
 * Build the stream-json envelope for a user turn.
 */
export function userInputLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

// ============================== Codex bridge ==============================
//
// Codex's `exec` is one-shot per turn: `runCodexTurn` spawns a fresh process,
// streams JSONL on the SAME `codex-stream://{sessionUuid}` channel shape as
// Claude (`AgentStreamEvent`), then the process exits. Continuation uses
// `resumeThreadId` captured from the first `thread.started` event.

/** Neutral alias — Codex reuses the exact Tauri stream-event shape. */
export type AgentStreamEvent = ClaudeStreamEvent;

export async function detectCodexCli(): Promise<DetectedCli | null> {
  const result = await commands.codexCliDetect();
  return result ?? null;
}

export type CodexTurnArgs = {
  sessionUuid: string;
  prompt: string;
  cwd?: string | null;
  cliPath?: string;
  model?: string;
  /** "read-only" | "workspace-write" | "danger-full-access" */
  sandbox?: string;
  addDirs?: string[];
  /** Resume an existing Codex conversation instead of starting a new one. */
  resumeThreadId?: string | null;
};

export async function runCodexTurn(args: CodexTurnArgs): Promise<void> {
  const result = await commands.codexCliTurn({
    cli_path: args.cliPath || null,
    cwd: args.cwd || null,
    model: args.model || null,
    sandbox: args.sandbox || null,
    add_dirs: args.addDirs ?? [],
    prompt: args.prompt,
    resume_thread_id: args.resumeThreadId || null,
    session_uuid: args.sessionUuid,
  });
  if (result.status === 'error') throw new Error(result.error);
}

export async function killCodexSession(sessionId: string): Promise<void> {
  const result = await commands.codexCliKill(sessionId);
  if (result.status === 'error') throw new Error(result.error);
}

export function listenCodexStream(
  sessionId: string,
  handler: (event: AgentStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<AgentStreamEvent>(`codex-stream://${sessionId}`, (event) => {
    handler(event.payload);
  });
}

/**
 * Parse one Codex `exec --json` JSONL line into a `ParsedStreamEvent`.
 *
 * Verified event shapes (codex-cli 0.141.0):
 *  - {"type":"thread.started","thread_id":"<uuid>"}            → session
 *  - {"type":"turn.started"}                                   → ignored
 *  - {"type":"item.completed","item":{"type":"agent_message","text":"…"}} → assistant-block
 *  - {"type":"item.completed","item":{"type":"command_execution"|"file_change"|"reasoning"|…}} → tool-use
 *  - {"type":"turn.completed","usage":{"input_tokens":…,"output_tokens":…}} → result (token usage)
 *  - {"type":"error","message":"…"}                            → result-ish error (surfaced as text)
 */
export function parseCodexLine(line: string): ParsedStreamEvent | null {
  if (!line.trim()) return null;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }

  switch (msg.type) {
    case 'thread.started': {
      const id = msg.thread_id;
      return typeof id === 'string' && id ? { kind: 'session', threadId: id } : null;
    }
    case 'item.completed': {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item || typeof item.type !== 'string') return null;
      if (item.type === 'agent_message') {
        const text = typeof item.text === 'string' ? item.text : '';
        return { kind: 'assistant-block', blocks: [{ type: 'text', text }] };
      }
      // Every other item kind (command_execution, file_change, reasoning,
      // mcp_tool_call, todo_list, …) renders as a tool-use card.
      return { kind: 'tool-use', name: item.type, input: item };
    }
    case 'turn.completed': {
      const usage = msg.usage as Record<string, unknown> | undefined;
      const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
      const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
      return { kind: 'result', text: '', usage: { input, output } };
    }
    case 'error': {
      const message = typeof msg.message === 'string' ? msg.message : 'Codex error';
      return { kind: 'result', text: `⚠️ ${message}` };
    }
    // turn.started, item.started, and unknown types are ignored.
    default:
      return null;
  }
}
