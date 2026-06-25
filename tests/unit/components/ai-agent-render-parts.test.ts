import { describe, it, expect } from 'vitest';
import { assistantParts } from '$lib/components/ai-agent/render-parts';
import type { Card } from '$lib/components/ai-agent/sessions.svelte';

describe('[unit] assistantParts — chronological interleaving', () => {
  it('places text before the tool call it preceded, and later text below', () => {
    // Stream order: "Reading..." → tool → result → "Done."
    const text = 'Reading...Done.';
    const cards: Card[] = [
      { kind: 'tool', name: 'read', input: {}, textOffset: 10 },
      { kind: 'tool-result', content: 'ok', textOffset: 10 },
    ];
    const parts = assistantParts({ text, cards });
    expect(parts).toEqual([
      { kind: 'text', text: 'Reading...' },
      { kind: 'card', card: cards[0], ci: 0 },
      { kind: 'card', card: cards[1], ci: 1 },
      { kind: 'text', text: 'Done.' },
    ]);
  });

  it('interleaves across multiple tool cycles', () => {
    const text = 'AB';
    const cards: Card[] = [
      { kind: 'tool', name: 'x', input: {}, textOffset: 1 }, // after "A"
      { kind: 'tool', name: 'y', input: {}, textOffset: 2 }, // after "B"
    ];
    const parts = assistantParts({ text, cards });
    expect(parts.map((p) => (p.kind === 'text' ? `t:${p.text}` : `c:${p.ci}`))).toEqual([
      't:A',
      'c:0',
      't:B',
      'c:1',
    ]);
  });

  it('renders a turn with no cards as a single trailing text part', () => {
    const parts = assistantParts({ text: 'just text', cards: [] });
    expect(parts).toEqual([{ kind: 'text', text: 'just text' }]);
  });

  it('falls back to text-then-cards for legacy cards lacking textOffset', () => {
    const text = 'Hello';
    const cards: Card[] = [
      { kind: 'tool', name: 'read', input: {} },
      { kind: 'tool-result', content: 'ok' },
    ];
    const parts = assistantParts({ text, cards });
    // All text first, then every card — preserves how old sessions rendered.
    expect(parts).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'card', card: cards[0], ci: 0 },
      { kind: 'card', card: cards[1], ci: 1 },
    ]);
  });

  it('clamps out-of-range / non-monotonic offsets without slicing backwards', () => {
    const text = 'abcde';
    const cards: Card[] = [
      { kind: 'tool', name: 'a', input: {}, textOffset: 3 },
      // Bogus earlier offset — must not emit a backwards slice.
      { kind: 'tool', name: 'b', input: {}, textOffset: 1 },
      // Beyond end — clamped to text length.
      { kind: 'tool', name: 'c', input: {}, textOffset: 999 },
    ];
    const parts = assistantParts({ text, cards });
    expect(parts).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'card', card: cards[0], ci: 0 },
      { kind: 'card', card: cards[1], ci: 1 },
      { kind: 'text', text: 'de' },
      { kind: 'card', card: cards[2], ci: 2 },
    ]);
  });
});
