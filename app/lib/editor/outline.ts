import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';

export interface HeadingItem {
  level: number;      // 1-6
  text: string;       // heading text without # markers
  from: number;       // position in document (for scrolling)
}

/**
 * Extract headings from the syntax tree.
 * For very large documents (>10K lines), only scans the first 50K characters
 * plus the full tree (CM6 parses lazily, so unparsed regions are skipped).
 */
export function extractHeadings(state: EditorState): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const tree = syntaxTree(state);

  tree.iterate({
    enter(node) {
      const match = node.name.match(/^ATXHeading(\d)$/);
      if (match) {
        const level = parseInt(match[1]);
        const lineText = state.doc.lineAt(node.from).text;
        const text = lineText.replace(/^#+\s*/, '').trim();
        if (text) {
          headings.push({ level, text, from: node.from });
        }
      }
    }
  });

  return headings;
}
