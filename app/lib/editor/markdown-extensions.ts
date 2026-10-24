/**
 * Custom Markdown extensions for @lezer/markdown.
 *
 * Adds:
 * - ==highlight== syntax (like <mark>)
 * - [^1] footnote references and [^1]: footnote definitions
 * - $inline math$ and $$display math$$ (rendered by KaTeX in math.ts)
 * - YAML front-matter (--- delimited blocks at document start)
 *
 * These follow the same pattern as the GFM Strikethrough extension
 * in @lezer/markdown: define nodes, then register inline/block parsers.
 */
import type { MarkdownConfig, BlockParser, LeafBlockParser, InlineParser, BlockContext } from '@lezer/markdown';
import type { Input } from '@lezer/common';
import { tags } from '@lezer/highlight';

/* ── Tree-walk helper ──────────────────────────────────────── */

const BLOCK_CONTAINERS: Record<string, true> = {
  Document: true, Blockquote: true, BulletList: true, OrderedList: true, ListItem: true,
};

/**
 * Whether a syntax node can hold block children. Full-document scans that
 * look for block constructs (tables, display math, fenced code) return this
 * from `enter` so they skip the inline content of every leaf block instead
 * of visiting each inline node on every keystroke.
 */
export function isBlockContainer(name: string): boolean {
  return BLOCK_CONTAINERS[name] === true;
}

/* ── ==highlight== ─────────────────────────────────────────── */

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };

export const Highlight: MarkdownConfig = {
  defineNodes: [
    {
      name: 'Highlight',
      style: { 'Highlight/...': tags.special(tags.emphasis) },
    },
    {
      name: 'HighlightMark',
      style: tags.processingInstruction,
    },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        // Must be two consecutive '=' characters (charCode 61)
        if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61)
          return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(before);
        const pAfter = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: 'Emphasis',
    },
  ],
};

/* ── Footnote [^id] reference & [^id]: definition ──────────── */

export const Footnote: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference' },
    { name: 'FootnoteDefinition', block: true },
    { name: 'FootnoteMark', style: tags.processingInstruction },
    { name: 'FootnoteLabel' },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      parse(cx, next, pos) {
        // Match [^ at inline level — footnote reference like [^1] or [^note]
        if (next != 91 /* '[' */ || cx.char(pos + 1) != 94 /* '^' */)
          return -1;
        // Scan forward for the closing ]
        let end = pos + 2;
        // Must have at least one character in the label
        if (end >= cx.end) return -1;
        const labelStart = end;
        while (end < cx.end) {
          const ch = cx.char(end);
          // Label must be alphanumeric, hyphen, or underscore
          if (ch == 93 /* ']' */) break;
          if (ch == 10 || ch == 13) return -1; // no newlines
          end++;
        }
        if (end >= cx.end || end === labelStart) return -1;
        // end is at the ']'
        const closeBracket = end;
        // Make sure the next char is NOT ':' (that would be a definition, handled at block level)
        // Actually, inline parser won't see block-level definitions, so this is fine
        return cx.addElement(
          cx.elt('FootnoteReference', pos, closeBracket + 1, [
            cx.elt('FootnoteMark', pos, pos + 2),       // [^
            cx.elt('FootnoteLabel', pos + 2, closeBracket), // the label
            cx.elt('FootnoteMark', closeBracket, closeBracket + 1), // ]
          ]),
        );
      },
      before: 'Link',
    },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      parse(cx, line) {
        // Match [^label]: at the start of a line
        const text = line.text;
        const match = /^\[\^([^\]]+)\]:\s/.exec(text.slice(line.basePos));
        if (!match) return false;
        // Consume just this one line as a footnote definition block
        const start = cx.lineStart;
        cx.nextLine();
        cx.addElement(cx.elt('FootnoteDefinition', start, cx.prevLineEnd()));
        return true;
      },
      before: 'LinkReference',
    },
  ],
};

/* ── $inline math$ and $$display math$$ ──────────────────── */

/**
 * Inline math: $...$
 * Uses addElement to create an InlineMath node spanning from the opening $
 * to the closing $. Does NOT match $$ (that's display math at block level).
 */
