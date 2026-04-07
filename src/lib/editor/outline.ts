import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';

export interface HeadingItem {
  level: number;      // 1-6
  text: string;       // heading text without # markers
  from: number;       // position in document (for scrolling)
}

export function extractHeadings(state: EditorState): HeadingItem[] {
  const headings: HeadingItem[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      // ATXHeading1 through ATXHeading6
      const match = node.name.match(/^ATXHeading(\d)$/);
      if (match) {
        const level = parseInt(match[1]);
        const lineText = state.doc.lineAt(node.from).text;
        // Remove leading # markers and whitespace
        const text = lineText.replace(/^#+\s*/, '').trim();
        if (text) {
          headings.push({ level, text, from: node.from });
        }
      }
    }
  });

  return headings;
}
