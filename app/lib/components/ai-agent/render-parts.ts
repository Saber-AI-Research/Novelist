import type { Card } from './sessions.svelte';

export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: Card; ci: number };

/**
 * Interleave an assistant turn's accumulated `text` and its ordered `cards`
 * into a single chronological list for rendering.
 *
 * Each card carries a `textOffset` — the length of `text` at the moment the
 * card was emitted during streaming. Text that preceded a tool call therefore
 * renders above it, and text streamed afterward renders below it, matching the
 * order events actually arrived.
 *
 * Cards without an offset (older persisted turns, written before this field
 * existed) fall back to the legacy "all text, then all cards" layout by
 * treating their offset as end-of-text. Offsets are clamped monotonically so a
 * malformed/out-of-order value can never slice text backwards.
 */
export function assistantParts(turn: { text: string; cards: Card[] }): AssistantPart[] {
  const parts: AssistantPart[] = [];
  const text = turn.text ?? '';
  let prev = 0;
  turn.cards.forEach((card, ci) => {
    const raw = typeof card.textOffset === 'number' ? card.textOffset : text.length;
    const off = Math.max(prev, Math.min(raw, text.length));
    if (off > prev) {
      parts.push({ kind: 'text', text: text.slice(prev, off) });
      prev = off;
    }
    parts.push({ kind: 'card', card, ci });
  });
  if (prev < text.length) parts.push({ kind: 'text', text: text.slice(prev) });
  return parts;
}