export const InlineMath: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath' },
    { name: 'InlineMathMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      parse(cx, next, pos) {
        // Must be a single $ (charCode 36), NOT $$
        if (next != 36 /* $ */) return -1;
        if (cx.char(pos + 1) == 36) return -1; // $$ is display math
        // Must not be preceded by $ (avoid matching end of $$)
        if (pos > cx.offset && cx.slice(pos - 1, pos) === '$') return -1;
        // Scan forward for closing $ (not $$)
        let end = pos + 1;
        // Content must not be empty
        if (end >= cx.end || cx.char(end) == 36) return -1;
        // Content must not start with a space
        if (cx.char(end) == 32) return -1;
        while (end < cx.end) {
          const ch = cx.char(end);
          if (ch == 10 || ch == 13) return -1; // no newlines in inline math
          if (ch == 36 /* $ */) {
            // Must not be preceded by a space
            if (cx.char(end - 1) == 32) return -1;
            // Must not be followed by $ (that would be $$)
            if (end + 1 < cx.end && cx.char(end + 1) == 36) return -1;
            // Found the closing $
            return cx.addElement(
              cx.elt('InlineMath', pos, end + 1, [
                cx.elt('InlineMathMark', pos, pos + 1),       // opening $
                cx.elt('InlineMathMark', end, end + 1),       // closing $
              ]),
            );
          }
          end++;
        }
        return -1;
      },
      before: 'Emphasis',
    },
  ],
};

/**
 * Fields BlockContext keeps at runtime but omits from its public typings.
 * Needed to look ahead without consuming lines: a block parser that calls
 * `nextLine()` and then returns false leaves every consumed line without a
 * syntax node (Lezer never rewinds).
 */
interface BlockContextInternals {
  input: Input;
  absoluteLineEnd: number;
  to: number;
}

/** Line's internal count of composite blocks (quote, list item) still open on it. */
interface LineInternals {
  depth: number;
}

/**
 * Whether any line after the current one satisfies `isCloser`.
 * Mirrors Lezer's own line reading (`lineChunkAt`) on the raw input,
 * so composite-block markup (`> `, list indentation) is NOT stripped.
 */
function hasClosingLineAhead(cx: BlockContext, isCloser: (text: string) => boolean): boolean {
  const { input, absoluteLineEnd, to } = cx as unknown as BlockContextInternals;
  let pos = absoluteLineEnd + 1;
  while (pos < to) {
    const chunk = input.chunk(pos);
    let text: string;
    if (input.lineChunks) {
      text = chunk === '\n' ? '' : chunk;
    } else {
      const eol = chunk.indexOf('\n');
      text = eol < 0 ? chunk : chunk.slice(0, eol);
    }
    if (pos + text.length > to) text = text.slice(0, to - pos);
    if (isCloser(text)) return true;
    pos += text.length + 1;
  }
  return false;
}

const DISPLAY_MATH_FENCE = /^\$\$\s*$/;
/** Raw-line closer test inside containers: allow blockquote/list prefixes. */
const NESTED_DISPLAY_MATH_FENCE = /^[ \t>]*\$\$\s*$/;

/**
 * Display math: $$ on its own line as opener/closer, with math content between.
 * An opener without a closing $$ further down is left to other parsers
 * (it becomes a paragraph) instead of swallowing the rest of the document.
 */
export const DisplayMath: MarkdownConfig = {
  defineNodes: [
    { name: 'DisplayMath', block: true },
    { name: 'DisplayMathMark', style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'DisplayMath',
      parse(cx, line) {
        // Must start with $$ (optionally followed by whitespace)
        if (!DISPLAY_MATH_FENCE.test(line.text.slice(line.basePos))) return false;
        const closer = cx.depth === 1 ? DISPLAY_MATH_FENCE : NESTED_DISPLAY_MATH_FENCE;
        if (!hasClosingLineAhead(cx, (text) => closer.test(text))) return false;
        const start = cx.lineStart;
        // `depth` is internal: it drops below cx.depth when an enclosing
        // quote/list ends, which ends the block (like FencedCode).
        const lineState = line as unknown as LineInternals;
        // Consume lines until the closing $$, the end of the enclosing
        // container, or the end of the document.
        while (cx.nextLine() && lineState.depth >= cx.depth) {
          if (DISPLAY_MATH_FENCE.test(line.text.slice(line.basePos))) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('DisplayMath', start, cx.prevLineEnd()));
        return true;
      },
      before: 'FencedCode',
    },
  ],
};

/* ── YAML Front-matter ─────────────────────────────────────── */

const FRONT_MATTER_FENCE = /^---\s*$/;

export const FrontMatter: MarkdownConfig = {
  defineNodes: [
    { name: 'FrontMatter', block: true },
    { name: 'FrontMatterMark', style: tags.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'FrontMatter',
      parse(cx, line) {
        // Only at document start (lineStart === 0)
        if (cx.lineStart !== 0) return false;
        // Must start with exactly ---
        if (!FRONT_MATTER_FENCE.test(line.text)) return false;
        // A leading --- without a closing --- is a horizontal rule.
        if (!hasClosingLineAhead(cx, (text) => FRONT_MATTER_FENCE.test(text))) return false;
        const start = cx.lineStart;
        while (cx.nextLine()) {
          if (FRONT_MATTER_FENCE.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('FrontMatter', start, cx.prevLineEnd()));
        return true;
      },
      before: 'LinkReference',
    },
  ],
};
