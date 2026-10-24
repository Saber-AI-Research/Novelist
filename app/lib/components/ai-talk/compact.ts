import type { AiStreamEvent } from './host';
import { parseChatChunk } from './openai';

export type CompactionResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'error'; message: string; status?: number }
  | { ok: false; reason: 'empty' | 'incomplete' };

/**
 * Collect the summary from a compaction stream. Only a stream that finished
 * (`done`) with a non-empty summary counts as success: an `error` event
 * (HTTP 401/429, Stop, the panel closing) or an empty reply must leave the
 * conversation untouched instead of replacing it.
 */
export async function collectCompactionSummary(events: AsyncIterable<AiStreamEvent>): Promise<CompactionResult> {
  let summary = '';
  for await (const ev of events) {
    if (ev.kind === 'chunk') {
      const delta = parseChatChunk(ev.data);
      if (delta?.content) summary += delta.content;
    } else if (ev.kind === 'error') {
      return { ok: false, reason: 'error', message: ev.message, status: ev.status };
    } else {
      const trimmed = summary.trim();
      return trimmed ? { ok: true, summary: trimmed } : { ok: false, reason: 'empty' };
    }
  }
  return { ok: false, reason: 'incomplete' };
}
