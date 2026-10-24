/**
 * Simple markdown-to-HTML and markdown-to-plaintext converters
 * for "Copy as Rich Text" and "Copy as Plain Text" commands.
 *
 * Handles: bold, italic, strikethrough, inline code, headers,
 * links, blockquotes, unordered/ordered lists. No images or
 * complex block structures (tables, code fences, etc.).
 */

/** Convert a markdown string to simple HTML. */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const htmlLines: string[] = [];
  let inList: 'ul' | 'ol' | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Close list if current line is not a list item
    const isUnordered = /^(\s*[-*+])\s/.test(line);
    const isOrdered = /^(\s*\d+\.)\s/.test(line);
    if (inList && !isUnordered && !isOrdered) {
      htmlLines.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }

    // Headers
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      htmlLines.push(`<h${level}>${convertInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      htmlLines.push(`<blockquote>${convertInline(line.slice(2))}</blockquote>`);
      continue;
    }

    // Unordered list
    if (isUnordered) {
      if (inList !== 'ul') {
        if (inList) htmlLines.push('</ol>');
        htmlLines.push('<ul>');
        inList = 'ul';
      }
      const content = line.replace(/^\s*[-*+]\s/, '');
      htmlLines.push(`<li>${convertInline(content)}</li>`);
      continue;
    }

    // Ordered list
    if (isOrdered) {
      if (inList !== 'ol') {
        if (inList) htmlLines.push('</ul>');
        htmlLines.push('<ol>');
        inList = 'ol';
      }
      const content = line.replace(/^\s*\d+\.\s/, '');
      htmlLines.push(`<li>${convertInline(content)}</li>`);
      continue;
    }

    // Empty line -> paragraph break
    if (line.trim() === '') {
      htmlLines.push('<br>');
      continue;
    }

    // Normal paragraph
    htmlLines.push(`<p>${convertInline(line)}</p>`);
  }

  // Close any open list
  if (inList) {
    htmlLines.push(inList === 'ul' ? '</ul>' : '</ol>');
  }

  return htmlLines.join('\n');
}

const STASH_RE = /\u0000(\d+)\u0000/g;

function escapeHtml(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert inline markdown syntax to HTML. */
function convertInline(text: string): string {
  // Escape first so literal `<`, `&` and `"` in prose (`Vec<String>`, `a<b`)
  // stay text instead of becoming markup in the pasted HTML.
  text = escapeHtml(text);
  // Code spans and link targets are parked behind NUL-delimited placeholders
  // so the emphasis rules below can't rewrite their contents.
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  // Inline code (must be first to prevent inner processing)
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => hold(`<code>${code}</code>`));
  // Links [text](url "optional title"). Only web links survive the copy;
  // `javascript:` and other schemes keep just their text.
  text = text.replace(
    /\[([^\]]+)\]\(\s*([^\s)]+)(?:\s+[^)]*)?\)/g,
    (_m, label: string, url: string) => (/^https?:\/\//i.test(url) ? `<a href="${hold(url)}">${label}</a>` : label),
  );
  // Bold+italic (***text***)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold (**text** or __text__)
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic (*text* or _text_)
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>');
  // Strikethrough (~~text~~)
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
  return text.replace(STASH_RE, (_m, index: string) => stash[Number(index)]);
}

/** Strip markdown syntax to produce plain text. */
export function markdownToPlainText(md: string): string {
  let text = md;
  // Remove heading markers
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Remove blockquote markers
  text = text.replace(/^>\s?/gm, '');
  // Remove bold+italic (***text***)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  // Remove bold (**text** or __text__)
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  // Remove italic (*text* or _text_)
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1');
  // Remove strikethrough
  text = text.replace(/~~(.+?)~~/g, '$1');
  // Remove inline code backticks
  text = text.replace(/`([^`]+)`/g, '$1');
  // Convert links [text](url) -> text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Remove list markers
  text = text.replace(/^(\s*)[-*+]\s/gm, '$1');
  text = text.replace(/^(\s*)\d+\.\s/gm, '$1');
  return text;
}
