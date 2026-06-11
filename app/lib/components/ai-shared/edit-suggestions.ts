/**
 * Structured edit suggestions for AI chat (Cursor-style accept/deny).
 *
 * The model is instructed (via EDIT_SUGGESTION_PROTOCOL, appended to the
 * system prompt) to express concrete text changes as fenced
 * ```novelist-edit blocks containing a SEARCH/REPLACE pair. The chat panel
 * parses assistant messages with `splitEditSuggestions`, renders each
 * suggestion as a card with Accept / Reject buttons, and applies accepted
 * ones to the active editor document by exact substring replacement.
 */

export type EditSuggestion = {
  /** Stable within the message: `edit-<ordinal>` in parse order. */
  id: string;
  /** Optional target file (display only — applied to the active editor). */
  file?: string;
  /** Optional one-line rationale shown on the card. */
  note?: string;
  /** Exact text to find in the document. */
  search: string;
  /** Replacement text. */
  replace: string;
};

export type SuggestionStatus = 'accepted' | 'rejected' | 'conflict';

export type SplitMessage = {
  /** Message text with the ```novelist-edit blocks removed. */
  body: string;
  suggestions: EditSuggestion[];
};

/**
 * Appended to the chat system prompt so any preset/profile benefits from
 * the structured-edit protocol without user configuration.
 */
export const EDIT_SUGGESTION_PROTOCOL = [
  'When you propose concrete changes to the user\'s text (typo fixes, line edits, rewording specific passages), emit each change as a fenced block in exactly this format:',
  '',
  '```novelist-edit',
  'note: <one-line reason, optional>',
  '<<<<<<< SEARCH',
  '<exact text copied verbatim from the document>',
  '=======',
  '<replacement text>',
  '>>>>>>> REPLACE',
  '```',
  '',
  'Rules: copy SEARCH text exactly (including punctuation) and make it long enough to be unique in the document; one change per block; you may emit several blocks. Outside the blocks, keep your commentary brief. The app renders each block as an accept/reject card and applies accepted ones automatically, so do NOT also restate the corrections as a prose list.',
].join('\n');

const BLOCK_RE = /```novelist-edit[^\S\n]*\n([\s\S]*?)```/g;
const PAIR_RE = /<{7} SEARCH\n([\s\S]*?)\n={7}\n([\s\S]*?)\n>{7} REPLACE/;

function parseBlock(inner: string, ordinal: number): EditSuggestion | null {
  const pair = PAIR_RE.exec(inner);
  if (!pair) return null;
  const head = inner.slice(0, pair.index);
  const file = /^file:[^\S\n]*(.+)$/m.exec(head)?.[1]?.trim();
  const note = /^note:[^\S\n]*(.+)$/m.exec(head)?.[1]?.trim();
  const search = pair[1];
  if (!search) return null;
  return {
    id: `edit-${ordinal}`,
    file: file || undefined,
    note: note || undefined,
    search,
    replace: pair[2] ?? '',
  };
}

/**
 * Split an assistant message into prose body + structured suggestions.
 * Malformed blocks are left in the body untouched.
 */
export function splitEditSuggestions(text: string): SplitMessage {
  const suggestions: EditSuggestion[] = [];
  let ordinal = 0;
  const body = text
    .replace(BLOCK_RE, (whole, inner: string) => {
      const parsed = parseBlock(inner, ordinal);
      if (!parsed) return whole;
      ordinal += 1;
      suggestions.push(parsed);
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { body, suggestions };
}

/**
 * Apply a suggestion to a document by exact substring match.
 * Returns the replacement range, or null when the text isn't found
 * (document changed since the suggestion was generated).
 */
export function locateSuggestion(
  doc: string,
  suggestion: EditSuggestion,
): { from: number; to: number } | null {
  const idx = doc.indexOf(suggestion.search);
  if (idx < 0) return null;
  return { from: idx, to: idx + suggestion.search.length };
}
