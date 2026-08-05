import { describe, expect, it } from 'vitest';
import type { ViteOutputBundle } from '../../../plugins/vite-single-file';
import { inlineViteAssets } from '../../../plugins/vite-single-file';

describe('literary plugin single-file build', () => {
  it('inlines relative JavaScript and CSS assets into the entry document', () => {
    const bundle = {
      'assets/index-test.js': {
        type: 'chunk',
        code: 'const $ = true; $&&document.body.focus(); window.__pluginMounted = true;',
      },
      'assets/index-test.css': {
        type: 'asset',
        source: 'body { color: black; }',
      },
    } satisfies ViteOutputBundle;
    const source = '<script type="module" crossorigin src="./assets/index-test.js"></script>'
      + '<link rel="stylesheet" crossorigin href="./assets/index-test.css">';

    const result = inlineViteAssets(source, bundle);

    expect(result.html).toContain(
      '<script type="module" crossorigin>const $ = true; $&&document.body.focus(); window.__pluginMounted = true;</script>',
    );
    expect(result.html).toContain('<style>body { color: black; }</style>');
    expect(result.html).not.toMatch(/(?:src|href)=["']\.\/assets\//);
    expect(result.inlinedFiles).toEqual(new Set([
      'assets/index-test.js',
      'assets/index-test.css',
    ]));
  });
});
