import { describe, it, expect } from 'vitest';
import { parser as baseParser } from '@lezer/markdown';
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
});
