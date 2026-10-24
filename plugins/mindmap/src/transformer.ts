import { Transformer } from 'markmap-lib';

/**
 * markmap-lib enables markdown-it's `html` option and markmap-view writes each
 * node's content with `innerHTML`. Document text is untrusted (shared, synced
 * or imported manuscripts), so raw HTML must stay text.
 */
export function createMindmapTransformer(): Transformer {
  const transformer = new Transformer();
  transformer.md.set({ html: false });
  return transformer;
}
