import { describe, it, expect } from 'vitest';
import { parser as baseParser } from '@lezer/markdown';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { Highlight, Footnote, InlineMath, DisplayMath, FrontMatter } from '$lib/editor/markdown-extensions';
import type { Tree, SyntaxNodeRef } from '@lezer/common';

/**
 * [contract] markdown-extensions — our four custom Lezer markdown parsers.
 * We configure the parser with each extension and assert the resulting
 * node names appear in the parse tree for representative inputs.
 */

function parseWith(config: Parameters<typeof baseParser.configure>[0], doc: string): Tree {
  return baseParser.configure(config).parse(doc);
}

function collectNodeNames(tree: Tree, doc: string): string[] {
  const names: string[] = [];
  tree.cursor().iterate((node: SyntaxNodeRef) => {
    names.push(node.name);
    return true;
  });
  void doc;
  return names;
}

/** Parse through CodeMirror (DocInput, line chunks) — the editor's real path. */
function parseInEditor(doc: string): Tree {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ extensions: [DisplayMath, FrontMatter] })],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) throw new Error('parse did not finish');
  return tree;
}

function nodesNamed(tree: Tree, name: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === name) out.push({ from: node.from, to: node.to });
    },
  });
  return out;
}

describe('[contract] Highlight (==...==)', () => {
  it('emits Highlight nodes for ==text==', () => {
    const tree = parseWith([Highlight], 'hello ==world== end');
    expect(collectNodeNames(tree, 'hello ==world== end')).toContain('Highlight');
  });

  it('rejects a single = (not a highlight)', () => {
    const tree = parseWith([Highlight], 'a = b');
    expect(collectNodeNames(tree, 'a = b')).not.toContain('Highlight');
  });

  it('rejects ==== (four consecutive) — inner pair is guarded off', () => {
    // The extension guards against the third '=' after a '==' opener, so
    // `====` never produces a Highlight span on its own.
    const tree = parseWith([Highlight], '====');
    expect(collectNodeNames(tree, '====')).not.toContain('Highlight');
  });
});

describe('[contract] Footnote ([^id] and [^id]:)', () => {
  it('emits FootnoteReference for inline [^1]', () => {
    const tree = parseWith([Footnote], 'See [^1] here.');
    expect(collectNodeNames(tree, 'See [^1] here.')).toContain('FootnoteReference');
  });

  it('emits FootnoteDefinition for block-level [^1]: text', () => {
    const tree = parseWith([Footnote], '[^1]: definition\n');
    expect(collectNodeNames(tree, '[^1]: definition')).toContain('FootnoteDefinition');
  });

  it('rejects [^] with empty label', () => {
    const tree = parseWith([Footnote], 'bad [^] mark');
    expect(collectNodeNames(tree, 'bad [^] mark')).not.toContain('FootnoteReference');
  });

  it('rejects a label that contains a newline', () => {
    const tree = parseWith([Footnote], '[^lab\nel]');
    expect(collectNodeNames(tree, '[^lab\nel]')).not.toContain('FootnoteReference');
  });
});

describe('[contract] InlineMath ($...$)', () => {
  it('emits InlineMath for $x+1$', () => {
    const tree = parseWith([InlineMath], 'formula $x+1$ here');
    expect(collectNodeNames(tree, 'formula $x+1$ here')).toContain('InlineMath');
  });

  it('rejects $$ (display math)', () => {
    const tree = parseWith([InlineMath], 'a $$ b $$ c');
    expect(collectNodeNames(tree, 'a $$ b $$ c')).not.toContain('InlineMath');
  });

  it('rejects content starting with a space', () => {
    const tree = parseWith([InlineMath], 'a $ x$ b');
    expect(collectNodeNames(tree, 'a $ x$ b')).not.toContain('InlineMath');
  });

  it('rejects content with no closing $', () => {
    const tree = parseWith([InlineMath], 'a $unterminated');
    expect(collectNodeNames(tree, 'a $unterminated')).not.toContain('InlineMath');
  });
});

describe('[contract] DisplayMath ($$ ... $$)', () => {
  it('matches a block-level $$ ... $$', () => {
    const doc = '$$\nx = y + 1\n$$\n';
    const tree = parseWith([DisplayMath], doc);
    expect(collectNodeNames(tree, doc)).toContain('DisplayMath');
  });

  it('rejects $$ without a closing $$', () => {
    const doc = '$$\nno closer here\n';
    const tree = parseWith([DisplayMath], doc);
    expect(collectNodeNames(tree, doc)).not.toContain('DisplayMath');
  });

  it('ignores $$ that has trailing non-whitespace on the opener line', () => {
    const doc = '$$ inline stuff\nbody\n$$\n';
    const tree = parseWith([DisplayMath], doc);
    expect(collectNodeNames(tree, doc)).not.toContain('DisplayMath');
  });

  it('[regression] an unclosed $$ leaves the rest of the document parsed', () => {
    const doc = 'intro\n\n$$\nx = 1\n\n# Heading\n\n![img](a.png)\n';
    for (const tree of [parseWith([DisplayMath], doc), parseInEditor(doc)]) {
      expect(nodesNamed(tree, 'DisplayMath')).toEqual([]);
      const headings = nodesNamed(tree, 'ATXHeading1');
      expect(headings).toEqual([{ from: doc.indexOf('# Heading'), to: doc.indexOf('# Heading') + 9 }]);
      expect(nodesNamed(tree, 'Image')).toHaveLength(1);
    }
  });

  it('pairs an opener with the next $$ line', () => {
    const doc = '$$\n# Heading\n\n$$\nx\n$$\n';
    const tree = parseInEditor(doc);
    // First $$ pairs with the second; the trailing $$ is then unclosed text.
    expect(nodesNamed(tree, 'DisplayMath')).toEqual([{ from: 0, to: doc.indexOf('\nx') }]);
    expect(nodesNamed(tree, 'Paragraph').length).toBeGreaterThan(0);
  });

  it('parses display math inside a blockquote', () => {
    const doc = '> $$\n> x\n> $$\n\n# After\n';
    const tree = parseInEditor(doc);
    expect(nodesNamed(tree, 'DisplayMath')).toHaveLength(1);
    expect(nodesNamed(tree, 'ATXHeading1')).toHaveLength(1);
  });
});

describe('[contract] FrontMatter (--- ... ---)', () => {
  it('matches YAML front-matter at the document start', () => {
    const doc = '---\ntitle: Test\n---\n\n# Body\n';
    const tree = parseWith([FrontMatter], doc);
    expect(collectNodeNames(tree, doc)).toContain('FrontMatter');
  });

  it('rejects --- that is not at the document start', () => {
    const doc = '# heading\n\n---\ntitle: nope\n---\n';
    const tree = parseWith([FrontMatter], doc);
    expect(collectNodeNames(tree, doc)).not.toContain('FrontMatter');
  });

  it('rejects --- without a closing ---', () => {
    const doc = '---\nkey: value\nno closer\n';
    const tree = parseWith([FrontMatter], doc);
    expect(collectNodeNames(tree, doc)).not.toContain('FrontMatter');
  });

  it('[regression] a leading --- rule without a closer leaves the document parsed', () => {
    const doc = '---\n\n# Title\n\nbody text\n';
    for (const tree of [parseWith([FrontMatter], doc), parseInEditor(doc)]) {
      expect(nodesNamed(tree, 'FrontMatter')).toEqual([]);
      expect(nodesNamed(tree, 'HorizontalRule')).toEqual([{ from: 0, to: 3 }]);
      expect(nodesNamed(tree, 'ATXHeading1')).toHaveLength(1);
    }
  });
});
