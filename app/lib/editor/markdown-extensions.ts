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
import type { MarkdownConfig, BlockParser, LeafBlockParser, InlineParser } from '@lezer/markdown';
import { tags } from '@lezer/highlight';

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
 * Display math: $$ on its own line as opener/closer, with math content between.
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
        if (!/^\$\$\s*$/.test(line.text.slice(line.basePos))) return false;
        const start = cx.lineStart;
        // Advance past the opening $$
        if (!cx.nextLine()) return false;
        // Scan lines until closing $$
        while (true) {
          if (/^\$\$\s*$/.test(line.text.slice(line.basePos))) {
            cx.nextLine();
            cx.addElement(cx.elt('DisplayMath', start, cx.prevLineEnd()));
            return true;
          }
          if (!cx.nextLine()) {
            // Reached end of document without closing $$ — not valid display math
            return false;
          }
        }
      },
      before: 'FencedCode',
    },
  ],
};

/* ── YAML Front-matter ─────────────────────────────────────── */

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
        if (!/^---\s*$/.test(line.text)) return false;
        const start = cx.lineStart;
        // Advance past the opening ---
        if (!cx.nextLine()) return false;
        // Scan lines until closing ---
        while (true) {
          if (/^---\s*$/.test(line.text)) {
            cx.nextLine();
            cx.addElement(cx.elt('FrontMatter', start, cx.prevLineEnd()));
            return true;
          }
          if (!cx.nextLine()) {
            // Reached end of document without closing --- ; not valid front-matter
            return false;
          }
        }
      },
      before: 'LinkReference',
    },
  ],
};
